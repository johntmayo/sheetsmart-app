import type { Request, Response, Router } from 'express';
import type { Deps } from '../types';
import * as google from '../google';
import * as jobs from '../jobs';
import {
  canonicalizeHeaders,
  fingerprintDictionaryAliases,
  type DictionaryAliasSpec,
} from '../lib/columns';
import {
  fingerprintMapboxRoster,
  fingerprintSelectedContactAudit,
  planFolderMapboxContactAudit,
  summarizeContactAudit,
  type ContactAuditSheetPlan,
  type ContactAuditZoneDrift,
} from '../lib/mapboxContactAuditEngine';
import { filterGridByTombstones, loadActiveTombstones } from '../lib/tombstones';
import { type Grid } from '../lib/mergeEngine';
import {
  DEFAULT_MAPBOX_DATASET_ID,
  DEFAULT_MAPBOX_USERNAME,
  fetchZoneFeatures,
  isMapboxConfigured,
  type ZoneSourceConfig,
} from '../mapbox';
import { MAPBOX_CONTACT_AUDIT_TASK } from '../mapboxContactAuditTasks';

interface ConnectionRow {
  name: string;
  google_id: string;
  source_tab: string;
}

/**
 * Two different jobs share this engine, and they are kept apart on purpose:
 *  - 'captains' reconciles captain name/phone/email on the captain sheets, which
 *    is routine upkeep of a few hundred cells.
 *  - 'master' is the first-time population of ZoneName/NC columns on the master,
 *    which is tens of thousands of blank cells. Mixing the two made a one-off
 *    setup job look like routine drift.
 */
export type ContactAuditScope = 'captains' | 'master';

const SCOPE_WORKFLOW_NAMES: Record<ContactAuditScope, string> = {
  captains: 'Update captain contacts from Mapbox',
  master: 'Fill zone and captain columns on the master',
};

interface ContactAuditPreviewSummary {
  kind: 'mapbox_contact_audit_preview';
  scope: ContactAuditScope;
  masterSpreadsheetId: string;
  masterName: string;
  masterTab: string;
  folderId: string;
  generatedAt: string;
  dictionaryFingerprint: string;
  mapboxFingerprint: string;
  fingerprint: string;
  sheets: ContactAuditSheetPlan[];
  zoneDrift: ContactAuditZoneDrift[];
  readErrors: Array<{ spreadsheet: string; reason: string }>;
  impact: ReturnType<typeof summarizeContactAudit>;
  appliedRunId?: number;
}

// Captain upkeep is small by nature. The master backfill is inherently large, so
// it gets a higher ceiling and is applied over a few undoable batches.
const MAX_CONTACT_AUDIT_CELLS: Record<ContactAuditScope, number> = {
  captains: 5000,
  master: 20000,
};
const ZONE_SOURCE_KEY = 'zone_source_config';

function parseScope(value: unknown): ContactAuditScope {
  return String(value ?? '').trim() === 'master' ? 'master' : 'captains';
}

export default function registerMapboxContactAuditRoutes(api: Router, { db }: Deps): void {
  api.post('/mapbox-contact-audit/preview', async (req: Request, res: Response) => {
    if (!google.isConfigured()) return res.status(400).json({ error: 'Google is not configured.' });
    if (!isMapboxConfigured()) return res.status(400).json({ error: 'Mapbox is not configured.' });
    const master = db.get<ConnectionRow>("SELECT * FROM connections WHERE type='master' ORDER BY id LIMIT 1");
    const folder = db.get<ConnectionRow>(
      "SELECT * FROM connections WHERE type='captain_folder' ORDER BY id LIMIT 1"
    );
    if (!master || !folder) {
      return res.status(400).json({ error: 'Configure both the master and captain folder under Sources first.' });
    }

    const scope = parseScope(req.body?.scope);
    const insert = db.run(
      `INSERT INTO runs (workflow_name, type, mode, status, started_at)
       VALUES (?, 'preview_mapbox_contact_audit', 'dry', 'running', datetime('now'))`,
      [SCOPE_WORKFLOW_NAMES[scope]]
    );
    const runId = Number(insert.lastInsertRowid);
    try {
      const payload = await buildPreview(db, master, folder, scope);
      const summary: ContactAuditPreviewSummary = {
        kind: 'mapbox_contact_audit_preview',
        scope,
        ...payload,
        generatedAt: new Date().toISOString(),
      };
      db.run("UPDATE runs SET status='succeeded', finished_at=datetime('now'), summary_json=? WHERE id=?", [
        JSON.stringify(summary),
        runId,
      ]);
      res.json({
        runId,
        ...summary,
        canApply:
          (payload.impact.fills + payload.impact.overwrites > 0 ||
            payload.sheets.some((sheet) => sheet.columnsToAdd.length > 0)) &&
          payload.readErrors.length === 0,
      });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post('/mapbox-contact-audit/apply', (req: Request, res: Response) => {
    if (req.body?.confirmed !== true) {
      res.status(400).json({ error: 'Confirm before updating captain contacts from Mapbox.' });
      return;
    }
    const previewRunId = Number(req.body?.previewRunId);
    const spreadsheetIds = Array.isArray(req.body?.spreadsheetIds)
      ? (req.body.spreadsheetIds as unknown[]).map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (!Number.isInteger(previewRunId) || previewRunId <= 0) {
      res.status(400).json({ error: 'A valid preview is required.' });
      return;
    }
    if (spreadsheetIds.length === 0) {
      res.status(400).json({ error: 'Select at least one sheet.' });
      return;
    }

    const preview = db.get<{ type: string; mode: string; status: string; summary_json: string }>(
      'SELECT type, mode, status, summary_json FROM runs WHERE id=?',
      [previewRunId]
    );
    if (
      !preview ||
      preview.type !== 'preview_mapbox_contact_audit' ||
      preview.mode !== 'dry' ||
      preview.status !== 'succeeded'
    ) {
      res.status(400).json({ error: 'That preview is no longer available.' });
      return;
    }
    const plan = parsePreview(preview.summary_json);
    if (!plan) {
      res.status(400).json({ error: 'That preview does not contain a valid plan.' });
      return;
    }
    if (plan.readErrors.length > 0) {
      res.status(409).json({ error: 'Fix the sheet problems shown in the preview, then run a fresh scan.' });
      return;
    }
    const selectionError = validateSelection(plan, spreadsheetIds);
    if (selectionError) {
      res.status(400).json({ error: selectionError });
      return;
    }
    const appliedRunId = jobs.appliedRunForPreview(previewRunId) || plan.appliedRunId;
    if (appliedRunId) {
      res.status(409).json({ error: `That preview was already used for live run #${appliedRunId}.` });
      return;
    }
    if (spreadsheetIds.some((id) => !plan.sheets.some((sheet) => sheet.spreadsheetId === id))) {
      res.status(400).json({ error: 'One or more selected sheets were not in this preview.' });
      return;
    }

    const selectedSet = new Set(spreadsheetIds);
    const expectedFingerprint = fingerprintSelectedContactAudit(plan.sheets, spreadsheetIds);
    let queued: { runId: number; jobId: number };
    try {
      queued = jobs.enqueueFromPreview(previewRunId, 'preview_mapbox_contact_audit', {
        workflowName: SCOPE_WORKFLOW_NAMES[plan.scope],
        type: MAPBOX_CONTACT_AUDIT_TASK,
        mode: 'live',
        params: {
          previewRunId,
          masterSpreadsheetId: plan.masterSpreadsheetId,
          masterName: plan.masterName,
          masterTab: plan.masterTab,
          folderId: plan.folderId,
          spreadsheetIds,
          expectedFingerprint,
          dictionaryFingerprint: plan.dictionaryFingerprint,
          mapboxFingerprint: plan.mapboxFingerprint,
          sheets: plan.sheets.filter((sheet) => selectedSet.has(sheet.spreadsheetId)),
        },
      });
    } catch (error) {
      if (error instanceof jobs.PreviewAlreadyClaimedError) {
        res.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof jobs.PreviewUnavailableError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
    plan.appliedRunId = queued.runId;
    db.run('UPDATE runs SET summary_json=? WHERE id=?', [JSON.stringify(plan), previewRunId]);
    res.status(202).json({ ...queued, status: 'queued' });
  });
}

async function buildPreview(
  db: Deps['db'],
  master: ConnectionRow,
  folder: ConnectionRow,
  scope: ContactAuditScope
): Promise<Omit<ContactAuditPreviewSummary, 'kind' | 'generatedAt' | 'scope'>> {
  const masterMeta = await google.getSpreadsheetMeta(master.google_id);
  const masterTab = master.source_tab || masterMeta.tabs[0] || '';
  if (!masterTab) throw new Error('The master spreadsheet has no readable tab.');
  const dictionary = loadDictionaryAliases(db);
  const dictionaryFingerprint = fingerprintDictionaryAliases(dictionary);
  const tombstones = loadActiveTombstones(db);
  const masterGridRaw = (await google.readValues(
    master.google_id,
    google.a1Range(masterTab, 'A:ZZ')
  )) as Grid;
  const masterHeaderResult = canonicalizeHeaders(masterGridRaw[0] || [], dictionary);
  if (masterHeaderResult.errors.length > 0) {
    throw new Error(`Master columns are ambiguous: ${masterHeaderResult.errors.join(' ')}`);
  }
  const masterGrid = filterGridByTombstones(
    [masterHeaderResult.headers, ...masterGridRaw.slice(1)] as Grid,
    tombstones
  );
  const features = await fetchZoneFeatures(loadZoneSource(db));
  // The master scope never needs the captain folder, so skip listing and reading
  // ~124 spreadsheets for it.
  const { captainSheets, readErrors } =
    scope === 'master'
      ? { captainSheets: [], readErrors: [] as Array<{ spreadsheet: string; reason: string }> }
      : await readCaptainSheets(folder.google_id, master.google_id, dictionary, tombstones);
  const masterSheet = {
    spreadsheetId: master.google_id,
    spreadsheetName: master.name,
    tabName: masterTab,
    url: '',
    kind: 'master' as const,
    grid: masterGrid,
  };
  const folderPlan = planFolderMapboxContactAudit(
    masterGrid,
    scope === 'master' ? [masterSheet] : captainSheets,
    features
  );
  return {
    masterSpreadsheetId: master.google_id,
    masterName: master.name,
    masterTab,
    folderId: folder.google_id,
    dictionaryFingerprint,
    mapboxFingerprint: fingerprintMapboxRoster(features),
    fingerprint: folderPlan.fingerprint,
    sheets: folderPlan.sheets,
    zoneDrift: folderPlan.zoneDrift,
    readErrors,
    impact: summarizeContactAudit(folderPlan, {
      sheetsScanned: scope === 'master' ? 1 : captainSheets.length,
      readErrors: readErrors.length,
      scope,
    }),
  };
}

function validateSelection(summary: ContactAuditPreviewSummary, spreadsheetIds: string[]): string | null {
  const selected = summary.sheets.filter((sheet) => spreadsheetIds.includes(sheet.spreadsheetId));
  const cells = selected.reduce((sum, sheet) => sum + sheet.fills + sheet.overwrites, 0);
  const columns = selected.reduce((sum, sheet) => sum + sheet.columnsToAdd.length, 0);
  if (cells === 0 && columns === 0) {
    return 'The selected sheets have no captain-contact updates from Mapbox.';
  }
  const cap = MAX_CONTACT_AUDIT_CELLS[summary.scope === 'master' ? 'master' : 'captains'];
  if (cells > cap) {
    return `Select at most ${cap.toLocaleString()} cell updates per run (${cells.toLocaleString()} selected). Apply in batches; each batch is undoable and a fresh scan shows what is left.`;
  }
  return null;
}

async function readCaptainSheets(
  folderId: string,
  masterSpreadsheetId: string,
  dictionary: DictionaryAliasSpec[],
  tombstones: ReturnType<typeof loadActiveTombstones>
): Promise<{
  captainSheets: Array<{
    spreadsheetId: string;
    spreadsheetName: string;
    tabName: string;
    url: string;
    kind: 'captain';
    grid: Grid;
  }>;
  readErrors: Array<{ spreadsheet: string; reason: string }>;
}> {
  const files = await google.listSpreadsheetsInFolder(folderId);
  const captainSheets: Array<{
    spreadsheetId: string;
    spreadsheetName: string;
    tabName: string;
    url: string;
    kind: 'captain';
    grid: Grid;
  }> = [];
  const readErrors: Array<{ spreadsheet: string; reason: string }> = [];
  await mapLimit(files, 10, async (file) => {
    if (file.id === masterSpreadsheetId) return;
    try {
      const grid = (await google.readValues(file.id, 'A:ZZ')) as Grid;
      const headerResult = canonicalizeHeaders(grid[0] || [], dictionary);
      if (headerResult.errors.length > 0) throw new Error(headerResult.errors.join(' '));
      captainSheets.push({
        spreadsheetId: file.id,
        spreadsheetName: file.name,
        tabName: '',
        url: file.webViewLink || '',
        kind: 'captain',
        grid: filterGridByTombstones([headerResult.headers, ...grid.slice(1)] as Grid, tombstones),
      });
    } catch (error) {
      readErrors.push({
        spreadsheet: file.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });
  captainSheets.sort(
    (left, right) =>
      left.spreadsheetId.localeCompare(right.spreadsheetId) ||
      left.spreadsheetName.localeCompare(right.spreadsheetName)
  );
  return { captainSheets, readErrors };
}

function parsePreview(json: string): ContactAuditPreviewSummary | null {
  try {
    const value = JSON.parse(json) as Partial<ContactAuditPreviewSummary>;
    if (value.kind !== 'mapbox_contact_audit_preview' || !Array.isArray(value.sheets)) return null;
    return { ...value, scope: parseScope(value.scope) } as ContactAuditPreviewSummary;
  } catch {
    return null;
  }
}

function loadZoneSource(db: Deps['db']): ZoneSourceConfig {
  const raw = db.getSetting(ZONE_SOURCE_KEY, '');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ZoneSourceConfig>;
      return {
        username: (parsed.username || DEFAULT_MAPBOX_USERNAME).trim(),
        datasetId: (parsed.datasetId || DEFAULT_MAPBOX_DATASET_ID).trim(),
      };
    } catch {
      /* defaults */
    }
  }
  return { username: DEFAULT_MAPBOX_USERNAME, datasetId: DEFAULT_MAPBOX_DATASET_ID };
}

function loadDictionaryAliases(db: Deps['db']): DictionaryAliasSpec[] {
  return db
    .all<{ id: number; canonical_name: string }>(
      'SELECT id, canonical_name FROM dictionary_fields ORDER BY sort_order, id'
    )
    .map((field) => ({
      canonicalName: field.canonical_name,
      aliases: db
        .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id=? ORDER BY alias', [field.id])
        .map((row) => row.alias),
    }));
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

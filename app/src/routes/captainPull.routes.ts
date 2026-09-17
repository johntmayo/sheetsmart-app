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
  fingerprintPullFolderSheets,
  fingerprintSelectedPullFolder,
  planFolderPullToMaster,
  type PullFolderSheetPlan,
} from '../lib/captainPullEngine';
import { summarizePullToMaster } from '../lib/previewEngine';
import { filterGridByTombstones, loadActiveTombstones } from '../lib/tombstones';
import { trimHeaders, type Grid } from '../lib/mergeEngine';
import { pullFieldMetaForHeaders, pullPoliciesForLiveFolderPull } from '../executionTasks';
import { PULL_FOLDER_TASK } from '../captainPullTasks';

interface ConnectionRow {
  name: string;
  google_id: string;
  source_tab: string;
}

interface PullFolderPreviewSummary {
  kind: 'pull_folder_preview';
  masterSpreadsheetId: string;
  masterName: string;
  masterTab: string;
  folderId: string;
  generatedAt: string;
  dictionaryFingerprint: string;
  fingerprint: string;
  sheets: PullFolderSheetPlan[];
  readErrors: Array<{ spreadsheet: string; reason: string }>;
  impact: ReturnType<typeof summarizePullToMaster>;
  appliedRunId?: number;
}

const MAX_PULL_FOLDER_CELLS = 5000;

export default function registerCaptainPullRoutes(api: Router, { db }: Deps): void {
  api.post('/captain-pull/preview', async (_req: Request, res: Response) => {
    if (!google.isConfigured()) return res.status(400).json({ error: 'Google is not configured.' });
    const master = db.get<ConnectionRow>("SELECT * FROM connections WHERE type='master' ORDER BY id LIMIT 1");
    const folder = db.get<ConnectionRow>(
      "SELECT * FROM connections WHERE type='captain_folder' ORDER BY id LIMIT 1"
    );
    if (!master || !folder) {
      return res.status(400).json({ error: 'Configure both the master and captain folder under Sources first.' });
    }

    const insert = db.run(
      `INSERT INTO runs (workflow_name, type, mode, status, started_at)
       VALUES ('Pull captain edits into the master', 'preview_pull_folder', 'dry', 'running', datetime('now'))`
    );
    const runId = Number(insert.lastInsertRowid);
    try {
      const payload = await buildPullFolderPreview(db, master, folder);
      const summary: PullFolderPreviewSummary = {
        kind: 'pull_folder_preview',
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
          (payload.impact.fills + payload.impact.overwrites > 0 || payload.impact.conflicts > 0) &&
          payload.readErrors.length === 0,
      });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post('/captain-pull/apply', (req: Request, res: Response) => {
    if (req.body?.confirmed !== true) {
      res.status(400).json({ error: 'Confirm before updating the master sheet.' });
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
      res.status(400).json({ error: 'Select at least one captain sheet.' });
      return;
    }

    const preview = db.get<{ type: string; mode: string; status: string; summary_json: string }>(
      'SELECT type, mode, status, summary_json FROM runs WHERE id=?',
      [previewRunId]
    );
    if (
      !preview ||
      preview.type !== 'preview_pull_folder' ||
      preview.mode !== 'dry' ||
      preview.status !== 'succeeded'
    ) {
      res.status(400).json({ error: 'That preview is no longer available.' });
      return;
    }
    const plan = parsePullFolderPreview(preview.summary_json);
    if (!plan) {
      res.status(400).json({ error: 'That preview does not contain a valid plan.' });
      return;
    }
    if (plan.readErrors.length > 0) {
      res.status(409).json({ error: 'Fix the sheet problems shown in the preview, then run a fresh scan.' });
      return;
    }
    const selectionError = validatePullFolderSelection(plan, spreadsheetIds);
    if (selectionError) {
      res.status(400).json({ error: selectionError });
      return;
    }
    const appliedRunId = jobs.appliedRunForPreview(previewRunId) || plan.appliedRunId;
    if (appliedRunId) {
      res.status(409).json({ error: `That preview was already used for live run #${appliedRunId}.` });
      return;
    }

    const selectedSet = new Set(spreadsheetIds);
    const unknown = spreadsheetIds.filter(
      (id) => !plan.sheets.some((sheet) => sheet.spreadsheetId === id)
    );
    if (unknown.length > 0) {
      res.status(400).json({ error: 'One or more selected captain sheets were not in this preview.' });
      return;
    }

    const expectedFingerprint = fingerprintSelectedPullFolder(plan.sheets, spreadsheetIds);

    let queued: { runId: number; jobId: number };
    try {
      queued = jobs.enqueueFromPreview(previewRunId, 'preview_pull_folder', {
        workflowName: 'Pull captain edits into the master',
        type: PULL_FOLDER_TASK,
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

async function buildPullFolderPreview(
  db: Deps['db'],
  master: ConnectionRow,
  folder: ConnectionRow
): Promise<Omit<PullFolderPreviewSummary, 'kind' | 'generatedAt'>> {
  const masterMeta = await google.getSpreadsheetMeta(master.google_id);
  const masterTab = master.source_tab || masterMeta.tabs[0] || '';
  if (!masterTab) throw new Error('The master spreadsheet has no readable tab.');
  const dictionary = loadDictionaryAliases(db);
  const dictionaryFingerprint = fingerprintDictionaryAliases(dictionary);
  const tombstones = loadActiveTombstones(db);
  const masterGrid = (await google.readValues(
    master.google_id,
    google.a1Range(masterTab, 'A:ZZ')
  )) as Grid;
  const masterHeaderResult = canonicalizeHeaders(masterGrid[0] || [], dictionary);
  if (masterHeaderResult.errors.length > 0) {
    throw new Error(`Master columns are ambiguous: ${masterHeaderResult.errors.join(' ')}`);
  }
  const canonicalMaster = filterGridByTombstones(
    [masterHeaderResult.headers, ...masterGrid.slice(1)] as Grid,
    tombstones
  );
  const masterHeaders = trimHeaders(canonicalMaster[0]);
  const policies = pullPoliciesForLiveFolderPull(masterHeaders);
  const fieldMeta = pullFieldMetaForHeaders(masterHeaders);
  const { captainSheets, readErrors } = await readCaptainSheets(folder.google_id, dictionary, tombstones);
  const folderPlan = planFolderPullToMaster(canonicalMaster, captainSheets, { policies, fieldMeta });
  const impactBase = summarizePullToMaster(folderPlan.sheets, {
    sheetsScanned: captainSheets.length,
    readErrors: readErrors.length,
  });
  return {
    masterSpreadsheetId: master.google_id,
    masterName: master.name,
    masterTab,
    folderId: folder.google_id,
    dictionaryFingerprint,
    fingerprint: fingerprintPullFolderSheets(folderPlan.sheets),
    sheets: folderPlan.sheets,
    readErrors,
    impact: {
      ...impactBase,
      fills: folderPlan.fills.length,
      overwrites: folderPlan.overwrites.length,
      conflicts: folderPlan.conflicts.length,
      unmatchedResidents: folderPlan.unmatchedResidents.length,
      sheetsWithWrites: folderPlan.sheets.filter((sheet) => sheet.fills + sheet.overwrites > 0).length,
    },
  };
}

function validatePullFolderSelection(summary: PullFolderPreviewSummary, spreadsheetIds: string[]): string | null {
  const selected = summary.sheets.filter((sheet) => spreadsheetIds.includes(sheet.spreadsheetId));
  const cells = selected.reduce((sum, sheet) => sum + sheet.fills + sheet.overwrites, 0);
  const conflicts = selected.reduce((sum, sheet) => sum + sheet.conflicts, 0);
  if (cells === 0 && conflicts === 0 && summary.impact.conflicts === 0) {
    return 'The selected captain sheets have no edits to bring into the master.';
  }
  if (cells > MAX_PULL_FOLDER_CELLS) {
    return `Select at most ${MAX_PULL_FOLDER_CELLS.toLocaleString()} cell updates per run (${cells.toLocaleString()} selected).`;
  }
  return null;
}

async function readCaptainSheets(
  folderId: string,
  dictionary: DictionaryAliasSpec[],
  tombstones: ReturnType<typeof loadActiveTombstones>
): Promise<{
  captainSheets: Array<{
    spreadsheetId: string;
    spreadsheetName: string;
    tabName: string;
    url: string;
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
    grid: Grid;
  }> = [];
  const readErrors: Array<{ spreadsheet: string; reason: string }> = [];
  await mapLimit(files, 10, async (file) => {
    try {
      const grid = (await google.readValues(file.id, 'A:ZZ')) as Grid;
      const headerResult = canonicalizeHeaders(grid[0] || [], dictionary);
      if (headerResult.errors.length > 0) throw new Error(headerResult.errors.join(' '));
      captainSheets.push({
        spreadsheetId: file.id,
        spreadsheetName: file.name,
        tabName: '',
        url: file.webViewLink || '',
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

function parsePullFolderPreview(json: string): PullFolderPreviewSummary | null {
  try {
    const value = JSON.parse(json) as Partial<PullFolderPreviewSummary>;
    if (value.kind !== 'pull_folder_preview' || !Array.isArray(value.sheets)) return null;
    return value as PullFolderPreviewSummary;
  } catch {
    return null;
  }
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

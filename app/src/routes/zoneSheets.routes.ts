import type { Request, Response, Router } from 'express';
import type { Deps } from '../types';
import * as google from '../google';
import * as jobs from '../jobs';
import { detectSheetZoneWithName, findColumn } from '../lib/columns';
import { trimHeaders, type Grid } from '../lib/mergeEngine';
import { filterGridByTombstones, loadActiveTombstones } from '../lib/tombstones';
import type { CaptainSheetInput, ZoneReconcileConfig } from '../lib/zoneEngine';
import {
  fingerprintMissingZoneSheets,
  planMissingZoneSheets,
  type MissingZoneSheet,
} from '../lib/zoneSheetEngine';
import { CREATE_ZONE_SHEETS_TASK } from '../executionTasks';
import {
  DEFAULT_MAPBOX_DATASET_ID,
  DEFAULT_MAPBOX_USERNAME,
  fetchZoneFeatures,
  isMapboxConfigured,
} from '../mapbox';

const ZONE_SOURCE_KEY = 'zone_source_config';

interface ConnectionRow {
  name: string;
  google_id: string;
  source_tab: string;
}

interface StoredPreview {
  kind: 'create_zone_sheets_preview';
  masterSpreadsheetId: string;
  masterName: string;
  masterTab: string;
  folderId: string;
  templateSpreadsheetId: string;
  templateSpreadsheetName: string;
  zones: MissingZoneSheet[];
  appliedRunId?: number;
  [key: string]: unknown;
}

export default function registerZoneSheetRoutes(api: Router, { db }: Deps): void {
  api.post('/zone-sheets/preview', async (_req: Request, res: Response) => {
    if (!google.isConfigured()) return res.status(400).json({ error: 'Google is not configured.' });
    if (!isMapboxConfigured()) return res.status(400).json({ error: 'Mapbox is not configured.' });
    const master = db.get<ConnectionRow>("SELECT * FROM connections WHERE type='master' ORDER BY id LIMIT 1");
    const folder = db.get<ConnectionRow>(
      "SELECT * FROM connections WHERE type='captain_folder' ORDER BY id LIMIT 1"
    );
    if (!master || !folder) {
      return res.status(400).json({ error: 'Configure both the master and captain folder under Sources first.' });
    }

    const insert = db.run(
      `INSERT INTO runs (workflow_name, type, mode, status, started_at)
       VALUES ('Find missing captain-zone sheets', 'preview_create_zone_sheets', 'dry', 'running', datetime('now'))`
    );
    const runId = Number(insert.lastInsertRowid);
    try {
      const meta = await google.getSpreadsheetMeta(master.google_id);
      const masterTab = master.source_tab || meta.tabs[0] || '';
      if (!masterTab) throw new Error('The master spreadsheet has no readable tab.');
      const masterGrid = (await google.readValues(
        master.google_id,
        google.a1Range(masterTab, 'A:ZZ')
      )) as Grid;
      const files = await google.listSpreadsheetsInFolder(folder.google_id);
      const captainSheets: CaptainSheetInput[] = [];
      const readErrors: Array<{ spreadsheet: string; reason: string }> = [];
      await mapLimit(files, 10, async (file) => {
        try {
          const grid = (await google.readValues(file.id, 'A:ZZ')) as Grid;
          captainSheets.push({
            spreadsheetId: file.id,
            spreadsheetName: file.name,
            tabName: '',
            zone: detectSheetZoneWithName(trimHeaders(grid[0]), grid.slice(1), file.name),
            grid,
          });
        } catch (error) {
          readErrors.push({
            spreadsheet: file.name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      });
      const template = chooseTemplate(masterGrid, captainSheets);
      if (!template) throw new Error('No readable existing captain sheet is available as a formatting template.');
      const features = await fetchZoneFeatures(loadZoneSource(db));
      const plan = planMissingZoneSheets(
        filterGridByTombstones(masterGrid, loadActiveTombstones(db)),
        captainSheets,
        features,
        zoneConfig(db, trimHeaders(masterGrid[0]))
      );
      const summary: StoredPreview = {
        kind: 'create_zone_sheets_preview',
        masterSpreadsheetId: master.google_id,
        masterName: master.name,
        masterTab,
        folderId: folder.google_id,
        templateSpreadsheetId: template.spreadsheetId,
        templateSpreadsheetName: template.spreadsheetName,
        zones: plan.zones,
        blocked: plan.blocked,
        errors: plan.errors,
        readErrors,
        generatedAt: new Date().toISOString(),
        fingerprint: plan.fingerprint,
        impact: {
          zones: plan.zones.length,
          addresses: plan.zones.reduce((sum, zone) => sum + zone.addresses.length, 0),
          residents: plan.zones.reduce((sum, zone) => sum + zone.residents.length, 0),
          sheetsScanned: captainSheets.length,
          readErrors: readErrors.length,
        },
      };
      db.run("UPDATE runs SET status='succeeded', finished_at=datetime('now'), summary_json=? WHERE id=?", [
        JSON.stringify(summary),
        runId,
      ]);
      res.json({
        runId,
        ...summary,
        canApply: plan.zones.length > 0 && plan.errors.length === 0 && readErrors.length === 0,
      });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post('/zone-sheets/apply', (req: Request, res: Response) => {
    const previewRunId = Number(req.body?.previewRunId);
    const zoneNames = Array.isArray(req.body?.zones)
      ? (req.body.zones as unknown[]).map((zone) => String(zone).trim()).filter(Boolean)
      : [];
    if (!Number.isInteger(previewRunId) || previewRunId <= 0) {
      return res.status(400).json({ error: 'A valid preview is required.' });
    }
    if (req.body?.confirmation !== 'CREATE') {
      return res.status(400).json({ error: 'Type CREATE to confirm creation of these captain spreadsheets.' });
    }
    if (zoneNames.length === 0 || zoneNames.length > 25) {
      return res.status(400).json({ error: 'Select between 1 and 25 zones for one creation run.' });
    }
    const preview = db.get<{ type: string; mode: string; status: string; summary_json: string }>(
      'SELECT type, mode, status, summary_json FROM runs WHERE id=?',
      [previewRunId]
    );
    if (
      !preview ||
      preview.type !== 'preview_create_zone_sheets' ||
      preview.mode !== 'dry' ||
      preview.status !== 'succeeded'
    ) {
      return res.status(400).json({ error: 'That missing-zone-sheet preview is not available.' });
    }
    const plan = parsePreview(preview.summary_json);
    if (!plan) return res.status(400).json({ error: 'That preview does not contain a valid plan.' });
    if (
      (Array.isArray(plan.errors) && plan.errors.length > 0) ||
      (Array.isArray(plan.readErrors) && plan.readErrors.length > 0)
    ) {
      return res.status(409).json({ error: 'Fix the sheet problems shown in the preview, then run a fresh scan.' });
    }
    const appliedRunId = jobs.appliedRunForPreview(previewRunId) || plan.appliedRunId;
    if (appliedRunId) {
      return res.status(409).json({ error: `That preview was already used for live run #${appliedRunId}.` });
    }
    const wanted = new Set(zoneNames);
    const selected = plan.zones.filter((zone) => wanted.has(zone.zone));
    if (selected.length !== wanted.size) {
      return res.status(400).json({ error: 'One or more selected zones were not in this preview.' });
    }
    let queued: { runId: number; jobId: number };
    try {
      queued = jobs.enqueueFromPreview(previewRunId, 'preview_create_zone_sheets', {
        workflowName: 'Create approved captain-zone sheets',
        type: CREATE_ZONE_SHEETS_TASK,
        mode: 'live',
        params: {
          previewRunId,
          masterSpreadsheetId: plan.masterSpreadsheetId,
          masterName: plan.masterName,
          masterTab: plan.masterTab,
          folderId: plan.folderId,
          templateSpreadsheetId: plan.templateSpreadsheetId,
          templateSpreadsheetName: plan.templateSpreadsheetName,
          zones: zoneNames,
          fingerprint: fingerprintMissingZoneSheets(selected),
        },
      });
    } catch (error) {
      if (error instanceof jobs.PreviewAlreadyClaimedError) {
        return res.status(409).json({ error: error.message });
      }
      if (error instanceof jobs.PreviewUnavailableError) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
    plan.appliedRunId = queued.runId;
    db.run('UPDATE runs SET summary_json=? WHERE id=?', [JSON.stringify(plan), previewRunId]);
    res.status(202).json({ ...queued, status: 'queued' });
  });
}

function chooseTemplate(masterGrid: Grid, sheets: CaptainSheetInput[]): CaptainSheetInput | null {
  const masterHeaders = new Set(trimHeaders(masterGrid[0]).filter(Boolean));
  return (
    [...sheets]
      .filter((sheet) => sheet.zone && sheet.grid.length > 0)
      .sort((a, b) => {
        const score = (sheet: CaptainSheetInput) =>
          trimHeaders(sheet.grid[0]).filter((header) => masterHeaders.has(header)).length;
        return score(b) - score(a) || a.spreadsheetName.localeCompare(b.spreadsheetName);
      })[0] || null
  );
}

function zoneConfig(db: Deps['db'], masterHeaders: string[]): ZoneReconcileConfig {
  const resolve = (canonical: string): string | null => {
    const field = db.get<{ id: number }>('SELECT id FROM dictionary_fields WHERE canonical_name=?', [canonical]);
    const aliases = field
      ? db
          .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id=?', [field.id])
          .map((row) => row.alias)
      : [];
    return findColumn(masterHeaders, [canonical, ...aliases]);
  };
  return {
    latHeader: resolve('Latitude'),
    lonHeader: resolve('Longitude'),
    zoneHeader: resolve('ZoneName'),
    ncNameHeader: resolve('NC Name'),
    ncPhoneHeader: resolve('NC Phone'),
    ncEmailHeader: resolve('NC Email'),
    identityHeader: resolve('resident_id'),
    nameHeader: resolve('Resident Name'),
  };
}

function loadZoneSource(db: Deps['db']): { username: string; datasetId: string } {
  const raw = db.getSetting(ZONE_SOURCE_KEY, '');
  if (raw) {
    try {
      const value = JSON.parse(raw) as { username?: string; datasetId?: string };
      return {
        username: String(value.username || DEFAULT_MAPBOX_USERNAME).trim(),
        datasetId: String(value.datasetId || DEFAULT_MAPBOX_DATASET_ID).trim(),
      };
    } catch {
      // Fall back to configured defaults.
    }
  }
  return { username: DEFAULT_MAPBOX_USERNAME, datasetId: DEFAULT_MAPBOX_DATASET_ID };
}

function parsePreview(json: string): StoredPreview | null {
  try {
    const value = JSON.parse(json) as StoredPreview;
    return value.kind === 'create_zone_sheets_preview' &&
      value.masterSpreadsheetId &&
      value.masterTab &&
      value.folderId &&
      value.templateSpreadsheetId &&
      Array.isArray(value.zones)
      ? value
      : null;
  } catch {
    return null;
  }
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await worker(items[cursor++]);
  });
  await Promise.all(runners);
}

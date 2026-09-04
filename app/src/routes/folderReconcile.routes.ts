import type { Request, Response, Router } from 'express';
import type { Deps } from '../types';
import * as google from '../google';
import * as jobs from '../jobs';
import { detectSheetZoneWithName, findColumn } from '../lib/columns';
import { filterGridByTombstones, loadActiveTombstones } from '../lib/tombstones';
import {
  fingerprintFolderZoneMoves,
  planFolderZoneReconciliation,
  type CaptainSheetInput,
  type Grid,
  type ZoneReconcileConfig,
} from '../lib/zoneEngine';
import { FOLDER_ZONE_RECONCILE_TASK } from '../executionTasks';
import {
  DEFAULT_MAPBOX_DATASET_ID,
  DEFAULT_MAPBOX_USERNAME,
  fetchZoneFeatures,
  isMapboxConfigured,
} from '../mapbox';

const ZONE_SOURCE_KEY = 'zone_source_config';

interface ConnectionRow {
  id: number;
  name: string;
  type: string;
  google_id: string;
  source_tab: string;
}

export default function registerFolderReconcileRoutes(api: Router, { db }: Deps): void {
  api.post('/folder-reconcile/preview', async (_req: Request, res: Response) => {
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
       VALUES ('Reconcile Mapbox boundaries', 'preview_folder_zone_reconcile', 'dry', 'running', datetime('now'))`
    );
    const runId = Number(insert.lastInsertRowid);
    try {
      const masterMeta = await google.getSpreadsheetMeta(master.google_id);
      const masterTab = master.source_tab || masterMeta.tabs[0] || '';
      if (!masterTab) throw new Error('The master spreadsheet has no readable tab.');
      const masterGrid = (await google.readValues(master.google_id, google.a1Range(masterTab, 'A:ZZ'))) as Grid;
      const files = await google.listSpreadsheetsInFolder(folder.google_id);
      const captainSheets: CaptainSheetInput[] = [];
      const readErrors: Array<{ spreadsheet: string; reason: string }> = [];

      await mapLimit(files, 5, async (file) => {
        try {
          // A:ZZ without a tab targets the first tab. Avoid a separate metadata
          // request for every sheet; explicit tab names are resolved only for
          // the comparatively small set selected for live reconciliation.
          const grid = (await google.readValues(file.id, 'A:ZZ')) as Grid;
          captainSheets.push({
            spreadsheetId: file.id,
            spreadsheetName: file.name,
            tabName: '',
            zone: detectSheetZoneWithName((grid[0] || []).map(String), grid.slice(1), file.name),
            grid,
          });
        } catch (error) {
          readErrors.push({
            spreadsheet: file.name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      });

      const features = await fetchZoneFeatures(loadZoneSource(db));
      const masterHeaders = (masterGrid[0] || []).map((value) => String(value ?? '').trim());
      const resolve = (canonical: string): string | null => {
        const field = db.get<{ id: number }>('SELECT id FROM dictionary_fields WHERE canonical_name=?', [canonical]);
        const aliases = field
          ? db
              .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id=?', [field.id])
              .map((row) => row.alias)
          : [];
        return findColumn(masterHeaders, [canonical, ...aliases]);
      };
      const cfg: ZoneReconcileConfig = {
        latHeader: resolve('Latitude'),
        lonHeader: resolve('Longitude'),
        zoneHeader: resolve('ZoneName'),
        ncNameHeader: resolve('NC Name'),
        ncPhoneHeader: resolve('NC Phone'),
        ncEmailHeader: resolve('NC Email'),
        identityHeader: resolve('resident_id'),
        nameHeader: resolve('Resident Name'),
      };
      const tombstones = loadActiveTombstones(db);
      const filteredMaster = filterGridByTombstones(masterGrid, tombstones, {
        residentHeader: cfg.identityHeader,
        addressHeader: resolve('address_id'),
      });
      const filteredCaptainSheets = captainSheets.map((sheet) => ({
        ...sheet,
        grid: filterGridByTombstones(sheet.grid, tombstones),
      }));
      const sensitiveFields = db
        .all<{ id: number; canonical_name: string }>(
          'SELECT id, canonical_name FROM dictionary_fields WHERE is_sensitive=1 ORDER BY sort_order'
        )
        // Destination captain-contact fields are replaced from Mapbox during
        // every move; they are not resident case data requiring transfer review.
        .filter((field) => !['NC Name', 'NC Phone', 'NC Email', 'ZoneName'].includes(field.canonical_name))
        .map((field) => ({
          canonicalName: field.canonical_name,
          aliases: db
            .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id=? ORDER BY alias', [field.id])
            .map((row) => row.alias),
        }));
      const plan = planFolderZoneReconciliation(filteredMaster, filteredCaptainSheets, features, cfg, {
        sensitiveFields,
      });
      const residentCount = plan.moves.reduce((sum, move) => sum + move.residents.length, 0);
      const summary = {
        kind: 'folder_zone_reconcile_preview',
        masterSpreadsheetId: master.google_id,
        masterName: master.name,
        masterTab,
        folderId: folder.google_id,
        generatedAt: new Date().toISOString(),
        fingerprint: plan.fingerprint,
        moves: plan.moves,
        blocked: plan.blocked,
        registryErrors: plan.registryErrors,
        readErrors,
        unchangedAddresses: plan.unchangedAddresses,
        unassignedAddresses: plan.unassignedAddresses,
        impact: {
          addressesToMove: plan.moves.length,
          residentsToMove: residentCount,
          blockedAddresses: plan.blocked.length,
          sheetsScanned: captainSheets.length,
          readErrors: readErrors.length,
        },
      };
      db.run("UPDATE runs SET status='succeeded', finished_at=datetime('now'), summary_json=? WHERE id=?", [
        JSON.stringify(summary),
        runId,
      ]);
      res.json({ runId, ...summary, canApply: plan.moves.length > 0 && plan.registryErrors.length === 0 && readErrors.length === 0 });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post('/folder-reconcile/apply', (req: Request, res: Response) => {
    const previewRunId = Number(req.body?.previewRunId);
    const addressIds = Array.isArray(req.body?.addressIds)
      ? (req.body.addressIds as unknown[]).map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (!Number.isInteger(previewRunId) || previewRunId <= 0) {
      return res.status(400).json({ error: 'A valid preview is required.' });
    }
    if (req.body?.confirmation !== 'APPLY') {
      return res.status(400).json({ error: 'Type APPLY to confirm these approved real-sheet changes.' });
    }
    if (addressIds.length === 0 || addressIds.length > 500) {
      return res.status(400).json({ error: 'Select between 1 and 500 addresses for one reconciliation run.' });
    }
    const preview = db.get<{ type: string; mode: string; status: string; summary_json: string }>(
      'SELECT type, mode, status, summary_json FROM runs WHERE id=?',
      [previewRunId]
    );
    if (!preview || preview.type !== 'preview_folder_zone_reconcile' || preview.mode !== 'dry' || preview.status !== 'succeeded') {
      return res.status(400).json({ error: 'That folder reconciliation preview is not available.' });
    }
    const plan = parsePreview(preview.summary_json);
    if (!plan) return res.status(400).json({ error: 'That preview does not contain a valid plan.' });
    if (
      (Array.isArray(plan.registryErrors) && plan.registryErrors.length > 0) ||
      (Array.isArray(plan.readErrors) && plan.readErrors.length > 0)
    ) {
      return res.status(409).json({ error: 'Fix the sheet problems shown in the preview, then run a fresh scan.' });
    }
    const appliedRunId = jobs.appliedRunForPreview(previewRunId) || plan.appliedRunId;
    if (appliedRunId) {
      return res.status(409).json({ error: `That preview was already used for live run #${appliedRunId}.` });
    }
    const selectedSet = new Set(addressIds);
    const selected = plan.moves.filter((move) => selectedSet.has(move.addressId));
    if (selected.length !== addressIds.length) {
      return res.status(400).json({ error: 'One or more selected addresses were not in this preview.' });
    }
    let queued: { runId: number; jobId: number };
    try {
      queued = jobs.enqueueFromPreview(previewRunId, 'preview_folder_zone_reconcile', {
        workflowName: 'Reconcile approved Mapbox changes',
        type: FOLDER_ZONE_RECONCILE_TASK,
        mode: 'live',
        params: {
          masterSpreadsheetId: plan.masterSpreadsheetId,
          masterName: plan.masterName,
          masterTab: plan.masterTab,
          folderId: plan.folderId,
          addressIds,
          fingerprint: fingerprintFolderZoneMoves(selected),
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

interface StoredPreview {
  kind: 'folder_zone_reconcile_preview';
  masterSpreadsheetId: string;
  masterName: string;
  masterTab: string;
  folderId: string;
  moves: ReturnType<typeof planFolderZoneReconciliation>['moves'];
  appliedRunId?: number;
  [key: string]: unknown;
}

function parsePreview(json: string): StoredPreview | null {
  try {
    const value = JSON.parse(json) as StoredPreview;
    if (
      value.kind !== 'folder_zone_reconcile_preview' ||
      !value.masterSpreadsheetId ||
      !value.masterTab ||
      !value.folderId ||
      !Array.isArray(value.moves)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function loadZoneSource(db: Deps['db']): { username: string; datasetId: string } {
  const raw = db.getSetting(ZONE_SOURCE_KEY, '');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { username?: string; datasetId?: string };
      return {
        username: String(parsed.username || DEFAULT_MAPBOX_USERNAME).trim(),
        datasetId: String(parsed.datasetId || DEFAULT_MAPBOX_DATASET_ID).trim(),
      };
    } catch {
      // Fall through to the known working defaults.
    }
  }
  return { username: DEFAULT_MAPBOX_USERNAME, datasetId: DEFAULT_MAPBOX_DATASET_ID };
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

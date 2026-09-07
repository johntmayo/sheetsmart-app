import type { Request, Response, Router } from 'express';
import type { Deps } from '../types';
import * as appDb from '../db';
import * as google from '../google';
import * as jobs from '../jobs';
import {
  canonicalizeHeaders,
  detectSheetZoneWithName,
  fingerprintDictionaryAliases,
  type DictionaryAliasSpec,
} from '../lib/columns';
import { filterGridByTombstones, loadActiveTombstones } from '../lib/tombstones';
import {
  folderNewResidentsFingerprint,
  planPullNewResidentsFromFolder,
  type CaptainPullSheet,
  type FolderNewAddress,
} from '../lib/pullEngine';
import { FOLDER_CAPTAIN_IMPORT_TASK } from '../executionTasks';
import type { Grid } from '../lib/mergeEngine';

interface ConnectionRow {
  name: string;
  type: string;
  google_id: string;
  source_tab: string;
}

interface StoredPreview {
  kind: 'folder_captain_import_preview';
  masterSpreadsheetId: string;
  masterName: string;
  masterTab: string;
  folderId: string;
  addresses: FolderNewAddress[];
  appliedRunId?: number;
  [key: string]: unknown;
}

export default function registerCaptainImportRoutes(api: Router, { db }: Deps): void {
  api.get('/captain-import/latest-preview', (_req: Request, res: Response) => {
    const latest = db.get<{ id: number; summary_json: string }>(
      `SELECT id, summary_json
       FROM runs
       WHERE type='preview_folder_captain_import' AND mode='dry' AND status='succeeded'
       ORDER BY id DESC
       LIMIT 1`
    );
    if (!latest) return res.status(404).json({ error: 'No completed captain-import preview is available yet.' });
    const summary = JSON.parse(latest.summary_json) as StoredPreview;
    const errors = Array.isArray(summary.errors) ? summary.errors : [];
    const readErrors = Array.isArray(summary.readErrors) ? summary.readErrors : [];
    return res.json({
      runId: latest.id,
      ...summary,
      canApply: summary.addresses.length > 0 && errors.length === 0 && readErrors.length === 0,
    });
  });

  api.post('/captain-import/preview', async (_req: Request, res: Response) => {
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
       VALUES ('Find captain-added residents', 'preview_folder_captain_import', 'dry', 'running', datetime('now'))`
    );
    const runId = Number(insert.lastInsertRowid);
    try {
      const masterMeta = await google.getSpreadsheetMeta(master.google_id);
      const masterTab = master.source_tab || masterMeta.tabs[0] || '';
      if (!masterTab) throw new Error('The master spreadsheet has no readable tab.');
      const masterGrid = (await google.readValues(
        master.google_id,
        google.a1Range(masterTab, 'A:ZZ')
      )) as Grid;
      const dictionary = loadDictionaryAliases(db);
      const tombstones = loadActiveTombstones(db);
      const dictionaryFingerprint = fingerprintDictionaryAliases(dictionary);
      const masterHeaderResult = canonicalizeHeaders(masterGrid[0] || [], dictionary);
      if (masterHeaderResult.errors.length > 0) {
        throw new Error(`Master columns are ambiguous: ${masterHeaderResult.errors.join(' ')}`);
      }
      const canonicalMaster = filterGridByTombstones(
        [masterHeaderResult.headers, ...masterGrid.slice(1)] as Grid,
        tombstones
      );
      const files = await google.listSpreadsheetsInFolder(folder.google_id);
      const captainSheets: CaptainPullSheet[] = [];
      const readErrors: Array<{ spreadsheet: string; reason: string }> = [];

      await mapLimit(files, 10, async (file) => {
        try {
          const grid = (await google.readValues(file.id, 'A:ZZ')) as Grid;
          const headerResult = canonicalizeHeaders(grid[0] || [], dictionary);
          if (headerResult.errors.length > 0) {
            throw new Error(headerResult.errors.join(' '));
          }
          captainSheets.push({
            spreadsheetId: file.id,
            spreadsheetName: file.name,
            tabName: '',
            zone: detectSheetZoneWithName((grid[0] || []).map(String), grid.slice(1), file.name),
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

      // Address-only placeholder rows are valid in the real data model. The
      // two actual safety requirements are resident_id and address_id.
      const plan = planPullNewResidentsFromFolder(canonicalMaster, captainSheets, {
        requiredColumns: [],
        forbiddenColumns: appDb.zoneDashboardSalesHeaders(),
      });
      const residents = plan.addresses.reduce((sum, address) => sum + address.residents.length, 0);
      const warnedAddresses = plan.addresses.filter((address) => address.risk !== 'none');
      const safeAddresses = plan.addresses.filter((address) => address.risk === 'none');
      const summary: StoredPreview = {
        kind: 'folder_captain_import_preview',
        masterSpreadsheetId: master.google_id,
        masterName: master.name,
        masterTab,
        folderId: folder.google_id,
        generatedAt: new Date().toISOString(),
        dictionaryFingerprint,
        fingerprint: plan.fingerprint,
        addresses: plan.addresses,
        blocked: plan.blocked,
        skipped: plan.skipped,
        columnsOnlyOnCaptains: plan.columnsOnlyOnCaptains,
        errors: plan.errors,
        readErrors,
        impact: {
          addresses: plan.addresses.length,
          newAddresses: plan.addresses.filter((address) => address.kind === 'new_address').length,
          existingAddresses: plan.addresses.filter((address) => address.kind === 'existing_address').length,
          residents,
          safeAddresses: safeAddresses.length,
          safeResidents: safeAddresses.reduce((sum, address) => sum + address.residents.length, 0),
          warnedAddresses: warnedAddresses.length,
          warnedResidents: warnedAddresses.reduce((sum, address) => sum + address.residents.length, 0),
          blockedAddresses: plan.blocked.length,
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
        canApply: plan.addresses.length > 0 && plan.errors.length === 0 && readErrors.length === 0,
      });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post('/captain-import/apply', (req: Request, res: Response) => {
    const previewRunId = Number(req.body?.previewRunId);
    const addressIds = Array.isArray(req.body?.addressIds)
      ? (req.body.addressIds as unknown[]).map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (!Number.isInteger(previewRunId) || previewRunId <= 0) {
      return res.status(400).json({ error: 'A valid preview is required.' });
    }
    if (req.body?.confirmation !== 'APPLY') {
      return res.status(400).json({ error: 'Type APPLY to confirm these approved real-master additions.' });
    }
    if (addressIds.length === 0 || addressIds.length > 500) {
      return res.status(400).json({ error: 'Select between 1 and 500 addresses for one import run.' });
    }
    const preview = db.get<{ type: string; mode: string; status: string; summary_json: string }>(
      'SELECT type, mode, status, summary_json FROM runs WHERE id=?',
      [previewRunId]
    );
    if (
      !preview ||
      preview.type !== 'preview_folder_captain_import' ||
      preview.mode !== 'dry' ||
      preview.status !== 'succeeded'
    ) {
      return res.status(400).json({ error: 'That captain import preview is not available.' });
    }
    const plan = parsePreview(preview.summary_json);
    if (!plan) return res.status(400).json({ error: 'That preview does not contain a valid plan.' });
    if (
      (Array.isArray(plan.errors) && plan.errors.length > 0) ||
      (Array.isArray(plan.readErrors) && plan.readErrors.length > 0)
    ) {
      return res.status(409).json({ error: 'Fix the sheet problems shown in the preview, then run a fresh scan.' });
    }
    if (!plan.dictionaryFingerprint) {
      return res.status(409).json({ error: 'The Fields settings were not recorded with this preview. Run a fresh scan.' });
    }
    const appliedRunId = jobs.appliedRunForPreview(previewRunId) || plan.appliedRunId;
    if (appliedRunId) {
      return res.status(409).json({ error: `That preview was already used for live run #${appliedRunId}.` });
    }
    const selectedSet = new Set(addressIds);
    const selected = plan.addresses.filter((address) => selectedSet.has(address.addressId));
    if (selected.length !== addressIds.length) {
      return res.status(400).json({ error: 'One or more selected addresses were not in this preview.' });
    }

    let queued: { runId: number; jobId: number };
    try {
      queued = jobs.enqueueFromPreview(previewRunId, 'preview_folder_captain_import', {
        workflowName: 'Import approved captain-added residents',
        type: FOLDER_CAPTAIN_IMPORT_TASK,
        mode: 'live',
        params: {
          previewRunId,
          masterSpreadsheetId: plan.masterSpreadsheetId,
          masterName: plan.masterName,
          masterTab: plan.masterTab,
          folderId: plan.folderId,
          addressIds,
          fingerprint: folderNewResidentsFingerprint(selected),
          dictionaryFingerprint: String(plan.dictionaryFingerprint || ''),
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

function loadDictionaryAliases(db: Deps['db']): DictionaryAliasSpec[] {
  return db.all<{ id: number; canonical_name: string }>(
    'SELECT id, canonical_name FROM dictionary_fields ORDER BY sort_order, id'
  ).map((field) => ({
    canonicalName: field.canonical_name,
    aliases: db
      .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id=? ORDER BY alias', [field.id])
      .map((row) => row.alias),
  }));
}

function parsePreview(json: string): StoredPreview | null {
  try {
    const value = JSON.parse(json) as StoredPreview;
    if (
      value.kind !== 'folder_captain_import_preview' ||
      !value.masterSpreadsheetId ||
      !value.masterTab ||
      !value.folderId ||
      !Array.isArray(value.addresses)
    ) {
      return null;
    }
    return value;
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

import type { Request, Response, Router } from 'express';
import type { Deps } from '../types';
import * as google from '../google';
import * as jobs from '../jobs';
import {
  canonicalizeHeaders,
  fingerprintDictionaryAliases,
  findColumn,
  type DictionaryAliasSpec,
} from '../lib/columns';
import {
  fingerprintPushFieldsSheets,
  fingerprintPushMissingSheets,
  fingerprintSelectedPushFields,
  fingerprintSelectedPushMissing,
  planFolderPushFields,
  planFolderPushMissing,
  type PushFieldsSheetPlan,
  type PushMissingSheetPlan,
} from '../lib/captainSyncEngine';
import { summarizeCellFill, summarizePushMissing, type DictField } from '../lib/previewEngine';
import { filterGridByTombstones, loadActiveTombstones } from '../lib/tombstones';
import { trimHeaders, type Grid } from '../lib/mergeEngine';
import { PUSH_FOLDER_TASK, PUSH_MISSING_FOLDER_TASK } from '../captainSyncTasks';

interface ConnectionRow {
  name: string;
  google_id: string;
  source_tab: string;
}

interface PushMissingPreviewSummary {
  kind: 'push_missing_folder_preview';
  masterSpreadsheetId: string;
  masterName: string;
  masterTab: string;
  folderId: string;
  generatedAt: string;
  dictionaryFingerprint: string;
  fingerprint: string;
  sheets: PushMissingSheetPlan[];
  readErrors: Array<{ spreadsheet: string; reason: string }>;
  impact: ReturnType<typeof summarizePushMissing> & {
    sheetsScanned: number;
    readErrors: number;
    sheetsWithAdds: number;
  };
  appliedRunId?: number;
}

interface PushFieldsPreviewSummary {
  kind: 'push_fields_folder_preview';
  masterSpreadsheetId: string;
  masterName: string;
  masterTab: string;
  folderId: string;
  generatedAt: string;
  dictionaryFingerprint: string;
  fingerprint: string;
  sheets: PushFieldsSheetPlan[];
  readErrors: Array<{ spreadsheet: string; reason: string }>;
  impact: ReturnType<typeof summarizeCellFill> & {
    sheetsScanned: number;
    readErrors: number;
  };
  appliedRunId?: number;
}

const MAX_PUSH_MISSING_RESIDENTS = 500;
const MAX_PUSH_FIELDS_CELLS = 5000;

export default function registerCaptainSyncRoutes(api: Router, { db }: Deps): void {
  api.post('/captain-sync/push-missing/preview', async (_req: Request, res: Response) => {
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
       VALUES ('Add missing residents to captain sheets', 'preview_push_missing_folder', 'dry', 'running', datetime('now'))`
    );
    const runId = Number(insert.lastInsertRowid);
    try {
      const payload = await buildPushMissingPreview(db, master, folder);
      const summary: PushMissingPreviewSummary = {
        kind: 'push_missing_folder_preview',
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
        canApply: payload.impact.appended > 0 && payload.readErrors.length === 0,
      });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post('/captain-sync/push-missing/apply', (req: Request, res: Response) => {
    return applyCaptainSync(req, res, db, {
      expectedPreviewType: 'preview_push_missing_folder',
      workflowName: 'Add missing residents to captain sheets',
      taskType: PUSH_MISSING_FOLDER_TASK,
      parseSummary: parsePushMissingPreview,
      validateSelection,
    });
  });

  api.post('/captain-sync/push-fields/preview', async (_req: Request, res: Response) => {
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
       VALUES ('Push master fields to captain sheets', 'preview_push_folder', 'dry', 'running', datetime('now'))`
    );
    const runId = Number(insert.lastInsertRowid);
    try {
      const payload = await buildPushFieldsPreview(db, master, folder);
      const summary: PushFieldsPreviewSummary = {
        kind: 'push_fields_folder_preview',
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
          (payload.impact.filled > 0 || payload.impact.columnsToAdd > 0 || payload.impact.overwritten > 0) &&
          payload.readErrors.length === 0,
      });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post('/captain-sync/push-fields/apply', (req: Request, res: Response) => {
    return applyCaptainSync(req, res, db, {
      expectedPreviewType: 'preview_push_folder',
      workflowName: 'Push master fields to captain sheets',
      taskType: PUSH_FOLDER_TASK,
      parseSummary: parsePushFieldsPreview,
      validateSelection: validatePushFieldsSelectionWrapper,
    });
  });
}

async function buildPushMissingPreview(
  db: Deps['db'],
  master: ConnectionRow,
  folder: ConnectionRow
): Promise<Omit<PushMissingPreviewSummary, 'kind' | 'generatedAt'>> {
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
  const sensitive = sensitiveNames(db);
  const { captainSheets, readErrors } = await readCaptainSheets(folder.google_id, dictionary, tombstones);
  const sheets = captainSheets.map((sheet) => {
    const [planned] = planFolderPushMissing(canonicalMaster, [sheet], {
      sensitiveColumns: sensitive,
      distributedColumns: captainDistributedHeaders(db, trimHeaders(sheet.grid[0])),
    });
    return planned;
  });
  const impactBase = summarizePushMissing(
    sheets.map((sheet) => ({
      appended: sheet.appended.map((row) => ({
        residentId: row.residentId,
        residentName: row.residentName,
        masterRow: 0,
      })),
      flagged: sheet.flagged.map((row) => ({
        residentId: row.residentId,
        residentName: row.residentName,
        flaggedColumns: row.flaggedColumns,
      })),
      skipped: Array.from({ length: sheet.skipped }, () => ({
        residentId: '',
        residentName: '',
        masterRow: 0,
        reason: '',
      })),
      errors: sheet.errors.map((message) => ({ message })),
      detectedZone: sheet.detectedZone,
      newRows: [],
    }))
  );
  return {
    masterSpreadsheetId: master.google_id,
    masterName: master.name,
    masterTab,
    folderId: folder.google_id,
    dictionaryFingerprint,
    fingerprint: fingerprintPushMissingSheets(sheets),
    sheets,
    readErrors,
    impact: {
      ...impactBase,
      sheetsScanned: captainSheets.length,
      readErrors: readErrors.length,
      sheetsWithAdds: sheets.filter((sheet) => sheet.appended.length > 0).length,
    },
  };
}

async function buildPushFieldsPreview(
  db: Deps['db'],
  master: ConnectionRow,
  folder: ConnectionRow
): Promise<Omit<PushFieldsPreviewSummary, 'kind' | 'generatedAt'>> {
  const masterMeta = await google.getSpreadsheetMeta(master.google_id);
  const masterTab = master.source_tab || masterMeta.tabs[0] || '';
  if (!masterTab) throw new Error('The master spreadsheet has no readable tab.');
  const dictionary = loadDictionaryAliases(db);
  const dictionaryFingerprint = fingerprintDictionaryAliases(dictionary);
  const dictFields = loadDictionaryFields(db);
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
  const { captainSheets, readErrors } = await readCaptainSheets(folder.google_id, dictionary, tombstones);
  const sheets = planFolderPushFields(canonicalMaster, captainSheets, dictFields);
  const impactBase = summarizeCellFill(
    sheets.map((sheet) => ({
      columnsToAdd: sheet.columnsToAdd,
      filled: Array.from({ length: sheet.filled }, () => ({
        row: 0,
        column: '',
        existingValue: '',
        newValue: '',
        policy: 'fill_blank' as const,
      })),
      overwritten: Array.from({ length: sheet.overwritten }, () => ({
        row: 0,
        column: '',
        existingValue: '',
        newValue: '',
        policy: 'overwrite' as const,
      })),
      conflicts: Array.from({ length: sheet.conflicts }, () => ({
        row: 0,
        column: '',
        existingValue: '',
        newValue: '',
        policy: 'conflict' as const,
      })),
      skipped: [],
      writes: [],
      errors: sheet.errors.map((message) => ({ message })),
    }))
  );
  return {
    masterSpreadsheetId: master.google_id,
    masterName: master.name,
    masterTab,
    folderId: folder.google_id,
    dictionaryFingerprint,
    fingerprint: fingerprintPushFieldsSheets(sheets),
    sheets,
    readErrors,
    impact: {
      ...impactBase,
      sheetsScanned: captainSheets.length,
      readErrors: readErrors.length,
    },
  };
}

function applyCaptainSync(
  req: Request,
  res: Response,
  db: Deps['db'],
  options: {
    expectedPreviewType: string;
    workflowName: string;
    taskType: string;
    parseSummary: (json: string) => PushMissingPreviewSummary | PushFieldsPreviewSummary | null;
    validateSelection: (
      summary: PushMissingPreviewSummary | PushFieldsPreviewSummary,
      spreadsheetIds: string[]
    ) => string | null;
  }
): void {
  if (req.body?.confirmed !== true) {
    res.status(400).json({ error: 'Confirm before updating captain sheets.' });
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
    preview.type !== options.expectedPreviewType ||
    preview.mode !== 'dry' ||
    preview.status !== 'succeeded'
  ) {
    res.status(400).json({ error: 'That preview is no longer available.' });
    return;
  }
  const plan = options.parseSummary(preview.summary_json);
  if (!plan) {
    res.status(400).json({ error: 'That preview does not contain a valid plan.' });
    return;
  }
  if (plan.readErrors.length > 0) {
    res.status(409).json({ error: 'Fix the sheet problems shown in the preview, then run a fresh scan.' });
    return;
  }
  const selectionError = options.validateSelection(plan, spreadsheetIds);
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

  let expectedFingerprint = '';
  if (plan.kind === 'push_missing_folder_preview') {
    expectedFingerprint = fingerprintSelectedPushMissing(plan.sheets, spreadsheetIds);
  } else {
    expectedFingerprint = fingerprintSelectedPushFields(plan.sheets, spreadsheetIds);
  }

  let queued: { runId: number; jobId: number };
  try {
    queued = jobs.enqueueFromPreview(previewRunId, options.expectedPreviewType, {
      workflowName: options.workflowName,
      type: options.taskType,
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
}

function validateSelection(
  summary: PushMissingPreviewSummary | PushFieldsPreviewSummary,
  spreadsheetIds: string[]
): string | null {
  if (summary.kind !== 'push_missing_folder_preview') return 'Unexpected preview type.';
  return validatePushMissingSelection(summary, spreadsheetIds);
}

function validatePushMissingSelection(summary: PushMissingPreviewSummary, spreadsheetIds: string[]): string | null {
  const selected = summary.sheets.filter((sheet) => spreadsheetIds.includes(sheet.spreadsheetId));
  const residents = selected.reduce((sum, sheet) => sum + sheet.appended.length, 0);
  if (residents === 0) return 'The selected captain sheets have no new residents to add.';
  if (residents > MAX_PUSH_MISSING_RESIDENTS) {
    return `Select at most ${MAX_PUSH_MISSING_RESIDENTS} new residents per run (${residents} selected).`;
  }
  return null;
}

function validatePushFieldsSelectionWrapper(
  summary: PushMissingPreviewSummary | PushFieldsPreviewSummary,
  spreadsheetIds: string[]
): string | null {
  if (summary.kind !== 'push_fields_folder_preview') return 'Unexpected preview type.';
  return validatePushFieldsSelection(summary, spreadsheetIds);
}

function validatePushFieldsSelection(summary: PushFieldsPreviewSummary, spreadsheetIds: string[]): string | null {
  const selected = summary.sheets.filter((sheet) => spreadsheetIds.includes(sheet.spreadsheetId));
  const cells = selected.reduce((sum, sheet) => sum + sheet.filled + sheet.overwritten, 0);
  const columns = selected.reduce((sum, sheet) => sum + sheet.columnsToAdd.length, 0);
  if (cells === 0 && columns === 0) return 'The selected captain sheets have no blank cells to fill.';
  if (cells > MAX_PUSH_FIELDS_CELLS) {
    return `Select at most ${MAX_PUSH_FIELDS_CELLS.toLocaleString()} cell updates per run (${cells.toLocaleString()} selected).`;
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

function parsePushMissingPreview(json: string): PushMissingPreviewSummary | null {
  try {
    const value = JSON.parse(json) as Partial<PushMissingPreviewSummary>;
    if (value.kind !== 'push_missing_folder_preview' || !Array.isArray(value.sheets)) return null;
    return value as PushMissingPreviewSummary;
  } catch {
    return null;
  }
}

function parsePushFieldsPreview(json: string): PushFieldsPreviewSummary | null {
  try {
    const value = JSON.parse(json) as Partial<PushFieldsPreviewSummary>;
    if (value.kind !== 'push_fields_folder_preview' || !Array.isArray(value.sheets)) return null;
    return value as PushFieldsPreviewSummary;
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

function loadDictionaryFields(db: Deps['db']): DictField[] {
  const rows = db.all<{
    id: number;
    canonical_name: string;
    data_type: 'text' | 'number' | 'date' | 'checkbox';
    is_text_safe: number;
    is_identity: number;
    is_sensitive: number;
    distribute_to_captain: number;
    default_policy: string;
  }>(
    `SELECT id, canonical_name, data_type, is_text_safe, is_identity, is_sensitive, distribute_to_captain, default_policy
     FROM dictionary_fields ORDER BY sort_order`
  );
  return rows.map((row) => ({
    canonical_name: row.canonical_name,
    data_type: row.data_type,
    is_text_safe: row.is_text_safe,
    is_identity: row.is_identity,
    is_sensitive: row.is_sensitive,
    distribute_to_captain: row.distribute_to_captain,
    default_policy: row.default_policy,
    aliases: db
      .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id=? ORDER BY alias', [row.id])
      .map((alias) => alias.alias),
  }));
}

function sensitiveNames(db: Deps['db']): string[] {
  return db
    .all<{ canonical_name: string }>(
      'SELECT canonical_name FROM dictionary_fields WHERE is_sensitive = 1 AND distribute_to_captain = 1'
    )
    .map((row) => row.canonical_name);
}

function captainDistributedHeaders(db: Deps['db'], headers: string[]): string[] {
  return db
    .all<{ id: number; canonical_name: string }>(
      `SELECT id, canonical_name FROM dictionary_fields
       WHERE distribute_to_captain=1 ORDER BY sort_order, id`
    )
    .map((field) => {
      const aliases = db
        .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id=?', [field.id])
        .map((row) => row.alias);
      return findColumn(headers, [field.canonical_name, ...aliases]);
    })
    .filter((header): header is string => Boolean(header));
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

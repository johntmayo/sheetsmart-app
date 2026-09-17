import { createHash } from 'node:crypto';
import * as db from './db';
import * as google from './google';
import { registerTask, type JobContext } from './jobs';
import { canonicalizeHeaders, findColumn, fingerprintDictionaryAliases, type DictionaryAliasSpec } from './lib/columns';
import {
  cellFillProposals,
  fingerprintSelectedPushFields,
  fingerprintSelectedPushMissing,
  replanPushFieldsSheet,
  replanPushMissingSheet,
  type PushFieldsSheetPlan,
  type PushMissingSheetPlan,
} from './lib/captainSyncEngine';
import { ensureHeaderColumns, planGuardedAppends, planGuardedCellWrites } from './lib/liveWriteEngine';
import { trimHeaders, type Grid } from './lib/mergeEngine';
import { type DictField } from './lib/previewEngine';
import { filterGridByTombstones, loadActiveTombstones } from './lib/tombstones';

export const PUSH_MISSING_FOLDER_TASK = 'push_missing_folder';
export const PUSH_FOLDER_TASK = 'push_folder';

const MAX_PUSH_MISSING_RESIDENTS = 500;
const MAX_PUSH_FIELDS_CELLS = 5000;

interface CaptainSyncParams {
  previewRunId: number;
  masterSpreadsheetId: string;
  masterName: string;
  masterTab: string;
  folderId: string;
  spreadsheetIds: string[];
  expectedFingerprint: string;
  dictionaryFingerprint: string;
  sheets: PushMissingSheetPlan[] | PushFieldsSheetPlan[];
}

export function registerCaptainSyncTasks(): void {
  registerTask(PUSH_MISSING_FOLDER_TASK, pushMissingFolder);
  registerTask(PUSH_FOLDER_TASK, pushFolderFields);
}

async function pushMissingFolder(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const params = parseCaptainSyncParams(ctx.params);
  if (params.spreadsheetIds.length === 0) {
    throw new Error('Choose at least one captain sheet for this run.');
  }

  const previewSheets = params.sheets as PushMissingSheetPlan[];
  if (fingerprintSelectedPushMissing(previewSheets, params.spreadsheetIds) !== params.expectedFingerprint) {
    throw new Error('The selected captain sheets no longer match the approved preview. Run a fresh scan.');
  }

  ctx.reportProgress({ stage: 'reading', message: 'Rechecking the master and selected captain sheets.' });
  const masterGrid = await readGrid(params.masterSpreadsheetId, params.masterTab);
  const dictionary = loadDictionaryAliases();
  if (fingerprintDictionaryAliases(dictionary) !== params.dictionaryFingerprint) {
    throw new Error('The Fields settings changed after preview. Nothing was written. Run a fresh scan.');
  }
  const tombstones = loadActiveTombstones(db);
  const masterHeaderResult = canonicalizeHeaders(masterGrid[0] || [], dictionary);
  if (masterHeaderResult.errors.length > 0) {
    throw new Error(`Master columns are ambiguous: ${masterHeaderResult.errors.join(' ')}`);
  }
  const canonicalMaster = filterGridByTombstones(
    [masterHeaderResult.headers, ...masterGrid.slice(1)] as Grid,
    tombstones
  );
  const sensitive = db
    .all<{ canonical_name: string }>(
      'SELECT canonical_name FROM dictionary_fields WHERE is_sensitive = 1 AND distribute_to_captain = 1'
    )
    .map((row) => row.canonical_name);
  const previewById = new Map(previewSheets.map((sheet) => [sheet.spreadsheetId, sheet]));

  let totalAppended = 0;
  let totalFlagged = 0;
  const sheetsUpdated: string[] = [];

  for (const spreadsheetId of params.spreadsheetIds) {
    if (totalAppended >= MAX_PUSH_MISSING_RESIDENTS) break;
    const previewSheet = previewById.get(spreadsheetId);
    if (!previewSheet || previewSheet.appended.length === 0) continue;

    const meta = await google.getSpreadsheetMeta(spreadsheetId);
    const tabName = previewSheet.tabName || meta.tabs[0] || '';
    if (!tabName) throw new Error(`${previewSheet.spreadsheetName} has no readable tab.`);

    const captainRaw = await readGrid(spreadsheetId, tabName);
    const headerResult = canonicalizeHeaders(captainRaw[0] || [], dictionary);
    if (headerResult.errors.length > 0) {
      throw new Error(`${previewSheet.spreadsheetName}: ${headerResult.errors.join(' ')}`);
    }
    const captainGrid = filterGridByTombstones(
      [headerResult.headers, ...captainRaw.slice(1)] as Grid,
      tombstones
    );
    const distributedColumns = captainDistributedHeaders(trimHeaders(captainGrid[0]));
    const fresh = replanPushMissingSheet(canonicalMaster, captainGrid, {
      sensitiveColumns: sensitive,
      distributedColumns,
    });
    if (fresh.errors.length > 0) {
      throw new Error(`${previewSheet.spreadsheetName}: ${fresh.errors.map((error) => error.message).join('; ')}`);
    }
    const freshFingerprint = hashPushMissing(spreadsheetId, fresh);
    if (freshFingerprint !== previewSheet.sheetFingerprint) {
      throw new Error(
        `${previewSheet.spreadsheetName} changed after preview. Nothing was written. Run a fresh scan.`
      );
    }

    const guarded = planGuardedAppends(captainGrid, fresh.newRows);
    if (guarded.errors.length > 0) {
      throw new Error(`${previewSheet.spreadsheetName}: ${guarded.errors.join('; ')}`);
    }
    if (guarded.appends.length === 0) continue;

    const remaining = MAX_PUSH_MISSING_RESIDENTS - totalAppended;
    const batch = guarded.appends.slice(0, remaining);
    if (batch.length < guarded.appends.length) {
      throw new Error(
        `This run would add more than ${MAX_PUSH_MISSING_RESIDENTS} residents. Select fewer captain sheets or run another batch.`
      );
    }

    const headers = trimHeaders(captainGrid[0]);
    const flaggedIds = new Set(fresh.flagged.map((row) => row.residentId));
    const snapshotIds: number[] = [];
    const snapshot = db.transaction(() => {
      for (const append of batch) {
        const result = db.run(
          `INSERT INTO run_snapshots
             (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
              range_a1, before_json, after_json, metadata_json)
           VALUES (?, ?, ?, ?, 'row_append', ?, '', 'null', ?, ?)`,
          [
            ctx.runId,
            spreadsheetId,
            previewSheet.spreadsheetName,
            tabName,
            append.residentId,
            JSON.stringify(append.row),
            JSON.stringify({
              kind: 'push_missing_folder',
              previewRunId: params.previewRunId,
              headers,
              detectedZone: fresh.detectedZone,
            }),
          ]
        );
        snapshotIds.push(Number(result.lastInsertRowid));
      }
    });
    snapshot();

    ctx.reportProgress({
      stage: 'writing',
      message: `Adding ${batch.length} resident row(s) to ${previewSheet.spreadsheetName}.`,
    });
    const result = await google.appendValues(
      spreadsheetId,
      google.a1Range(tabName, 'A:ZZ'),
      batch.map((append) => append.row)
    );
    if (result.updatedRows !== batch.length) {
      throw new Error(
        `Google reported ${result.updatedRows} appended row(s) on ${previewSheet.spreadsheetName}, but ${batch.length} were approved.`
      );
    }
    if (snapshotIds.length > 0) {
      db.run(`UPDATE run_snapshots SET range_a1=? WHERE id IN (${snapshotIds.map(() => '?').join(',')})`, [
        result.updatedRange,
        ...snapshotIds,
      ]);
    }

    totalAppended += batch.length;
    totalFlagged += batch.filter((append) => flaggedIds.has(append.residentId)).length;
    sheetsUpdated.push(previewSheet.spreadsheetName);

    for (const append of batch) {
      ctx.log({
        spreadsheet: previewSheet.spreadsheetName,
        row: result.updatedRange,
        resident_id: append.residentId,
        type: 'push_missing_folder',
        message: `Added missing resident ${append.residentId} to ${previewSheet.spreadsheetName}.`,
      });
      if (flaggedIds.has(append.residentId)) {
        ctx.log({
          spreadsheet: previewSheet.spreadsheetName,
          resident_id: append.residentId,
          type: 'sensitive',
          message: 'This appended row contains one or more fields marked sensitive in the Field Dictionary.',
        });
      }
    }
  }

  return {
    previewRunId: params.previewRunId,
    appended: totalAppended,
    flagged: totalFlagged,
    sheetsUpdated: sheetsUpdated.length,
    sheetNames: sheetsUpdated,
    revertAvailable: totalAppended > 0,
    nextStep:
      totalAppended > 0
        ? 'New residents were appended to the selected captain sheets. Existing rows were not changed.'
        : 'Every selected captain sheet was already up to date.',
  };
}

async function pushFolderFields(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const params = parseCaptainSyncParams(ctx.params);
  if (params.spreadsheetIds.length === 0) {
    throw new Error('Choose at least one captain sheet for this run.');
  }

  const previewSheets = params.sheets as PushFieldsSheetPlan[];
  if (fingerprintSelectedPushFields(previewSheets, params.spreadsheetIds) !== params.expectedFingerprint) {
    throw new Error('The selected captain sheets no longer match the approved preview. Run a fresh scan.');
  }

  ctx.reportProgress({ stage: 'reading', message: 'Rechecking the master and selected captain sheets.' });
  const masterGrid = await readGrid(params.masterSpreadsheetId, params.masterTab);
  const dictionary = loadDictionaryAliases();
  const dictFields = loadDictionaryFields();
  if (fingerprintDictionaryAliases(dictionary) !== params.dictionaryFingerprint) {
    throw new Error('The Fields settings changed after preview. Nothing was written. Run a fresh scan.');
  }
  const tombstones = loadActiveTombstones(db);
  const masterHeaderResult = canonicalizeHeaders(masterGrid[0] || [], dictionary);
  if (masterHeaderResult.errors.length > 0) {
    throw new Error(`Master columns are ambiguous: ${masterHeaderResult.errors.join(' ')}`);
  }
  const canonicalMaster = filterGridByTombstones(
    [masterHeaderResult.headers, ...masterGrid.slice(1)] as Grid,
    tombstones
  );
  const previewById = new Map(previewSheets.map((sheet) => [sheet.spreadsheetId, sheet]));

  let totalCells = 0;
  let totalConflicts = 0;
  const sheetsUpdated: string[] = [];

  for (const spreadsheetId of params.spreadsheetIds) {
    if (totalCells >= MAX_PUSH_FIELDS_CELLS) break;
    const previewSheet = previewById.get(spreadsheetId);
    if (
      !previewSheet ||
      (previewSheet.filled === 0 && previewSheet.overwritten === 0 && previewSheet.columnsToAdd.length === 0)
    ) {
      continue;
    }

    const meta = await google.getSpreadsheetMeta(spreadsheetId);
    const tabName = previewSheet.tabName || meta.tabs[0] || '';
    if (!tabName) throw new Error(`${previewSheet.spreadsheetName} has no readable tab.`);

    const captainRaw = await readGrid(spreadsheetId, tabName);
    const headerResult = canonicalizeHeaders(captainRaw[0] || [], dictionary);
    if (headerResult.errors.length > 0) {
      throw new Error(`${previewSheet.spreadsheetName}: ${headerResult.errors.join(' ')}`);
    }
    const captainGrid = filterGridByTombstones(
      [headerResult.headers, ...captainRaw.slice(1)] as Grid,
      tombstones
    ) as Grid;

    const { plan, cfg } = replanPushFieldsSheet(canonicalMaster, captainGrid, dictFields);
    if (plan.errors.length > 0) {
      throw new Error(`${previewSheet.spreadsheetName}: ${plan.errors.map((error) => error.message).join('; ')}`);
    }
    const freshFingerprint = hashPushFields(spreadsheetId, plan);
    if (freshFingerprint !== previewSheet.sheetFingerprint) {
      throw new Error(`${previewSheet.spreadsheetName} changed after preview. Nothing was written. Run a fresh scan.`);
    }

    totalConflicts += plan.conflicts.length;

    const { headers, added, addedIndexes } = ensureHeaderColumns(captainGrid, plan.columnsToAdd);
    if (added.length > 0) {
      const sheet = (await google.getSheetProperties(spreadsheetId)).find((candidate) => candidate.title === tabName);
      if (!sheet) throw new Error(`Tab "${tabName}" no longer exists on ${previewSheet.spreadsheetName}.`);
      const columnsNeeded = headers.length - sheet.columnCount;
      if (columnsNeeded > 0) {
        await google.batchUpdateSpreadsheet(spreadsheetId, [
          {
            appendDimension: {
              sheetId: sheet.sheetId,
              dimension: 'COLUMNS',
              length: columnsNeeded,
            },
          },
        ]);
      }
      const headerUpdates = added.map((column, index) => ({
        range: google.a1Range(tabName, `${google.columnLetter(addedIndexes[index] - 1)}1`),
        values: [[column]],
      }));
      const headerSnapshot = db.transaction(() => {
        for (let index = 0; index < added.length; index++) {
          db.run(
            `INSERT INTO run_snapshots
               (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
                range_a1, before_json, after_json, metadata_json)
             VALUES (?, ?, ?, ?, 'cell_update', '', ?, '""', ?, ?)`,
            [
              ctx.runId,
              spreadsheetId,
              previewSheet.spreadsheetName,
              tabName,
              headerUpdates[index].range,
              JSON.stringify(added[index]),
              JSON.stringify({ kind: 'push_folder_header', column: added[index], previewRunId: params.previewRunId }),
            ]
          );
        }
      });
      headerSnapshot();
      await google.updateValues(spreadsheetId, headerUpdates);
    }

    const proposals = cellFillProposals(captainGrid, plan, cfg.fieldMeta);
    const guarded = planGuardedCellWrites(captainGrid, proposals);
    if (guarded.errors.length > 0) {
      throw new Error(`${previewSheet.spreadsheetName}: ${guarded.errors.join('; ')}`);
    }
    if (guarded.writes.length === 0) continue;

    const remaining = MAX_PUSH_FIELDS_CELLS - totalCells;
    if (guarded.writes.length > remaining) {
      throw new Error(
        `This run would write more than ${MAX_PUSH_FIELDS_CELLS.toLocaleString()} cells. Select fewer captain sheets or run another batch.`
      );
    }

    const insertSnapshots = db.transaction(() => {
      for (const write of guarded.writes) {
        const range = google.a1Range(tabName, `${google.columnLetter(write.col - 1)}${write.row}`);
        db.run(
          `INSERT INTO run_snapshots
             (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
              range_a1, before_json, after_json, metadata_json)
           VALUES (?, ?, ?, ?, 'cell_update', ?, ?, ?, ?, ?)`,
          [
            ctx.runId,
            spreadsheetId,
            previewSheet.spreadsheetName,
            tabName,
            write.residentId,
            range,
            JSON.stringify(write.before ?? ''),
            JSON.stringify(write.after ?? ''),
            JSON.stringify({ kind: 'push_folder', column: write.column, previewRunId: params.previewRunId }),
          ]
        );
      }
    });
    insertSnapshots();

    ctx.reportProgress({
      stage: 'writing',
      message: `Updating ${guarded.writes.length.toLocaleString()} cell(s) on ${previewSheet.spreadsheetName}.`,
    });
    await google.updateValuesChunked(
      spreadsheetId,
      guarded.writes.map((write) => ({
        range: google.a1Range(tabName, `${google.columnLetter(write.col - 1)}${write.row}`),
        values: [[write.after]],
      }))
    );

    totalCells += guarded.writes.length;
    sheetsUpdated.push(previewSheet.spreadsheetName);

    for (const write of guarded.writes) {
      ctx.log({
        spreadsheet: previewSheet.spreadsheetName,
        row: write.row,
        column: write.column,
        resident_id: write.residentId,
        type: 'push_folder',
        message: `Filled ${write.column} from the master for resident ${write.residentId}.`,
      });
    }
  }

  return {
    previewRunId: params.previewRunId,
    cellsWritten: totalCells,
    conflictsSkipped: totalConflicts,
    sheetsUpdated: sheetsUpdated.length,
    sheetNames: sheetsUpdated,
    revertAvailable: totalCells > 0,
    nextStep:
      totalConflicts > 0
        ? 'Blank cells were filled from the master. Disagreements were left unchanged; review them separately if needed.'
        : 'Blank cells were filled from the master. No existing captain values were overwritten.',
  };
}

function parseCaptainSyncParams(raw: Record<string, unknown>): CaptainSyncParams {
  const previewRunId = Number(raw.previewRunId);
  const masterSpreadsheetId = String(raw.masterSpreadsheetId || '').trim();
  const masterName = String(raw.masterName || 'Master').trim();
  const masterTab = String(raw.masterTab || '').trim();
  const folderId = String(raw.folderId || '').trim();
  const expectedFingerprint = String(raw.expectedFingerprint || '').trim();
  const dictionaryFingerprint = String(raw.dictionaryFingerprint || '').trim();
  const spreadsheetIds = Array.isArray(raw.spreadsheetIds)
    ? (raw.spreadsheetIds as unknown[]).map((value) => String(value).trim()).filter(Boolean)
    : [];
  const sheets = Array.isArray(raw.sheets) ? (raw.sheets as CaptainSyncParams['sheets']) : [];
  if (
    !Number.isInteger(previewRunId) ||
    previewRunId <= 0 ||
    !masterSpreadsheetId ||
    !masterTab ||
    !folderId ||
    !expectedFingerprint ||
    !dictionaryFingerprint
  ) {
    throw new Error('The approved captain sync plan is incomplete.');
  }
  return {
    previewRunId,
    masterSpreadsheetId,
    masterName,
    masterTab,
    folderId,
    spreadsheetIds,
    expectedFingerprint,
    dictionaryFingerprint,
    sheets,
  };
}

function hashPushMissing(spreadsheetId: string, plan: ReturnType<typeof replanPushMissingSheet>): string {
  const parts = plan.appended
    .map((row) => `${spreadsheetId}:${row.residentId}:${row.masterRow}`)
    .sort();
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function hashPushFields(spreadsheetId: string, plan: ReturnType<typeof replanPushFieldsSheet>['plan']): string {
  const hashValue = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value ?? '')).digest('hex').slice(0, 16);
  const parts = [
    ...plan.columnsToAdd.map((column) => `col:${column}`),
    ...plan.filled.map((entry) => `f:${entry.row}:${entry.column}:${hashValue(entry.newValue)}`),
    ...plan.overwritten.map((entry) => `o:${entry.row}:${entry.column}:${hashValue(entry.newValue)}`),
  ].sort();
  return createHash('sha256').update([spreadsheetId, ...parts].join('\n')).digest('hex');
}

async function readGrid(spreadsheetId: string, tabName: string): Promise<Grid> {
  return (await google.readValues(spreadsheetId, tabName ? google.a1Range(tabName, 'A:ZZ') : 'A:ZZ')) as Grid;
}

function requireLive(ctx: JobContext): void {
  if (ctx.mode !== 'live') throw new Error('Captain sync tasks require live mode.');
}

function loadDictionaryAliases(): DictionaryAliasSpec[] {
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

function loadDictionaryFields(): DictField[] {
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

function captainDistributedHeaders(headers: string[]): string[] {
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

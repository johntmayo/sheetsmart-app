import * as db from './db';
import * as google from './google';
import { registerTask, type JobContext } from './jobs';
import { canonicalizeHeaders, fingerprintDictionaryAliases, type DictionaryAliasSpec } from './lib/columns';
import {
  fingerprintSelectedPullFolder,
  planFolderPullToMaster,
  pullSheetFingerprint,
  replanPullToMasterSheet,
  type PullFolderSheetPlan,
} from './lib/captainPullEngine';
import { planGuardedCellWrites } from './lib/liveWriteEngine';
import { trimHeaders, type Grid } from './lib/mergeEngine';
import { filterGridByTombstones, loadActiveTombstones } from './lib/tombstones';
import {
  pullFieldMetaForHeaders,
  pullPoliciesForLiveFolderPull,
  recordPullConflicts,
} from './executionTasks';

export const PULL_FOLDER_TASK = 'pull_folder';

const MAX_PULL_FOLDER_CELLS = 5000;

interface CaptainPullParams {
  previewRunId: number;
  masterSpreadsheetId: string;
  masterName: string;
  masterTab: string;
  folderId: string;
  spreadsheetIds: string[];
  expectedFingerprint: string;
  dictionaryFingerprint: string;
  sheets: PullFolderSheetPlan[];
}

export function registerCaptainPullTasks(): void {
  registerTask(PULL_FOLDER_TASK, pullFolder);
}

async function pullFolder(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const params = parseCaptainPullParams(ctx.params);
  if (params.spreadsheetIds.length === 0) {
    throw new Error('Choose at least one captain sheet for this run.');
  }

  const previewSheets = params.sheets;
  if (fingerprintSelectedPullFolder(previewSheets, params.spreadsheetIds) !== params.expectedFingerprint) {
    throw new Error('The selected captain sheets no longer match the approved preview. Run a fresh scan.');
  }

  ctx.reportProgress({ stage: 'reading', message: 'Rechecking the master and selected captain sheets.' });
  const masterRaw = await readGrid(params.masterSpreadsheetId, params.masterTab);
  const dictionary = loadDictionaryAliases();
  if (fingerprintDictionaryAliases(dictionary) !== params.dictionaryFingerprint) {
    throw new Error('The Fields settings changed after preview. Nothing was written. Run a fresh scan.');
  }
  const tombstones = loadActiveTombstones(db);
  const masterHeaderResult = canonicalizeHeaders(masterRaw[0] || [], dictionary);
  if (masterHeaderResult.errors.length > 0) {
    throw new Error(`Master columns are ambiguous: ${masterHeaderResult.errors.join(' ')}`);
  }
  const masterGrid = filterGridByTombstones(
    [masterHeaderResult.headers, ...masterRaw.slice(1)] as Grid,
    tombstones
  );
  const masterHeaders = trimHeaders(masterGrid[0]);
  const policies = pullPoliciesForLiveFolderPull(masterHeaders);
  const fieldMeta = pullFieldMetaForHeaders(masterHeaders);
  const previewById = new Map(previewSheets.map((sheet) => [sheet.spreadsheetId, sheet]));

  const captainSheets: Array<{
    spreadsheetId: string;
    spreadsheetName: string;
    tabName: string;
    url: string;
    grid: Grid;
  }> = [];

  for (const spreadsheetId of params.spreadsheetIds) {
    const previewSheet = previewById.get(spreadsheetId);
    if (!previewSheet) continue;

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
    const fresh = replanPullToMasterSheet(masterGrid, captainGrid, { policies, fieldMeta });
    if (fresh.errors.length > 0) {
      throw new Error(`${previewSheet.spreadsheetName}: ${fresh.errors.join('; ')}`);
    }
    const freshFingerprint = pullSheetFingerprint(spreadsheetId, fresh);
    if (freshFingerprint !== previewSheet.sheetFingerprint) {
      throw new Error(
        `${previewSheet.spreadsheetName} changed after preview. Nothing was written. Run a fresh scan.`
      );
    }
    captainSheets.push({
      spreadsheetId,
      spreadsheetName: previewSheet.spreadsheetName,
      tabName,
      url: previewSheet.url,
      grid: captainGrid,
    });
  }

  const folderPlan = planFolderPullToMaster(masterGrid, captainSheets, { policies, fieldMeta });
  const writeChanges = [...folderPlan.fills, ...folderPlan.overwrites];
  const dedupedWrites = dedupeWrites(writeChanges);

  let conflictsLogged = 0;
  const loggedConflictKeys = new Set<string>();
  for (const record of folderPlan.conflictRecords) {
    const key = `${record.change.residentId}\u0000${record.change.column}`;
    if (loggedConflictKeys.has(key)) continue;
    loggedConflictKeys.add(key);
    conflictsLogged += recordPullConflicts(
      ctx.runId,
      {
        masterSpreadsheetId: params.masterSpreadsheetId,
        masterName: params.masterName,
        masterTab: params.masterTab,
        sourceSpreadsheetId: record.sourceSpreadsheetId,
        sourceName: record.sourceSpreadsheetName,
        sourceTab: record.sourceTabName,
      },
      [record.change],
      { crossSheetDisagreement: record.crossSheetDisagreement }
    );
  }

  if (dedupedWrites.length === 0) {
    ctx.log({
      spreadsheet: params.masterName,
      type: 'pull_folder',
      message:
        conflictsLogged > 0
          ? `No cells were written. Logged ${conflictsLogged} disagreement(s) to the Conflict inbox.`
          : 'Nothing needed to be written.',
    });
    return {
      previewRunId: params.previewRunId,
      cellsWritten: 0,
      conflictsLogged,
      revertAvailable: false,
      nextStep:
        conflictsLogged > 0
          ? `${conflictsLogged} disagreement(s) are waiting in the Conflict inbox.`
          : 'Every selected captain sheet already matches the master.',
    };
  }

  if (dedupedWrites.length > MAX_PULL_FOLDER_CELLS) {
    throw new Error(
      `This run would write more than ${MAX_PULL_FOLDER_CELLS.toLocaleString()} cells. Select fewer captain sheets or run another batch.`
    );
  }

  const guarded = planGuardedCellWrites(
    masterGrid,
    dedupedWrites.map((change) => ({
      residentId: change.residentId,
      column: change.column,
      value: change.captainValue,
      policy: change.policy,
      fieldMeta: change.fieldMeta,
    }))
  );
  if (guarded.errors.length > 0) throw new Error(guarded.errors.join('; '));
  if (guarded.writes.length !== dedupedWrites.length) {
    throw new Error(
      `Only ${guarded.writes.length} of ${dedupedWrites.length} approved cell(s) still pass the write guard. Nothing was written. Run a fresh scan.`
    );
  }

  const insertSnapshots = db.transaction(() => {
    for (const write of guarded.writes) {
      const range = google.a1Range(params.masterTab, `${google.columnLetter(write.col - 1)}${write.row}`);
      db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, ?, ?, 'cell_update', ?, ?, ?, ?, ?)`,
        [
          ctx.runId,
          params.masterSpreadsheetId,
          params.masterName,
          params.masterTab,
          write.residentId,
          range,
          JSON.stringify(write.before ?? ''),
          JSON.stringify(write.after ?? ''),
          JSON.stringify({ kind: 'pull_folder', column: write.column, previewRunId: params.previewRunId }),
        ]
      );
    }
  });
  insertSnapshots();

  ctx.reportProgress({
    stage: 'writing',
    message: `Writing ${guarded.writes.length.toLocaleString()} captain value(s) to ${params.masterName}.`,
  });
  await google.updateValuesChunked(
    params.masterSpreadsheetId,
    guarded.writes.map((write) => ({
      range: google.a1Range(params.masterTab, `${google.columnLetter(write.col - 1)}${write.row}`),
      values: [[write.after]],
    }))
  );

  for (const write of guarded.writes) {
    ctx.log({
      spreadsheet: params.masterName,
      row: write.row,
      column: write.column,
      resident_id: write.residentId,
      type: write.action === 'overwrite' ? 'overwrite' : 'fill',
      message: `Pulled ${write.column} from captain sheets into the master.`,
    });
  }

  return {
    previewRunId: params.previewRunId,
    cellsWritten: guarded.writes.length,
    residentsTouched: new Set(guarded.writes.map((write) => write.residentId)).size,
    conflictsLogged,
    revertAvailable: guarded.writes.length > 0,
    nextStep:
      conflictsLogged > 0
        ? `Wrote ${guarded.writes.length.toLocaleString()} cell(s) to the master. ${conflictsLogged} disagreement(s) were logged to the Conflict inbox.`
        : `Wrote ${guarded.writes.length.toLocaleString()} cell(s) to the master.`,
  };
}

function dedupeWrites<T extends { residentId: string; column: string; captainValue: unknown }>(writes: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const write of writes) {
    const key = `${write.residentId}\u0000${write.column}`;
    if (!byKey.has(key)) byKey.set(key, write);
  }
  return [...byKey.values()];
}

function parseCaptainPullParams(raw: Record<string, unknown>): CaptainPullParams {
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
  const sheets = Array.isArray(raw.sheets) ? (raw.sheets as PullFolderSheetPlan[]) : [];
  if (
    !Number.isInteger(previewRunId) ||
    previewRunId <= 0 ||
    !masterSpreadsheetId ||
    !masterTab ||
    !folderId ||
    !expectedFingerprint ||
    !dictionaryFingerprint
  ) {
    throw new Error('The approved captain pull plan is incomplete.');
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

async function readGrid(spreadsheetId: string, tabName: string): Promise<Grid> {
  return (await google.readValues(spreadsheetId, tabName ? google.a1Range(tabName, 'A:ZZ') : 'A:ZZ')) as Grid;
}

function requireLive(ctx: JobContext): void {
  if (ctx.mode !== 'live') throw new Error('Captain pull tasks require live mode.');
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

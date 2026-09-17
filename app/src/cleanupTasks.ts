import type { sheets_v4 } from 'googleapis';
import * as db from './db';
import * as google from './google';
import { registerTask, type JobContext } from './jobs';
import {
  cleanupInputFingerprint,
  planFolderCleanup,
  type CleanupCell,
  type CleanupCellChange,
  type CleanupSheet,
  type CleanupSheetPlan,
} from './lib/folderCleanupEngine';

export const FOLDER_CLEANUP_TASK = 'folder_wide_cleanup';
export const REVERT_FOLDER_CLEANUP_TASK = 'revert_folder_wide_cleanup';

interface CleanupParams {
  masterSpreadsheetId: string;
  masterName: string;
  masterTab: string;
  folderId: string;
  fingerprint: string;
}

export interface CleanupSnapshot {
  version: 1;
  folderId: string;
  role: 'master' | 'captain';
  rowCount: number;
  columnCount: number;
  headersBefore: string[];
  headersAfter: string[];
  deleted: Array<{
    header: string;
    index: number;
    cells: CleanupCell[];
    dimensionProperties?: Record<string, unknown>;
  }>;
  booleans: Array<{ row: number; colIndex: number; before: CleanupCell; afterValue: unknown }>;
  unit: null | {
    colIndex: number;
    before: CleanupCell[];
    changes: Array<{ row: number; afterValue: unknown }>;
    expectedAfter?: unknown[];
  };
  noteText?: Array<{
    column: string;
    colIndex: number;
    before: CleanupCell[];
    changes: Array<{ row: number; afterValue: unknown }>;
    expectedAfter: unknown[];
  }>;
}

interface CleanupSnapshotRow {
  id: number;
  spreadsheet_id: string;
  spreadsheet_name: string;
  tab_name: string;
  sheet_id: number;
  folder_id: string;
  before_json: string;
  after_json: string;
}

export function registerCleanupTasks(): void {
  registerTask(FOLDER_CLEANUP_TASK, executeFolderCleanup);
  registerTask(REVERT_FOLDER_CLEANUP_TASK, revertFolderCleanup);
}

async function executeFolderCleanup(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const params = cleanupParams(ctx.params);
  const files = await google.listSpreadsheetsInFolder(params.folderId);
  if (files.some((file) => file.id === params.masterSpreadsheetId)) {
    throw new Error('The master spreadsheet cannot also be inside the captain folder.');
  }
  const captains = await readCaptains(files);
  const master = await google.readCleanupSheet(params.masterSpreadsheetId, params.masterTab, params.masterName);
  const fresh = planFolderCleanup(master, captains);
  if (fresh.fingerprint !== params.fingerprint) {
    throw new Error('The master or captain folder changed after preview. Nothing was written; run a fresh cleanup preview.');
  }
  if (!fresh.canApply) throw new Error('The live re-read found cleanup blocks. Nothing was written.');

  let sheetsChanged = 0;
  let columnsDeleted = 0;
  let booleansStandardized = 0;
  let unitsRepaired = 0;
  let noteFormulasNeutralized = 0;
  let noteColumnsFormatted = 0;
  const ordered = fresh.sheets.filter((sheet) => sheet.canApply);
  for (let index = 0; index < ordered.length; index++) {
    ctx.assertLease();
    const plan = ordered[index];
    if (plan.role === 'captain') await assertFolderMember(params.folderId, plan.spreadsheetId);
    const current = await google.readCleanupSheet(
      plan.spreadsheetId,
      plan.tabName,
      plan.spreadsheetName
    );
    if (cleanupInputFingerprint(current) !== plan.inputFingerprint) {
      throw new Error(
        `${plan.spreadsheetName} changed while cleanup was running. It was not modified; run a fresh preview.`
      );
    }
    const snapshot = buildSnapshot(current, plan, params.folderId);
    const requests = applyRequests(plan, current.rowCount);
    db.run(
      `INSERT INTO cleanup_sheet_snapshots
         (run_id, spreadsheet_id, spreadsheet_name, tab_name, sheet_id, folder_id, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.runId,
        plan.spreadsheetId,
        plan.spreadsheetName,
        plan.tabName,
        plan.sheetId,
        params.folderId,
        JSON.stringify(snapshot),
        JSON.stringify({ headersAfter: plan.headersAfter, fingerprint: plan.fingerprint }),
      ]
    );
    ctx.reportProgress({
      stage: 'writing',
      message: `Cleaning ${index + 1} of ${ordered.length}: ${plan.spreadsheetName}`,
    });
    try {
      await google.batchUpdateSpreadsheet(plan.spreadsheetId, requests);
    } catch (error) {
      // A timeout can be ambiguous. Re-read the complete target and accept it
      // only if every expected postcondition landed atomically.
      const reconciled = await google.readCleanupSheet(plan.spreadsheetId, plan.tabName, plan.spreadsheetName);
      const problem = postconditionProblem(reconciled, plan);
      if (problem) {
        throw new Error(
          `Google did not confirm cleanup for ${plan.spreadsheetName}, and reconciliation failed: ${problem}. ` +
          `The saved snapshot remains available for Undo. Original error: ${friendly(error)}`
        );
      }
    }
    sheetsChanged++;
    columnsDeleted += plan.deleteColumns.length;
    booleansStandardized += plan.booleanChanges.length;
    unitsRepaired += plan.unitChanges.length;
    noteFormulasNeutralized += plan.noteFormulaChanges.length;
    noteColumnsFormatted += plan.formatTextColumns.length;
    ctx.log({
      spreadsheet: plan.spreadsheetName,
      type: 'cleanup',
      message:
        `${plan.deleteColumns.length} column(s) removed; ${plan.booleanChanges.length} boolean(s) standardized; ` +
        `${plan.unitChanges.length} unit value(s) repaired; ${plan.noteFormulaChanges.length} note formula(s) made literal; ` +
        `${plan.formatTextColumns.length} note column(s) formatted as plain text.`,
    });
  }
  return {
    sheetsChanged,
    columnsDeleted,
    booleansStandardized,
    unitsRepaired,
    unitColumnsFormatted: ordered.filter((sheet) => sheet.formatUnitColumn !== null).length,
    noteFormulasNeutralized,
    noteColumnsFormatted,
  };
}

async function revertFolderCleanup(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const originalRunId = positiveNumber(ctx.params.originalRunId, 'originalRunId');
  const snapshots = db.all<CleanupSnapshotRow>(
    `SELECT id, spreadsheet_id, spreadsheet_name, tab_name, sheet_id, folder_id, before_json, after_json
     FROM cleanup_sheet_snapshots
     WHERE run_id=? AND reverted_by_run_id IS NULL
     ORDER BY CASE WHEN spreadsheet_id=(SELECT json_extract(progress_json, '$.params.masterSpreadsheetId')
                       FROM jobs WHERE run_id=? LIMIT 1) THEN 0 ELSE 1 END,
              spreadsheet_name, spreadsheet_id`,
    [originalRunId, originalRunId]
  );
  let restoredSheets = 0;
  let blockedSheets = 0;
  for (const row of snapshots) {
    ctx.assertLease();
    const snapshot = parseSnapshot(row.before_json);
    if (snapshot.role === 'captain') await assertFolderMember(row.folder_id, row.spreadsheet_id);
    const current = await google.readCleanupSheet(row.spreadsheet_id, row.tab_name, row.spreadsheet_name);
    const problem = undoSafetyProblem(current, snapshot);
    if (problem) {
      blockedSheets++;
      ctx.log({ spreadsheet: row.spreadsheet_name, type: 'conflict', message: `Undo skipped this sheet: ${problem}` });
      continue;
    }
    const requests = undoRequests(snapshot, row.sheet_id);
    ctx.reportProgress({ stage: 'undoing', message: `Restoring ${row.spreadsheet_name}` });
    try {
      await google.batchUpdateSpreadsheet(row.spreadsheet_id, requests);
    } catch (error) {
      const reread = await google.readCleanupSheet(row.spreadsheet_id, row.tab_name, row.spreadsheet_name);
      if (!sameHeaders(headers(reread), snapshot.headersBefore)) {
        throw new Error(`Undo reconciliation failed for ${row.spreadsheet_name}: ${friendly(error)}`);
      }
    }
    db.run('UPDATE cleanup_sheet_snapshots SET reverted_by_run_id=? WHERE id=?', [ctx.runId, row.id]);
    restoredSheets++;
    ctx.log({ spreadsheet: row.spreadsheet_name, type: 'undo', message: 'Cleanup schema and retained values restored.' });
  }
  return { restoredSheets, blockedSheets };
}

export function applyRequests(plan: CleanupSheetPlan, rowCount: number): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = [];
  for (const change of [...plan.booleanChanges, ...plan.unitChanges, ...plan.noteFormulaChanges].sort(changeOrder)) {
    const cell: sheets_v4.Schema$CellData = { userEnteredValue: extendedValue(change.afterValue) };
    let fields = 'userEnteredValue';
    if (change.removeBooleanValidation) {
      (cell as unknown as Record<string, unknown>).dataValidation = null;
      fields += ',dataValidation';
    }
    requests.push({
      updateCells: {
        range: {
          sheetId: plan.sheetId,
          startRowIndex: change.row - 1,
          endRowIndex: change.row,
          startColumnIndex: change.colIndex,
          endColumnIndex: change.colIndex + 1,
        },
        rows: [{ values: [cell] }],
        fields,
      },
    });
  }
  if (plan.formatUnitColumn !== null) {
    requests.push({
      repeatCell: {
        range: {
          sheetId: plan.sheetId,
          startRowIndex: 0,
          endRowIndex: rowCount,
          startColumnIndex: plan.formatUnitColumn,
          endColumnIndex: plan.formatUnitColumn + 1,
        },
        cell: { userEnteredFormat: { numberFormat: { type: 'TEXT', pattern: '@' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }
  for (const column of plan.formatTextColumns) {
    requests.push({
      repeatCell: {
        range: {
          sheetId: plan.sheetId,
          startRowIndex: 0,
          endRowIndex: rowCount,
          startColumnIndex: column.colIndex,
          endColumnIndex: column.colIndex + 1,
        },
        cell: { userEnteredFormat: { numberFormat: { type: 'TEXT', pattern: '@' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    });
  }
  for (const column of plan.deleteColumns) {
    requests.push({
      deleteDimension: {
        range: {
          sheetId: plan.sheetId,
          dimension: 'COLUMNS',
          startIndex: column.index,
          endIndex: column.index + 1,
        },
      },
    });
  }
  return requests;
}

function buildSnapshot(sheet: CleanupSheet, plan: CleanupSheetPlan, folderId: string): CleanupSnapshot {
  const column = (index: number) =>
    Array.from({ length: sheet.rowCount }, (_unused, row) => cloneCell(sheet.cells[row]?.[index]));
  return {
    version: 1,
    folderId,
    role: plan.role,
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
    headersBefore: plan.headersBefore,
    headersAfter: plan.headersAfter,
    deleted: [...plan.deleteColumns]
      .sort((a, b) => a.index - b.index)
      .map((item) => ({
        ...item,
        cells: column(item.index),
        dimensionProperties: sheet.columnMetadata?.[item.index],
      })),
    booleans: plan.booleanChanges.map((change) => ({
      row: change.row,
      colIndex: change.colIndex,
      before: cloneCell(change.before),
      afterValue: change.afterValue,
    })),
    unit: plan.formatUnitColumn === null
      ? null
      : {
          colIndex: plan.formatUnitColumn,
          before: column(plan.formatUnitColumn),
          changes: plan.unitChanges.map((change) => ({ row: change.row, afterValue: change.afterValue })),
          expectedAfter: Array.from({ length: sheet.rowCount }, (_unused, row) => {
            const changed = plan.unitChanges.find((change) => change.row === row + 1);
            return changed ? changed.afterValue : primitive(sheet.cells[row]?.[plan.formatUnitColumn!] || {});
          }),
        },
    noteText: plan.formatTextColumns.map((field) => ({
      ...field,
      before: column(field.colIndex),
      changes: plan.noteFormulaChanges
        .filter((change) => change.colIndex === field.colIndex)
        .map((change) => ({ row: change.row, afterValue: change.afterValue })),
      expectedAfter: Array.from({ length: sheet.rowCount }, (_unused, row) => {
        const changed = plan.noteFormulaChanges.find(
          (change) => change.colIndex === field.colIndex && change.row === row + 1
        );
        return changed ? changed.afterValue : primitive(sheet.cells[row]?.[field.colIndex] || {});
      }),
    })),
  };
}

export function undoSafetyProblem(current: CleanupSheet, snapshot: CleanupSnapshot): string | null {
  if (!sameHeaders(headers(current), snapshot.headersAfter)) return 'columns no longer match the cleanup result';
  if (snapshot.deleted.length > 0 && (current.dependencies || []).length > 0) {
    return 'new structural dependencies exist, so deleted columns cannot be safely reinserted';
  }
  for (const change of snapshot.booleans) {
    const currentCell = current.cells[change.row - 1]?.[postIndex(change.colIndex, snapshot.deleted)] || {};
    if (primitive(currentCell) !== change.afterValue || booleanValidation(currentCell)) {
      return `an approved boolean cell changed after cleanup (row ${change.row})`;
    }
  }
  if (snapshot.unit) {
    const index = postIndex(snapshot.unit.colIndex, snapshot.deleted);
    const expectedAfter = snapshot.unit.expectedAfter || snapshot.unit.before.map((cell, row) => {
      const changed = snapshot.unit!.changes.find((change) => change.row === row + 1);
      return changed ? changed.afterValue : primitive(cell);
    });
    for (let row = 0; row < expectedAfter.length; row++) {
      if (primitive(current.cells[row]?.[index] || {}) !== expectedAfter[row]) {
        return `a unit cell changed after cleanup (row ${row + 1})`;
      }
    }
    for (let row = 0; row < Math.min(snapshot.rowCount, current.rowCount); row++) {
      if (String(current.cells[row]?.[index]?.numberFormat?.type || '').toUpperCase() !== 'TEXT') {
        return '_SitusUnit no longer has the cleanup TEXT format';
      }
    }
  }
  for (const note of snapshot.noteText || []) {
    const index = postIndex(note.colIndex, snapshot.deleted);
    for (let row = 0; row < note.expectedAfter.length; row++) {
      if (primitive(current.cells[row]?.[index] || {}) !== note.expectedAfter[row]) {
        return `${note.column} changed after cleanup (row ${row + 1})`;
      }
      if (String(current.cells[row]?.[index]?.numberFormat?.type || '').toUpperCase() !== 'TEXT') {
        return `${note.column} no longer has the cleanup plain-text format`;
      }
    }
  }
  return null;
}

function postconditionProblem(current: CleanupSheet, plan: CleanupSheetPlan): string | null {
  if (!sameHeaders(headers(current), plan.headersAfter)) return 'headers do not match the atomic cleanup result';
  for (const change of plan.booleanChanges) {
    const index = postIndex(change.colIndex, plan.deleteColumns);
    const cell = current.cells[change.row - 1]?.[index] || {};
    if (primitive(cell) !== change.afterValue || (change.removeBooleanValidation && booleanValidation(cell))) {
      return `boolean postcondition failed at row ${change.row}`;
    }
  }
  for (const change of plan.unitChanges) {
    const index = postIndex(change.colIndex, plan.deleteColumns);
    if (primitive(current.cells[change.row - 1]?.[index] || {}) !== change.afterValue) {
      return `unit postcondition failed at row ${change.row}`;
    }
  }
  if (plan.formatUnitColumn !== null) {
    const index = postIndex(plan.formatUnitColumn, plan.deleteColumns);
    for (let row = 0; row < current.rowCount; row++) {
      if (String(current.cells[row]?.[index]?.numberFormat?.type || '').toUpperCase() !== 'TEXT') {
        return '_SitusUnit TEXT-format postcondition failed';
      }
    }
  }
  for (const change of plan.noteFormulaChanges) {
    const index = postIndex(change.colIndex, plan.deleteColumns);
    if (primitive(current.cells[change.row - 1]?.[index] || {}) !== change.afterValue) {
      return `note postcondition failed at row ${change.row}, column ${change.column}`;
    }
  }
  for (const note of plan.formatTextColumns) {
    const index = postIndex(note.colIndex, plan.deleteColumns);
    for (let row = 0; row < current.rowCount; row++) {
      if (String(current.cells[row]?.[index]?.numberFormat?.type || '').toUpperCase() !== 'TEXT') {
        return `${note.column} plain-text postcondition failed`;
      }
    }
  }
  return null;
}

export function undoRequests(snapshot: CleanupSnapshot, sheetId: number): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = [];
  for (const deleted of snapshot.deleted) {
    requests.push({
      insertDimension: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: deleted.index, endIndex: deleted.index + 1 },
        inheritFromBefore: deleted.index > 0,
      },
    });
    if (deleted.dimensionProperties) {
      requests.push({
        updateDimensionProperties: {
          range: {
            sheetId,
            dimension: 'COLUMNS',
            startIndex: deleted.index,
            endIndex: deleted.index + 1,
          },
          properties: deleted.dimensionProperties as sheets_v4.Schema$DimensionProperties,
          fields: 'pixelSize,hiddenByUser',
        },
      });
    }
    requests.push({
      updateCells: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: snapshot.rowCount,
          startColumnIndex: deleted.index,
          endColumnIndex: deleted.index + 1,
        },
        rows: deleted.cells.map((cell) => ({ values: [sheetCellData(cell)] })),
        fields: 'userEnteredValue,userEnteredFormat,dataValidation,note',
      },
    });
  }
  for (const change of snapshot.booleans) {
    requests.push({
      updateCells: {
        range: {
          sheetId,
          startRowIndex: change.row - 1,
          endRowIndex: change.row,
          startColumnIndex: change.colIndex,
          endColumnIndex: change.colIndex + 1,
        },
        rows: [{ values: [sheetCellData(change.before)] }],
        fields: 'userEnteredValue,dataValidation',
      },
    });
  }
  if (snapshot.unit) {
    requests.push({
      updateCells: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: snapshot.rowCount,
          startColumnIndex: snapshot.unit.colIndex,
          endColumnIndex: snapshot.unit.colIndex + 1,
        },
        rows: snapshot.unit.before.map((cell) => ({ values: [sheetCellData(cell)] })),
        fields: 'userEnteredFormat.numberFormat',
      },
    });
    for (const change of snapshot.unit.changes) {
      requests.push({
        updateCells: {
          range: {
            sheetId,
            startRowIndex: change.row - 1,
            endRowIndex: change.row,
            startColumnIndex: snapshot.unit.colIndex,
            endColumnIndex: snapshot.unit.colIndex + 1,
          },
          rows: [{ values: [sheetCellData(snapshot.unit.before[change.row - 1] || {})] }],
          fields: 'userEnteredValue',
        },
      });
    }
  }
  for (const note of snapshot.noteText || []) {
    requests.push({
      updateCells: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: snapshot.rowCount,
          startColumnIndex: note.colIndex,
          endColumnIndex: note.colIndex + 1,
        },
        rows: note.before.map((cell) => ({ values: [sheetCellData(cell)] })),
        fields: 'userEnteredFormat.numberFormat',
      },
    });
    for (const change of note.changes) {
      requests.push({
        updateCells: {
          range: {
            sheetId,
            startRowIndex: change.row - 1,
            endRowIndex: change.row,
            startColumnIndex: note.colIndex,
            endColumnIndex: note.colIndex + 1,
          },
          rows: [{ values: [sheetCellData(note.before[change.row - 1] || {})] }],
          fields: 'userEnteredValue',
        },
      });
    }
  }
  return requests;
}

async function readCaptains(files: google.SpreadsheetFile[]): Promise<CleanupSheet[]> {
  const result: CleanupSheet[] = [];
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
    result.push(await google.readCleanupSheet(file.id, undefined, file.name));
  }
  return result;
}

async function assertFolderMember(folderId: string, spreadsheetId: string): Promise<void> {
  const members = await google.listSpreadsheetsInFolder(folderId);
  if (!members.some((file) => file.id === spreadsheetId)) {
    throw new Error('A captain spreadsheet left the configured folder. Cleanup stopped before changing it.');
  }
}

function cleanupParams(raw: Record<string, unknown>): CleanupParams {
  const params: CleanupParams = {
    masterSpreadsheetId: String(raw.masterSpreadsheetId || ''),
    masterName: String(raw.masterName || ''),
    masterTab: String(raw.masterTab || ''),
    folderId: String(raw.folderId || ''),
    fingerprint: String(raw.fingerprint || ''),
  };
  if (!params.masterSpreadsheetId || !params.masterTab || !params.folderId || !params.fingerprint) {
    throw new Error('Cleanup task parameters are incomplete.');
  }
  return params;
}

function parseSnapshot(value: string): CleanupSnapshot {
  const parsed = JSON.parse(value) as CleanupSnapshot;
  if (parsed.version !== 1 || !Array.isArray(parsed.headersBefore) || !Array.isArray(parsed.deleted)) {
    throw new Error('Cleanup snapshot is invalid or unsupported.');
  }
  return parsed;
}

function sheetCellData(cell: CleanupCell): sheets_v4.Schema$CellData {
  return {
    userEnteredValue: cell.userEnteredValue && typeof cell.userEnteredValue === 'object'
      ? { formulaValue: cell.userEnteredValue.formulaValue }
      : extendedValue(cell.userEnteredValue),
    // Materialize effective formatting when restoring a deleted column. This
    // preserves inherited visual/number formatting even though reinsertion may
    // otherwise inherit from a different neighboring column.
    userEnteredFormat: cell.effectiveFormat || cell.userEnteredFormat || null,
    dataValidation: cell.dataValidation || null,
    note: cell.note || null,
  } as sheets_v4.Schema$CellData;
}

function extendedValue(value: unknown): sheets_v4.Schema$ExtendedValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return { numberValue: value };
  if (value == null) return {};
  return { stringValue: String(value) };
}

function headers(sheet: CleanupSheet): string[] {
  const width = Math.max(sheet.cells[0]?.length || 0, sheet.columnCount);
  return Array.from({ length: width }, (_unused, index) => String(primitive(sheet.cells[0]?.[index] || {}) ?? '').trim());
}

function primitive(cell: CleanupCell): unknown {
  const value = cell.userEnteredValue;
  if (value !== undefined && (value === null || typeof value !== 'object')) return value;
  return cell.effectiveValue ?? null;
}

function booleanValidation(cell: CleanupCell): boolean {
  const validation = cell.dataValidation as { condition?: { type?: string } } | undefined;
  return String(validation?.condition?.type || '').toUpperCase() === 'BOOLEAN';
}

function postIndex(originalIndex: number, deleted: Array<{ index: number }>): number {
  return originalIndex - deleted.filter((item) => item.index < originalIndex).length;
}

function cloneCell(cell?: CleanupCell): CleanupCell {
  return cell ? JSON.parse(JSON.stringify(cell)) : {};
}

function sameHeaders(left: string[], right: string[]): boolean {
  const trim = (items: string[]) => {
    const copy = [...items];
    while (copy.length && copy[copy.length - 1] === '') copy.pop();
    return copy;
  };
  return JSON.stringify(trim(left)) === JSON.stringify(trim(right));
}

function changeOrder(a: CleanupCellChange, b: CleanupCellChange): number {
  return a.row - b.row || a.colIndex - b.colIndex;
}

function positiveNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer.`);
  return number;
}

function requireLive(ctx: JobContext): void {
  if (ctx.mode !== 'live') throw new Error('Folder cleanup tasks require live mode.');
}

function friendly(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

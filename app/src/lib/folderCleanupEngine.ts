import { createHash } from 'node:crypto';

export const LEGACY_ADDRESS_COLUMNS = ['House', 'Street'] as const;
export const RETIRED_SALES_COLUMNS = [
  'Address - For Sale',
  'Address - Sold Since Fire',
  'Latest Sale Date',
  'Latest Sale Price',
  'Latest New Owner',
  'Lot SqFt',
  'Sales History',
] as const;
export const BOOLEAN_COLUMNS = [
  'Wants_Updates',
  'Former Resident',
  'Deceased',
  'Person - Needs Follow-Up',
  'Person - Unable to Reach',
  'Person - Renter',
  'Successfully Contacted',
] as const;

export type Primitive = string | number | boolean | null;

export interface CleanupCell {
  userEnteredValue?: Primitive | { formulaValue: string };
  effectiveValue?: Primitive;
  formattedValue?: string;
  numberFormat?: { type?: string; pattern?: string };
  dataValidation?: unknown;
  userEnteredFormat?: Record<string, unknown>;
  effectiveFormat?: Record<string, unknown>;
  note?: string;
}

export interface CleanupSheet {
  spreadsheetId: string;
  spreadsheetName: string;
  tabName: string;
  sheetId: number;
  rowCount: number;
  columnCount: number;
  cells: CleanupCell[][];
  columnMetadata?: Array<Record<string, unknown>>;
  dependencies?: CleanupDependency[];
}

export interface CleanupDependency {
  kind: string;
  detail: string;
  startColumn: number;
  endColumn: number;
}

export interface CleanupBlock {
  code: string;
  message: string;
  row?: number;
  column?: string;
}

export interface CleanupCellChange {
  row: number;
  column: string;
  colIndex: number;
  before: CleanupCell;
  afterValue: Primitive;
  removeBooleanValidation?: boolean;
}

export interface CleanupSheetPlan {
  spreadsheetId: string;
  spreadsheetName: string;
  tabName: string;
  sheetId: number;
  role: 'master' | 'captain';
  headersBefore: string[];
  headersAfter: string[];
  deleteColumns: Array<{ header: string; index: number }>;
  booleanChanges: CleanupCellChange[];
  unitChanges: CleanupCellChange[];
  formatUnitColumn: number | null;
  blocks: CleanupBlock[];
  canApply: boolean;
  inputFingerprint: string;
  fingerprint: string;
}

export interface FolderCleanupPlan {
  sheets: CleanupSheetPlan[];
  fingerprint: string;
  canApply: boolean;
  totals: {
    sheets: number;
    sheetsChanging: number;
    columnsDeleted: number;
    booleansStandardized: number;
    unitsRepaired: number;
    unitColumnsFormatted: number;
    blocks: number;
  };
}

interface UnitAuthority {
  value: string;
  blocked?: string;
}

export function planFolderCleanup(master: CleanupSheet, captains: CleanupSheet[]): FolderCleanupPlan {
  const authority = buildUnitAuthority(master);
  const sheets = [
    planSheet(master, 'master', authority),
    ...[...captains]
      .sort((a, b) => a.spreadsheetName.localeCompare(b.spreadsheetName) || a.spreadsheetId.localeCompare(b.spreadsheetId))
      .map((sheet) => planSheet(sheet, 'captain', authority)),
  ];
  const payload = sheets.map(fingerprintSheetPayload);
  const fingerprint = hash(payload);
  const totals = {
    sheets: sheets.length,
    sheetsChanging: sheets.filter(hasChanges).length,
    columnsDeleted: sum(sheets, (sheet) => sheet.deleteColumns.length),
    booleansStandardized: sum(sheets, (sheet) => sheet.booleanChanges.length),
    unitsRepaired: sum(sheets, (sheet) => sheet.unitChanges.length),
    unitColumnsFormatted: sheets.filter((sheet) => sheet.formatUnitColumn !== null).length,
    blocks: sum(sheets, (sheet) => sheet.blocks.length),
  };
  return { sheets, fingerprint, canApply: totals.blocks === 0 && totals.sheetsChanging > 0, totals };
}

function planSheet(
  sheet: CleanupSheet,
  role: 'master' | 'captain',
  authority: Map<string, UnitAuthority>
): CleanupSheetPlan {
  const headers = headersFor(sheet);
  const blocks: CleanupBlock[] = [];
  const duplicates = duplicateHeaders(headers);
  for (const header of duplicates) {
    blocks.push({ code: 'duplicate_header', message: `Duplicate exact header "${header}" makes cleanup ambiguous.`, column: header });
  }
  const deleteNames = role === 'master'
    ? [...LEGACY_ADDRESS_COLUMNS]
    : [...LEGACY_ADDRESS_COLUMNS, ...RETIRED_SALES_COLUMNS];
  const deleteColumns = deleteNames
    .map((header) => ({ header, index: headers.indexOf(header) }))
    .filter((item) => item.index >= 0 && !duplicates.includes(item.header));

  if (deleteColumns.some((item) => LEGACY_ADDRESS_COLUMNS.includes(item.header as typeof LEGACY_ADDRESS_COLUMNS[number]))) {
    const house = headers.indexOf('_SitusHouseNo');
    const street = headers.indexOf('_SitusStreet');
    if (house < 0 || street < 0) {
      blocks.push({
        code: 'missing_canonical_address',
        message: 'House/Street cannot be removed until both _SitusHouseNo and _SitusStreet exist.',
      });
    } else {
      for (let r = 1; r < sheet.cells.length; r++) {
        if (!eligibleRow(sheet.cells[r])) continue;
        if (cellText(sheet.cells[r]?.[house]) === '' || cellText(sheet.cells[r]?.[street]) === '') {
          blocks.push({
            code: 'blank_canonical_address',
            message: 'An eligible row has a blank canonical house or street value.',
            row: r + 1,
          });
        }
      }
    }
  }

  const deletedIndexes = new Set(deleteColumns.map((column) => column.index));
  for (const dependency of sheet.dependencies || []) {
    // Even a range outside the deleted column may shift when columns are
    // reinserted. Unless the workflow snapshots that dependency's own schema,
    // refuse structural deletion rather than promise an incomplete Undo.
    if (deleteColumns.length > 0) {
      blocks.push({
        code: 'structural_dependency',
        message: `${dependency.kind} prevents a safely restorable column deletion: ${dependency.detail}`,
      });
    }
  }

  const booleanChanges: CleanupCellChange[] = [];
  for (const column of BOOLEAN_COLUMNS) {
    const colIndex = headers.indexOf(column);
    if (colIndex < 0 || duplicates.includes(column)) continue;
    for (let r = 1; r < sheet.cells.length; r++) {
      if (!eligibleRow(sheet.cells[r])) continue;
      const before = sheet.cells[r]?.[colIndex] || {};
      const standardized = standardBoolean(before);
      if (!standardized.ok) {
        blocks.push({ code: 'invalid_boolean', message: standardized.block, row: r + 1, column });
      } else if (standardized.value !== currentPrimitive(before) || checkboxValidation(before)) {
        booleanChanges.push({
          row: r + 1,
          column,
          colIndex,
          before,
          afterValue: standardized.value,
          removeBooleanValidation: checkboxValidation(before),
        });
      }
    }
  }

  const unitChanges: CleanupCellChange[] = [];
  const unitIndex = headers.indexOf('_SitusUnit');
  const addressIndex = headers.indexOf('address_id');
  if (unitIndex < 0) {
    blocks.push({ code: 'missing_unit', message: 'The sheet has no exact _SitusUnit column to audit and format.' });
  } else if (duplicates.includes('_SitusUnit')) {
    blocks.push({ code: 'duplicate_unit', message: 'Duplicate _SitusUnit columns are ambiguous.', column: '_SitusUnit' });
  } else if (unitIndex >= 0) {
    if (addressIndex < 0 || duplicates.includes('address_id')) {
      blocks.push({ code: 'missing_address_id', message: '_SitusUnit cannot be audited without one exact address_id column.' });
    } else {
      for (let r = 1; r < sheet.cells.length; r++) {
        if (!eligibleRow(sheet.cells[r])) continue;
        const addressId = cellText(sheet.cells[r]?.[addressIndex]);
        if (!addressId) {
          blocks.push({ code: 'blank_address_id', message: 'An eligible row has no address_id for unit reconciliation.', row: r + 1 });
          continue;
        }
        const masterUnit = authority.get(addressId);
        if (!masterUnit) {
          blocks.push({ code: 'unit_authority_missing', message: 'No master unit authority exists for this address_id.', row: r + 1 });
          continue;
        }
        if (masterUnit.blocked) {
          blocks.push({ code: 'unit_authority_blocked', message: masterUnit.blocked, row: r + 1, column: '_SitusUnit' });
          continue;
        }
        const before = sheet.cells[r]?.[unitIndex] || {};
        if (role === 'master') {
          const issue = unsafeUnit(before);
          if (issue) blocks.push({ code: 'unsafe_master_unit', message: issue, row: r + 1, column: '_SitusUnit' });
          else if (typeof currentPrimitive(before) === 'number') {
            unitChanges.push({
              row: r + 1,
              column: '_SitusUnit',
              colIndex: unitIndex,
              before,
              afterValue: unitText(before),
            });
          }
        } else if (masterUnit.value === '' && unitText(before) !== '') {
          blocks.push({
            code: 'blank_unit_authority',
            message: 'Master _SitusUnit is blank, so a populated captain unit cannot be cleared automatically.',
            row: r + 1,
            column: '_SitusUnit',
          });
        } else if (unitText(before) !== masterUnit.value || typeof currentPrimitive(before) !== 'string') {
          unitChanges.push({ row: r + 1, column: '_SitusUnit', colIndex: unitIndex, before, afterValue: masterUnit.value });
        }
      }
    }
  }

  const headersAfter = headers.filter((_header, index) => !deletedIndexes.has(index));
  const draft: CleanupSheetPlan = {
    spreadsheetId: sheet.spreadsheetId,
    spreadsheetName: sheet.spreadsheetName,
    tabName: sheet.tabName,
    sheetId: sheet.sheetId,
    role,
    headersBefore: headers,
    headersAfter,
    deleteColumns: deleteColumns.sort((a, b) => b.index - a.index),
    booleanChanges,
    unitChanges,
    formatUnitColumn: unitIndex >= 0 && !duplicates.includes('_SitusUnit') ? unitIndex : null,
    blocks: dedupeBlocks(blocks),
    canApply: false,
    inputFingerprint: relevantSheetFingerprint(sheet, headers),
    fingerprint: '',
  };
  draft.canApply = draft.blocks.length === 0 && hasChanges(draft);
  draft.fingerprint = hash(fingerprintSheetPayload(draft));
  return draft;
}

function buildUnitAuthority(master: CleanupSheet): Map<string, UnitAuthority> {
  const headers = headersFor(master);
  const addressIndex = headers.indexOf('address_id');
  const unitIndex = headers.indexOf('_SitusUnit');
  const result = new Map<string, UnitAuthority>();
  if (addressIndex < 0 || unitIndex < 0 || duplicateHeaders(headers).some((h) => h === 'address_id' || h === '_SitusUnit')) {
    return result;
  }
  for (let r = 1; r < master.cells.length; r++) {
    if (!eligibleRow(master.cells[r])) continue;
    const addressId = cellText(master.cells[r]?.[addressIndex]);
    if (!addressId) continue;
    const cell = master.cells[r]?.[unitIndex] || {};
    const issue = unsafeUnit(cell);
    const value = unitText(cell);
    const prior = result.get(addressId);
    if (issue) {
      result.set(addressId, { value, blocked: `Master _SitusUnit is unsafe for address_id at master row ${r + 1}: ${issue}` });
    } else if (prior && (prior.blocked || prior.value !== value)) {
      result.set(addressId, {
        value,
        blocked: `Master has ambiguous _SitusUnit values for one address_id (including row ${r + 1}).`,
      });
    } else {
      result.set(addressId, { value });
    }
  }
  return result;
}

function unsafeUnit(cell: CleanupCell): string | null {
  if (isFormula(cell)) return 'formulas are not accepted as unit authority';
  const type = String(cell.numberFormat?.type || '').toUpperCase();
  if (type.includes('DATE') || type.includes('TIME')) return 'the unit is date/time formatted and may be coerced';
  const raw = currentPrimitive(cell);
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string' || typeof raw === 'number') return null;
  return 'the master unit is not a text or numeric literal';
}

function standardBoolean(cell: CleanupCell): { ok: true; value: boolean } | { ok: false; block: string } {
  if (isFormula(cell)) return { ok: false, block: 'Formula-backed boolean values must be resolved before cleanup.' };
  const value = currentPrimitive(cell);
  if (value === true) return { ok: true, value: true };
  if (value === false || value == null || value === '') return { ok: true, value: false };
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return { ok: true, value: true };
    if (normalized === '' || normalized === 'false') return { ok: true, value: false };
  }
  return { ok: false, block: 'Only true, false, text true, text false, or blank can be standardized safely.' };
}

function checkboxValidation(cell: CleanupCell): boolean {
  const rule = cell.dataValidation as { condition?: { type?: string } } | undefined;
  return String(rule?.condition?.type || '').toUpperCase() === 'BOOLEAN';
}

function isFormula(cell: CleanupCell): boolean {
  return Boolean(cell.userEnteredValue && typeof cell.userEnteredValue === 'object' && 'formulaValue' in cell.userEnteredValue);
}

function currentPrimitive(cell: CleanupCell): Primitive {
  const raw = cell.userEnteredValue;
  if (raw !== undefined && (raw === null || typeof raw !== 'object')) return raw;
  return cell.effectiveValue ?? null;
}

function cellText(cell?: CleanupCell): string {
  if (!cell) return '';
  const value = currentPrimitive(cell);
  return value == null ? '' : String(value).trim();
}

function unitText(cell: CleanupCell): string {
  const raw = currentPrimitive(cell);
  if (raw == null) return '';
  if (typeof raw === 'number' && cell.formattedValue != null && cell.formattedValue.trim() !== '') {
    return cell.formattedValue.trim();
  }
  return String(raw).trim();
}

function eligibleRow(row?: CleanupCell[]): boolean {
  return Boolean(row?.some((cell) => cellText(cell) !== '' || isFormula(cell)));
}

function headersFor(sheet: CleanupSheet): string[] {
  const row = sheet.cells[0] || [];
  const width = Math.max(sheet.columnCount, row.length);
  return Array.from({ length: width }, (_unused, index) => cellText(row[index]));
}

function duplicateHeaders(headers: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const header of headers) {
    if (!header) continue;
    if (seen.has(header)) duplicate.add(header);
    seen.add(header);
  }
  return [...duplicate].sort();
}

function dedupeBlocks(blocks: CleanupBlock[]): CleanupBlock[] {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    const key = [block.code, block.message, block.row || '', block.column || ''].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasChanges(sheet: CleanupSheetPlan): boolean {
  return sheet.deleteColumns.length > 0 ||
    sheet.booleanChanges.length > 0 ||
    sheet.unitChanges.length > 0 ||
    sheet.formatUnitColumn !== null;
}

function fingerprintSheetPayload(sheet: CleanupSheetPlan): unknown {
  return {
    id: sheet.spreadsheetId,
    tab: sheet.tabName,
    role: sheet.role,
    headersBefore: sheet.headersBefore,
    headersAfter: sheet.headersAfter,
    deleteColumns: sheet.deleteColumns,
    booleans: sheet.booleanChanges.map((change) => [change.row, change.column, currentPrimitive(change.before), change.afterValue]),
    units: sheet.unitChanges.map((change) => [change.row, change.column, currentPrimitive(change.before), change.afterValue]),
    formatUnitColumn: sheet.formatUnitColumn,
    blocks: sheet.blocks,
    inputFingerprint: sheet.inputFingerprint,
  };
}

function relevantSheetFingerprint(sheet: CleanupSheet, headers: string[]): string {
  const relevant = new Set<string>([
    'address_id',
    '_SitusHouseNo',
    '_SitusStreet',
    '_SitusUnit',
    ...LEGACY_ADDRESS_COLUMNS,
    ...RETIRED_SALES_COLUMNS,
    ...BOOLEAN_COLUMNS,
  ]);
  const indexes = headers
    .map((header, index) => ({ header, index }))
    .filter((item) => relevant.has(item.header));
  return hash({
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
    headers,
    dependencies: sheet.dependencies || [],
    eligibleRows: sheet.cells.map((row) => eligibleRow(row)),
    cells: sheet.cells.map((row) =>
      indexes.map(({ header, index }) => [header, row?.[index] || {}])
    ),
  });
}

export function cleanupInputFingerprint(sheet: CleanupSheet): string {
  return relevantSheetFingerprint(sheet, headersFor(sheet));
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sum<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

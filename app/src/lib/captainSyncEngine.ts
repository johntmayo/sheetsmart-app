import { createHash } from 'node:crypto';
import {
  buildSourceLookup,
  planCellFill,
  planPushMissingResidents,
  trimHeaders,
  type CellFillResult,
  type Grid,
  type PushMissingResult,
} from './mergeEngine';
import { buildCellFillConfig, type DictField } from './previewEngine';
import type { IdentityCellProposal } from './liveWriteEngine';
import type { FieldMetaMap } from './values';

export interface CaptainSyncSheetRef {
  spreadsheetId: string;
  spreadsheetName: string;
  tabName: string;
  url: string;
}

export interface PushMissingSheetPlan extends CaptainSyncSheetRef {
  detectedZone: string;
  appended: Array<{ residentId: string; residentName: string }>;
  flagged: Array<{ residentId: string; residentName: string; flaggedColumns: string }>;
  skipped: number;
  errors: string[];
  sheetFingerprint: string;
}

export interface PushFieldsSheetPlan extends CaptainSyncSheetRef {
  filled: number;
  conflicts: number;
  overwritten: number;
  columnsToAdd: string[];
  errors: string[];
  sheetFingerprint: string;
}

function hashParts(parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? '')).digest('hex').slice(0, 16);
}

export function fingerprintPushMissingSheets(sheets: PushMissingSheetPlan[]): string {
  const parts = sheets
    .filter((sheet) => sheet.appended.length > 0)
    .map((sheet) => `${sheet.spreadsheetId}:${sheet.sheetFingerprint}`)
    .sort();
  return hashParts(parts);
}

export function fingerprintPushFieldsSheets(sheets: PushFieldsSheetPlan[]): string {
  const parts = sheets
    .filter((sheet) => sheet.filled + sheet.overwritten > 0 || sheet.columnsToAdd.length > 0)
    .map((sheet) => `${sheet.spreadsheetId}:${sheet.sheetFingerprint}`)
    .sort();
  return hashParts(parts);
}

export function fingerprintSelectedPushMissing(
  sheets: PushMissingSheetPlan[],
  spreadsheetIds: string[]
): string {
  const selected = new Set(spreadsheetIds);
  return fingerprintPushMissingSheets(sheets.filter((sheet) => selected.has(sheet.spreadsheetId)));
}

export function fingerprintSelectedPushFields(
  sheets: PushFieldsSheetPlan[],
  spreadsheetIds: string[]
): string {
  const selected = new Set(spreadsheetIds);
  return fingerprintPushFieldsSheets(sheets.filter((sheet) => selected.has(sheet.spreadsheetId)));
}

function pushMissingSheetFingerprint(spreadsheetId: string, plan: PushMissingResult): string {
  const parts = plan.appended
    .map((row) => `${spreadsheetId}:${row.residentId}:${row.masterRow}`)
    .sort();
  return hashParts(parts);
}

function pushFieldsSheetFingerprint(spreadsheetId: string, plan: CellFillResult): string {
  const parts = [
    ...plan.columnsToAdd.map((column) => `col:${column}`),
    ...plan.filled.map((entry) => `f:${entry.row}:${entry.column}:${hashValue(entry.newValue)}`),
    ...plan.overwritten.map((entry) => `o:${entry.row}:${entry.column}:${hashValue(entry.newValue)}`),
  ].sort();
  return hashParts([spreadsheetId, ...parts]);
}

export function cellFillProposals(
  targetGrid: Grid,
  plan: CellFillResult,
  fieldMeta: FieldMetaMap
): IdentityCellProposal[] {
  const headers = trimHeaders(targetGrid[0]);
  const idCol = headers.indexOf('resident_id');
  const proposals: IdentityCellProposal[] = [];
  for (const entry of [...plan.filled, ...plan.overwritten]) {
    const residentId = String(targetGrid[entry.row - 1]?.[idCol] ?? '').trim();
    if (!residentId) continue;
    proposals.push({
      residentId,
      column: entry.column,
      value: entry.newValue,
      policy: entry.policy,
      fieldMeta: fieldMeta[entry.column],
    });
  }
  return proposals;
}

export function planFolderPushMissing(
  masterGrid: Grid,
  captainSheets: Array<CaptainSyncSheetRef & { grid: Grid }>,
  options: {
    sensitiveColumns: string[];
    distributedColumns: string[];
  }
): PushMissingSheetPlan[] {
  return captainSheets.map((sheet) => {
    const plan = planPushMissingResidents(sheet.grid, masterGrid, {
      sensitiveColumns: options.sensitiveColumns,
      distributedColumns: options.distributedColumns,
    });
    return {
      spreadsheetId: sheet.spreadsheetId,
      spreadsheetName: sheet.spreadsheetName,
      tabName: sheet.tabName,
      url: sheet.url,
      detectedZone: plan.detectedZone,
      appended: plan.appended.map((row) => ({
        residentId: row.residentId,
        residentName: row.residentName,
      })),
      flagged: plan.flagged.map((row) => ({
        residentId: row.residentId,
        residentName: row.residentName,
        flaggedColumns: row.flaggedColumns,
      })),
      skipped: plan.skipped.length,
      errors: plan.errors.map((error) => error.message),
      sheetFingerprint: pushMissingSheetFingerprint(sheet.spreadsheetId, plan),
    };
  });
}

export function planFolderPushFields(
  masterGrid: Grid,
  captainSheets: Array<CaptainSyncSheetRef & { grid: Grid }>,
  dictFields: DictField[]
): PushFieldsSheetPlan[] {
  const masterHeaders = trimHeaders(masterGrid[0]);
  const captainDict = dictFields.filter((field) => field.distribute_to_captain === 1);
  const masterField = captainDict.find((field) => field.canonical_name === 'resident_id');
  const masterMatchHeader = masterField
    ? buildCellFillConfig(masterHeaders, masterHeaders, 'resident_id', captainDict).matchSourceHeader
    : masterHeaders.includes('resident_id')
      ? 'resident_id'
      : null;
  if (!masterMatchHeader) {
    throw new Error('The master has no resident_id column to match on.');
  }
  const { lookup } = buildSourceLookup(masterGrid, masterMatchHeader);

  return captainSheets.map((sheet) => {
    const captainHeaders = trimHeaders(sheet.grid[0]);
    const cfg = buildCellFillConfig(masterHeaders, captainHeaders, 'resident_id', captainDict);
    if (!cfg.matchTargetHeader) {
      return {
        spreadsheetId: sheet.spreadsheetId,
        spreadsheetName: sheet.spreadsheetName,
        tabName: sheet.tabName,
        url: sheet.url,
        filled: 0,
        conflicts: 0,
        overwritten: 0,
        columnsToAdd: [],
        errors: ['No resident_id column to match on'],
        sheetFingerprint: hashParts([sheet.spreadsheetId, 'no-match']),
      };
    }
    const plan = planCellFill(sheet.grid, lookup, cfg.matchTargetHeader, cfg.columnMap, {
      policies: cfg.policies,
      fieldMeta: cfg.fieldMeta,
      protectedColumns: cfg.protectedColumns,
      defaultPolicy: 'fill_blank',
    });
    return {
      spreadsheetId: sheet.spreadsheetId,
      spreadsheetName: sheet.spreadsheetName,
      tabName: sheet.tabName,
      url: sheet.url,
      filled: plan.filled.length,
      conflicts: plan.conflicts.length,
      overwritten: plan.overwritten.length,
      columnsToAdd: [...plan.columnsToAdd],
      errors: plan.errors.map((error) => error.message),
      sheetFingerprint: pushFieldsSheetFingerprint(sheet.spreadsheetId, plan),
    };
  });
}

export function replanPushMissingSheet(
  masterGrid: Grid,
  captainGrid: Grid,
  options: {
    sensitiveColumns: string[];
    distributedColumns: string[];
  }
): PushMissingResult {
  return planPushMissingResidents(captainGrid, masterGrid, options);
}

export function replanPushFieldsSheet(
  masterGrid: Grid,
  captainGrid: Grid,
  dictFields: DictField[]
): { plan: CellFillResult; cfg: ReturnType<typeof buildCellFillConfig> } {
  const masterHeaders = trimHeaders(masterGrid[0]);
  const captainHeaders = trimHeaders(captainGrid[0]);
  const captainDict = dictFields.filter((field) => field.distribute_to_captain === 1);
  const cfg = buildCellFillConfig(masterHeaders, captainHeaders, 'resident_id', captainDict);
  if (!cfg.matchSourceHeader) throw new Error('The master has no resident_id column to match on.');
  if (!cfg.matchTargetHeader) throw new Error('This captain sheet has no resident_id column to match on.');
  const { lookup } = buildSourceLookup(masterGrid, cfg.matchSourceHeader);
  const plan = planCellFill(captainGrid, lookup, cfg.matchTargetHeader, cfg.columnMap, {
    policies: cfg.policies,
    fieldMeta: cfg.fieldMeta,
    protectedColumns: cfg.protectedColumns,
    defaultPolicy: 'fill_blank',
  });
  return { plan, cfg };
}

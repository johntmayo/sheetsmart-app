// Pure merge engine ported from legacy MergeEngine.gs. Every function takes
// plain 2D arrays (as returned by the Sheets API) and returns a structured
// PLAN of proposed changes — it performs NO I/O. A Phase-3 writer turns the
// plan's `writes` into batched Sheets updates; a dry run simply reports it.
//
// This design is what makes the safety model testable (handoff 8.6) and makes
// interrupted live jobs safe to re-run: identity is matched by key, blanks are
// filled, rows are appended-if-absent (handoff 4.8).

import { CellValue } from './values';
import { decideWrite, Policy } from './writeGuard';

export const SOURCE_ROW_KEY = '__sourceRowNumber';

// A 2D grid of cell values, including the header row (as read from Sheets).
export type Grid = CellValue[][];

export interface ColumnMap {
  source: string;
  target: string;
}

// A single source row keyed by header name, plus the SOURCE_ROW_KEY row number.
export type SourceRecord = Record<string, CellValue>;
export type SourceLookup = Record<string, SourceRecord>;

export interface CellFillEntry {
  row: number;
  column: string;
  existingValue: CellValue;
  newValue: CellValue;
  policy: Policy;
}

export interface SkippedCell extends CellFillEntry {
  reason: string;
}

export interface WriteOp {
  row: number;
  col: number;
  value: CellValue;
}

export interface PlanError {
  column?: string;
  message: string;
}

export interface CellFillResult {
  columnsToAdd: string[];
  filled: CellFillEntry[];
  overwritten: CellFillEntry[];
  conflicts: CellFillEntry[];
  skipped: SkippedCell[];
  writes: WriteOp[];
  errors: PlanError[];
}

export interface CellFillOptions {
  policies?: Record<string, string>;
  defaultPolicy?: string;
  protectedColumns?: string[];
}

export interface AppendedResident {
  residentId: string;
  residentName: string;
  masterRow: number;
}

export interface SkippedResident extends AppendedResident {
  reason: string;
}

export interface FlaggedResident {
  residentId: string;
  residentName: string;
  flaggedColumns: string;
}

export interface PushMissingResult {
  appended: AppendedResident[];
  flagged: FlaggedResident[];
  skipped: SkippedResident[];
  errors: PlanError[];
  detectedZone: string;
  newRows: CellValue[][];
}

export interface PushMissingOptions {
  sensitiveColumns?: string[];
}

export function trimHeaders(row: CellValue[] | undefined): string[] {
  return (row || []).map((h) => String(h == null ? '' : h).trim());
}

// Build a lookup keyed by the match-column value: key -> { header: value, ... }.
export function buildSourceLookup(
  sourceData: Grid,
  matchColumn: string
): { headers: string[]; matchIdx: number; lookup: SourceLookup } {
  const headers = trimHeaders(sourceData[0] || []);
  const matchIdx = headers.indexOf(matchColumn);
  if (matchIdx === -1) return { headers, matchIdx, lookup: {} };

  const lookup: SourceLookup = {};
  for (let i = 1; i < sourceData.length; i++) {
    const row = sourceData[i];
    const key = String(row[matchIdx] == null ? '' : row[matchIdx]).trim();
    if (key === '' || key === 'undefined' || key === 'null') continue;
    if (lookup[key]) continue; // first row for a key wins (handoff 1.5 #4)
    const record: SourceRecord = {};
    for (let c = 0; c < headers.length; c++) record[headers[c]] = row[c];
    record[SOURCE_ROW_KEY] = i + 1;
    lookup[key] = record;
  }
  return { headers, matchIdx, lookup };
}

// Convert a mapped source value to a write value. Minimal for now: normalize
// boolean-looking strings. (Date-serial coercion is a Phase-3 concern once the
// parity harness is wired; see handoff 4.6.)
export function normalizeSourceValueForWrite(value: CellValue): CellValue {
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return value;
}

/**
 * Cell-fill sync (Import→Master, Push→Captain). Adds missing target columns
 * (virtually, for planning) then fills blanks / logs conflicts per policy.
 */
export function planCellFill(
  targetData: Grid,
  sourceLookup: SourceLookup,
  matchColumn: string,
  columnMap: ColumnMap[],
  options: CellFillOptions = {}
): CellFillResult {
  const policies = options.policies || {};
  const defaultPolicy = options.defaultPolicy || 'fill_blank';
  const protectedColumns = options.protectedColumns;

  const result: CellFillResult = {
    columnsToAdd: [],
    filled: [],
    overwritten: [],
    conflicts: [],
    skipped: [],
    writes: [],
    errors: [],
  };

  if (!targetData || targetData.length === 0) {
    result.errors.push({ message: 'Target sheet is empty' });
    return result;
  }

  const targetHeaders = trimHeaders(targetData[0]);
  const originalWidth = targetHeaders.length;

  // Virtually add any mapped target columns that don't yet exist. Their cells
  // index past the real row width -> undefined -> treated as blank.
  for (const map of columnMap) {
    const tgt = String(map.target || '').trim();
    if (tgt !== '' && targetHeaders.indexOf(tgt) === -1 && !result.columnsToAdd.includes(tgt)) {
      result.columnsToAdd.push(tgt);
      targetHeaders.push(tgt);
    }
  }

  const matchIdx = targetHeaders.indexOf(matchColumn);
  if (matchIdx === -1) {
    result.errors.push({ column: matchColumn, message: `Match column "${matchColumn}" not found in target headers` });
    return result;
  }

  const targetColIdx = columnMap.map((m) => targetHeaders.indexOf(m.target));
  columnMap.forEach((m, i) => {
    if (targetColIdx[i] === -1) {
      result.errors.push({ column: m.target, message: `Mapped target column "${m.target}" not found` });
    }
  });

  for (let r = 1; r < targetData.length; r++) {
    const key = String(targetData[r][matchIdx] == null ? '' : targetData[r][matchIdx]).trim();
    if (key === '' || key === 'undefined' || key === 'null') continue;
    const sourceRow = sourceLookup[key];
    if (!sourceRow) continue;

    for (let c = 0; c < columnMap.length; c++) {
      const colIdx = targetColIdx[c];
      if (colIdx === -1) continue;
      const map = columnMap[c];
      const source = normalizeSourceValueForWrite(sourceRow[map.source]);
      const target = colIdx < originalWidth ? targetData[r][colIdx] : undefined;
      const policy = policies[map.target] || policies[map.source] || defaultPolicy;

      const d = decideWrite({ column: map.target, target, source, policy, protectedColumns });
      const entry: CellFillEntry = {
        row: r + 1,
        column: map.target,
        existingValue: target,
        newValue: source,
        policy: d.effectivePolicy,
      };
      if (d.action === 'fill') {
        result.filled.push(entry);
        result.writes.push({ row: r + 1, col: colIdx + 1, value: source });
      } else if (d.action === 'overwrite') {
        result.overwritten.push(entry);
        result.writes.push({ row: r + 1, col: colIdx + 1, value: source });
      } else if (d.action === 'conflict') {
        result.conflicts.push(entry);
      } else if (d.action === 'skip' && d.effectivePolicy === 'never') {
        result.skipped.push({ ...entry, reason: d.reason });
      }
      // 'skip' due to blank source and 'equal' are intentionally silent.
    }
  }

  return result;
}

// Detect a target sheet's zone as the mode of its ZoneName column, then plan
// appends of master rows for that zone whose resident_id is absent. Pure
// addition; existing rows are never touched (legacy appendMissingRowsToSheet_).
export function planPushMissingResidents(
  targetData: Grid,
  masterData: Grid,
  options: PushMissingOptions = {}
): PushMissingResult {
  const sensitiveColumns = options.sensitiveColumns || [];
  const result: PushMissingResult = {
    appended: [],
    flagged: [],
    skipped: [],
    errors: [],
    detectedZone: '',
    newRows: [],
  };

  if (!targetData || targetData.length === 0) {
    result.errors.push({ message: 'Target sheet is empty (no header row)' });
    return result;
  }
  const targetHeaders = trimHeaders(targetData[0]);
  const targetZoneCol = targetHeaders.indexOf('ZoneName');
  const targetIdCol = targetHeaders.indexOf('resident_id');
  if (targetZoneCol === -1) return err(result, 'Target sheet has no ZoneName column');
  if (targetIdCol === -1) return err(result, 'Target sheet has no resident_id column');

  const existing: Record<string, boolean> = {};
  const zoneCounts: Record<string, number> = {};
  for (let r = 1; r < targetData.length; r++) {
    const id = String(targetData[r][targetIdCol] == null ? '' : targetData[r][targetIdCol]).trim();
    if (id && id !== 'undefined' && id !== 'null') existing[id] = true;
    const zv = String(targetData[r][targetZoneCol] == null ? '' : targetData[r][targetZoneCol]).trim();
    if (zv !== '') zoneCounts[zv] = (zoneCounts[zv] || 0) + 1;
  }
  let detectedZone = '';
  let top = 0;
  for (const z of Object.keys(zoneCounts)) if (zoneCounts[z] > top) { detectedZone = z; top = zoneCounts[z]; }
  if (detectedZone === '') return err(result, 'No zone detected (ZoneName column has no non-blank values)');
  result.detectedZone = detectedZone;

  const masterHeaders = trimHeaders(masterData[0] || []);
  const mIdCol = masterHeaders.indexOf('resident_id');
  const mZoneCol = masterHeaders.indexOf('ZoneName');
  const mNameCol = masterHeaders.indexOf('Resident Name');
  if (mIdCol === -1) return err(result, 'Master has no resident_id column');
  if (mZoneCol === -1) return err(result, 'Master has no ZoneName column');

  // Header-name join: target col index -> master col index.
  const colMap = targetHeaders.map((h) => (h === '' ? -1 : masterHeaders.indexOf(h)));
  const sensitiveMasterCols: number[] = [];
  const sensitiveNames: string[] = [];
  for (const s of sensitiveColumns) {
    const idx = masterHeaders.indexOf(String(s).trim());
    if (idx !== -1) { sensitiveMasterCols.push(idx); sensitiveNames.push(String(s).trim()); }
  }

  for (let mr = 1; mr < masterData.length; mr++) {
    const masterRow = masterData[mr];
    const masterZone = String(masterRow[mZoneCol] == null ? '' : masterRow[mZoneCol]).trim();
    if (masterZone !== detectedZone) continue;
    const masterId = String(masterRow[mIdCol] == null ? '' : masterRow[mIdCol]).trim();
    const name = mNameCol !== -1 ? String(masterRow[mNameCol] == null ? '' : masterRow[mNameCol]).trim() : '';
    if (!masterId || masterId === 'undefined' || masterId === 'null') {
      result.skipped.push({ residentId: '', residentName: '', masterRow: mr + 1, reason: 'Blank resident_id' });
      continue;
    }
    if (existing[masterId]) {
      result.skipped.push({ residentId: masterId, residentName: name, masterRow: mr + 1, reason: 'resident_id already present' });
      continue;
    }
    const newRow = targetHeaders.map((_h, c) => (colMap[c] === -1 ? '' : masterRow[colMap[c]]));
    const flaggedCols: string[] = [];
    sensitiveMasterCols.forEach((sc, i) => {
      const sv = masterRow[sc];
      if (sv !== '' && sv !== null && sv !== undefined) flaggedCols.push(sensitiveNames[i]);
    });
    result.appended.push({ residentId: masterId, residentName: name, masterRow: mr + 1 });
    if (flaggedCols.length > 0) result.flagged.push({ residentId: masterId, residentName: name, flaggedColumns: flaggedCols.join(', ') });
    result.newRows.push(newRow);
    existing[masterId] = true; // first occurrence wins
  }
  return result;
}

function err(result: PushMissingResult, message: string): PushMissingResult {
  result.errors.push({ message });
  return result;
}

/**
 * Pure deletion/restoration planning for Google Sheets grids.
 *
 * The planner deliberately knows nothing about Google or Mapbox. Callers read
 * grids, execute the returned row operations, persist the archives/tombstones,
 * and may map the explicit placeholder marker to any physical sheet column.
 */
import { createHash } from 'node:crypto';
import type { Grid } from './mergeEngine';
import type { CellValue } from './values';

export type DeletionKind = 'person' | 'address';

export interface DeletionSheet {
  spreadsheetId: string;
  tabName: string;
  zone: string;
  grid: Grid;
  spreadsheetName?: string;
}

export interface DeletionPlannerOptions {
  residentColumn?: string;
  addressColumn?: string;
  /**
   * Optional physical column for placeholders. The semantic marker remains on
   * PlaceholderRow even when this is omitted or the sheet lacks this column.
   */
  placeholderMarkerColumn?: string;
  placeholderMarkerValue?: string;
}

export interface ArchivedDeletionRow {
  spreadsheetId: string;
  spreadsheetName: string;
  tabName: string;
  zone: string;
  rowNumber: number;
  headers: string[];
  row: CellValue[];
  residentId: string;
  addressId: string;
  placeholder: boolean;
  fingerprint: string;
}

export interface PlannedRowDeletion {
  spreadsheetId: string;
  tabName: string;
  zone: string;
  rowNumber: number;
  residentId: string;
  addressId: string;
  archive: ArchivedDeletionRow;
}

export interface PlaceholderRow {
  kind: 'address_placeholder';
  /** Always present, independently of physical sheet schema. */
  marker: string;
  addressId: string;
  spreadsheetId: string;
  tabName: string;
  zone: string;
  headers: string[];
  row: CellValue[];
}

export interface DeletionBlock {
  code:
    | 'missing_column'
    | 'not_found'
    | 'duplicate_identity'
    | 'ambiguous_identity'
    | 'missing_identity';
  message: string;
  spreadsheetId?: string;
  tabName?: string;
  residentId?: string;
  addressId?: string;
}

export interface DeletionPlan {
  kind: DeletionKind;
  targetId: string;
  deletions: PlannedRowDeletion[];
  archives: ArchivedDeletionRow[];
  placeholders: PlaceholderRow[];
  tombstones: Tombstone[];
  blocked: DeletionBlock[];
  fingerprint: string;
}

export interface Tombstone {
  kind: 'resident' | 'address';
  id: string;
}

interface IndexedRow {
  sheet: DeletionSheet;
  headers: string[];
  row: CellValue[];
  rowIndex: number;
  residentId: string;
  addressId: string;
  placeholder: boolean;
}

const DEFAULT_PLACEHOLDER_MARKER = '__SHEETSMART_ADDRESS_PLACEHOLDER__';

export function planPersonDeletion(
  sheets: DeletionSheet[],
  residentId: string,
  options: DeletionPlannerOptions = {}
): DeletionPlan {
  const targetId = cleanIdentity(residentId);
  const indexed = indexSheets(sheets, options);
  const matches = indexed.rows.filter((entry) => entry.residentId === targetId && !entry.placeholder);
  const blocked = [...indexed.blocks];

  if (!targetId || matches.length === 0) {
    blocked.push({
      code: 'not_found',
      message: `Resident ${targetId || '(blank)'} was not found.`,
      residentId: targetId,
    });
  }

  const addresses = distinct(matches.map((entry) => entry.addressId).filter(Boolean));
  if (addresses.length !== 1) {
    blocked.push({
      code: 'ambiguous_identity',
      message:
        addresses.length === 0
          ? `Resident ${targetId} has no address identity.`
          : `Resident ${targetId} is associated with more than one address.`,
      residentId: targetId,
    });
  }
  blockDuplicateResidentRows(matches, blocked);
  const unidentified = indexed.rows.find(
    (entry) => addresses.includes(entry.addressId) && !entry.placeholder && !entry.residentId
  );
  if (unidentified) {
    blocked.push({
      code: 'missing_identity',
      message: `A row at address ${unidentified.addressId} has no resident identity.`,
      spreadsheetId: unidentified.sheet.spreadsheetId,
      tabName: unidentified.sheet.tabName,
      addressId: unidentified.addressId,
    });
  }

  if (blocked.length > 0) return emptyPlan('person', targetId, blocked);

  const deletions = matches.map(toDeletion);
  const addressId = addresses[0];
  const placeholders: PlaceholderRow[] = [];

  // A placeholder is needed independently in each affected physical sheet.
  for (const sheetKey of distinct(matches.map(sheetIdentity))) {
    const deletedInSheet = matches.filter((entry) => sheetIdentity(entry) === sheetKey);
    const exemplar = deletedInSheet[0];
    const realPeopleRemaining = indexed.rows.some(
      (entry) =>
        sheetIdentity(entry) === sheetKey &&
        entry.addressId === addressId &&
        !entry.placeholder &&
        Boolean(entry.residentId) &&
        entry.residentId !== targetId
    );
    const placeholderAlreadyExists = indexed.rows.some(
      (entry) =>
        sheetIdentity(entry) === sheetKey && entry.addressId === addressId && entry.placeholder
    );
    if (!realPeopleRemaining && !placeholderAlreadyExists) {
      placeholders.push(makePlaceholder(exemplar.sheet, exemplar.headers, addressId, options));
    }
  }

  return finalizePlan('person', targetId, deletions, placeholders, [
    { kind: 'resident', id: targetId },
  ]);
}

export function planAddressDeletion(
  sheets: DeletionSheet[],
  addressId: string,
  options: DeletionPlannerOptions = {}
): DeletionPlan {
  const targetId = cleanIdentity(addressId);
  const indexed = indexSheets(sheets, options);
  const matches = indexed.rows.filter((entry) => entry.addressId === targetId);
  const blocked = [...indexed.blocks];

  if (!targetId || matches.length === 0) {
    blocked.push({
      code: 'not_found',
      message: `Address ${targetId || '(blank)'} was not found.`,
      addressId: targetId,
    });
  }

  const residentIds = distinct(
    matches.filter((entry) => !entry.placeholder).map((entry) => entry.residentId).filter(Boolean)
  );
  for (const residentId of residentIds) {
    const allResidentRows = indexed.rows.filter(
      (entry) => entry.residentId === residentId && !entry.placeholder
    );
    const otherAddresses = distinct(allResidentRows.map((entry) => entry.addressId).filter(Boolean));
    if (otherAddresses.some((candidate) => candidate !== targetId)) {
      blocked.push({
        code: 'ambiguous_identity',
        message: `Resident ${residentId} is associated with more than one address.`,
        residentId,
        addressId: targetId,
      });
    }
    blockDuplicateResidentRows(
      allResidentRows.filter((entry) => entry.addressId === targetId),
      blocked
    );
  }

  const unidentified = matches.find((entry) => !entry.placeholder && !entry.residentId);
  if (unidentified) {
    blocked.push({
      code: 'missing_identity',
      message: `A real row at address ${targetId} has no resident identity.`,
      spreadsheetId: unidentified.sheet.spreadsheetId,
      tabName: unidentified.sheet.tabName,
      addressId: targetId,
    });
  }

  // Whole-address deletion is all-or-nothing: never return a partial operation.
  if (blocked.length > 0) return emptyPlan('address', targetId, blocked);

  return finalizePlan('address', targetId, matches.map(toDeletion), [], [
    { kind: 'address', id: targetId },
    ...residentIds.map<Tombstone>((id) => ({ kind: 'resident', id })),
  ]);
}

export function fingerprintDeletionRows(
  archives: ArchivedDeletionRow[],
  placeholders: PlaceholderRow[] = []
): string {
  const archiveLines = archives.map(
    (archive) =>
      `delete\t${archive.spreadsheetId}\t${archive.tabName}\t${archive.zone}\t${archive.rowNumber}` +
      `\t${archive.residentId}\t${archive.addressId}\t${canonicalRow(archive.row)}`
  );
  const placeholderLines = placeholders.map(
    (placeholder) =>
      `placeholder\t${placeholder.spreadsheetId}\t${placeholder.tabName}\t${placeholder.zone}` +
      `\t${placeholder.addressId}\t${placeholder.marker}\t${canonicalRow(placeholder.row)}`
  );
  return hash([...archiveLines, ...placeholderLines].sort().join('\n'));
}

export function fingerprintArchivedPayload(fullRow: Record<string, unknown>): string {
  return hash(
    Object.keys(fullRow)
      .filter((key) => key !== 'Deleted Record')
      .sort()
      .map((key) => `${key}\u0000${canonicalCell(fullRow[key] as CellValue)}`)
      .join('\u0001')
  );
}

export interface RestorationAppend {
  residentId: string;
  addressId: string;
  headers: string[];
  row: CellValue[];
  sourceArchiveFingerprint: string;
}

export interface RestorationPlan {
  spreadsheetId: string;
  tabName: string;
  zone: string;
  appends: RestorationAppend[];
  blocked: DeletionBlock[];
  fingerprint: string;
}

/**
 * Prepare archived records for the supplied current-zone sheet. This function
 * only remaps and validates rows; geocoding/Mapbox enrichment belongs to the
 * caller before or after execution.
 */
export function planCurrentZoneRestoration(
  archives: ArchivedDeletionRow[],
  currentZoneSheet: DeletionSheet,
  options: DeletionPlannerOptions = {}
): RestorationPlan {
  const residentColumn = options.residentColumn || 'resident_id';
  const addressColumn = options.addressColumn || 'address_id';
  const targetHeaders = headersOf(currentZoneSheet.grid);
  const blocked: DeletionBlock[] = [];
  const residentCol = targetHeaders.indexOf(residentColumn);
  const addressCol = targetHeaders.indexOf(addressColumn);
  if (residentCol === -1) {
    blocked.push({ code: 'missing_column', message: `The current-zone sheet has no ${residentColumn} column.` });
  }
  if (addressCol === -1) {
    blocked.push({ code: 'missing_column', message: `The current-zone sheet has no ${addressColumn} column.` });
  }
  if (blocked.length > 0) return restorationResult(currentZoneSheet, [], blocked);

  const existingResidents = new Set<string>();
  const existingAddresses = new Map<string, Set<string>>();
  for (const row of currentZoneSheet.grid.slice(1)) {
    const rid = cleanIdentity(row?.[residentCol]);
    const aid = cleanIdentity(row?.[addressCol]);
    if (rid) existingResidents.add(rid);
    if (rid) {
      const addresses = existingAddresses.get(rid) || new Set<string>();
      if (aid) addresses.add(aid);
      existingAddresses.set(rid, addresses);
    }
  }

  // Prefer an archive from this exact destination, then one from its zone.
  // This avoids restoring captain/master copies of the same logical person.
  const groups = new Map<string, ArchivedDeletionRow[]>();
  for (const archive of archives) {
    const logicalKey = archive.placeholder
      ? `placeholder:${archive.addressId}`
      : `resident:${archive.residentId}`;
    const group = groups.get(logicalKey) || [];
    group.push(archive);
    groups.set(logicalKey, group);
  }

  const appends: RestorationAppend[] = [];
  for (const group of groups.values()) {
    const preferred = group.filter(
      (archive) =>
        archive.spreadsheetId === currentZoneSheet.spreadsheetId &&
        archive.tabName === currentZoneSheet.tabName
    );
    const inZone = group.filter((archive) => archive.zone === currentZoneSheet.zone);
    const candidates = (preferred.length ? preferred : inZone.length ? inZone : group).sort(compareArchive);
    const archive = candidates[0];

    const addresses = distinct(group.map((entry) => entry.addressId).filter(Boolean));
    if (!archive.placeholder && (group.some((entry) => entry.residentId !== archive.residentId) || addresses.length !== 1)) {
      blocked.push({
        code: 'ambiguous_identity',
        message: `Archived resident ${archive.residentId} has ambiguous identity data.`,
        residentId: archive.residentId,
      });
      continue;
    }
    if (!archive.placeholder && existingResidents.has(archive.residentId)) {
      blocked.push({
        code: 'duplicate_identity',
        message: `Resident ${archive.residentId} already exists in the current-zone sheet.`,
        residentId: archive.residentId,
      });
      continue;
    }
    const row = remapRow(archive.headers, archive.row, targetHeaders);
    appends.push({
      residentId: archive.residentId,
      addressId: archive.addressId,
      headers: [...targetHeaders],
      row,
      sourceArchiveFingerprint: archive.fingerprint,
    });
  }

  if (blocked.length > 0) return restorationResult(currentZoneSheet, [], blocked);
  appends.sort((a, b) => a.addressId.localeCompare(b.addressId) || a.residentId.localeCompare(b.residentId));
  return restorationResult(currentZoneSheet, appends, []);
}

export function isResidentTombstoned(residentId: CellValue, tombstones: Tombstone[]): boolean {
  const id = cleanIdentity(residentId);
  return tombstones.some((entry) => entry.kind === 'resident' && entry.id === id);
}

export function isAddressTombstoned(addressId: CellValue, tombstones: Tombstone[]): boolean {
  const id = cleanIdentity(addressId);
  return tombstones.some((entry) => entry.kind === 'address' && entry.id === id);
}

export function shouldFilterTombstonedRecord(
  record: { residentId?: CellValue; addressId?: CellValue },
  tombstones: Tombstone[]
): boolean {
  return (
    isResidentTombstoned(record.residentId, tombstones) ||
    isAddressTombstoned(record.addressId, tombstones)
  );
}

export function filterTombstonedRecords<T extends { residentId?: CellValue; addressId?: CellValue }>(
  records: T[],
  tombstones: Tombstone[]
): T[] {
  return records.filter((record) => !shouldFilterTombstonedRecord(record, tombstones));
}

function indexSheets(
  sheets: DeletionSheet[],
  options: DeletionPlannerOptions
): { rows: IndexedRow[]; blocks: DeletionBlock[] } {
  const residentColumn = options.residentColumn || 'resident_id';
  const addressColumn = options.addressColumn || 'address_id';
  const rows: IndexedRow[] = [];
  const blocks: DeletionBlock[] = [];
  for (const sheet of sheets) {
    const headers = headersOf(sheet.grid);
    const residentCol = headers.indexOf(residentColumn);
    const addressCol = headers.indexOf(addressColumn);
    if (residentCol === -1 || addressCol === -1) {
      blocks.push({
        code: 'missing_column',
        message: `${sheet.spreadsheetName || sheet.spreadsheetId}/${sheet.tabName} is missing ${
          residentCol === -1 ? residentColumn : addressColumn
        }.`,
        spreadsheetId: sheet.spreadsheetId,
        tabName: sheet.tabName,
      });
      continue;
    }
    const markerCol = options.placeholderMarkerColumn
      ? headers.indexOf(options.placeholderMarkerColumn)
      : -1;
    const personColumns = ['Resident Name', 'First Name', 'Middle Name', 'Last Name']
      .map((header) => headers.indexOf(header))
      .filter((index) => index !== -1);
    const markerValue = options.placeholderMarkerValue || DEFAULT_PLACEHOLDER_MARKER;
    for (let rowIndex = 1; rowIndex < sheet.grid.length; rowIndex++) {
      const row = sheet.grid[rowIndex] || [];
      const residentId = cleanIdentity(row[residentCol]);
      const addressId = cleanIdentity(row[addressCol]);
      const physicalMarker = markerCol !== -1 && String(row[markerCol] ?? '') === markerValue;
      const legacyMarkerResident = residentId === `__address_placeholder__:${addressId}`;
      const uuidResident = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        residentId
      );
      const hasPersonName = personColumns.some((column) => Boolean(String(row[column] ?? '').trim()));
      const unnamedAddressRecord =
        Boolean(residentId) &&
        personColumns.length > 0 &&
        !hasPersonName &&
        (uuidResident || physicalMarker || legacyMarkerResident);
      rows.push({
        sheet,
        headers,
        row: [...row],
        rowIndex,
        residentId,
        addressId,
        placeholder:
          personColumns.length > 0
            ? unnamedAddressRecord
            : physicalMarker || legacyMarkerResident,
      });
    }
  }
  return { rows, blocks };
}

function blockDuplicateResidentRows(rows: IndexedRow[], blocks: DeletionBlock[]): void {
  const bySheet = new Map<string, IndexedRow[]>();
  for (const row of rows) {
    const list = bySheet.get(sheetIdentity(row)) || [];
    list.push(row);
    bySheet.set(sheetIdentity(row), list);
  }
  for (const duplicates of bySheet.values()) {
    if (duplicates.length < 2) continue;
    const first = duplicates[0];
    blocks.push({
      code: 'duplicate_identity',
      message: `Resident ${first.residentId} appears more than once in the same sheet.`,
      spreadsheetId: first.sheet.spreadsheetId,
      tabName: first.sheet.tabName,
      residentId: first.residentId,
      addressId: first.addressId,
    });
  }
}

function toDeletion(entry: IndexedRow): PlannedRowDeletion {
  const archiveBase = {
    spreadsheetId: entry.sheet.spreadsheetId,
    spreadsheetName: entry.sheet.spreadsheetName || '',
    tabName: entry.sheet.tabName,
    zone: entry.sheet.zone,
    rowNumber: entry.rowIndex + 1,
    headers: [...entry.headers],
    row: [...entry.row],
    residentId: entry.residentId,
    addressId: entry.addressId,
    placeholder: entry.placeholder,
  };
  const archive: ArchivedDeletionRow = {
    ...archiveBase,
    fingerprint: hash(canonicalArchive(archiveBase)),
  };
  return {
    spreadsheetId: entry.sheet.spreadsheetId,
    tabName: entry.sheet.tabName,
    zone: entry.sheet.zone,
    rowNumber: entry.rowIndex + 1,
    residentId: entry.residentId,
    addressId: entry.addressId,
    archive,
  };
}

function makePlaceholder(
  sheet: DeletionSheet,
  headers: string[],
  addressId: string,
  options: DeletionPlannerOptions
): PlaceholderRow {
  const residentColumn = options.residentColumn || 'resident_id';
  const addressColumn = options.addressColumn || 'address_id';
  const marker = options.placeholderMarkerValue || DEFAULT_PLACEHOLDER_MARKER;
  const row: CellValue[] = headers.map(() => '');
  row[headers.indexOf(addressColumn)] = addressId;
  const residentCol = headers.indexOf(residentColumn);
  if (residentCol !== -1) row[residentCol] = placeholderResidentId(addressId);
  if (options.placeholderMarkerColumn) {
    const markerCol = headers.indexOf(options.placeholderMarkerColumn);
    if (markerCol !== -1) row[markerCol] = marker;
  }
  return {
    kind: 'address_placeholder',
    marker,
    addressId,
    spreadsheetId: sheet.spreadsheetId,
    tabName: sheet.tabName,
    zone: sheet.zone,
    headers: [...headers],
    row,
  };
}

function placeholderResidentId(addressId: string): string {
  const chars = hash(`address-placeholder-resident:v1:${addressId}`).slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function finalizePlan(
  kind: DeletionKind,
  targetId: string,
  deletions: PlannedRowDeletion[],
  placeholders: PlaceholderRow[],
  tombstones: Tombstone[]
): DeletionPlan {
  const ordered = [...deletions].sort(
    (a, b) =>
      a.spreadsheetId.localeCompare(b.spreadsheetId) ||
      a.tabName.localeCompare(b.tabName) ||
      a.rowNumber - b.rowNumber
  );
  const archives = ordered.map((deletion) => deletion.archive);
  return {
    kind,
    targetId,
    deletions: ordered,
    archives,
    placeholders,
    tombstones,
    blocked: [],
    fingerprint: fingerprintDeletionRows(archives, placeholders),
  };
}

function emptyPlan(kind: DeletionKind, targetId: string, blocked: DeletionBlock[]): DeletionPlan {
  return {
    kind,
    targetId,
    deletions: [],
    archives: [],
    placeholders: [],
    tombstones: [],
    blocked,
    fingerprint: fingerprintDeletionRows([]),
  };
}

function restorationResult(
  sheet: DeletionSheet,
  appends: RestorationAppend[],
  blocked: DeletionBlock[]
): RestorationPlan {
  const lines = appends.map(
    (append) =>
      `${append.addressId}\t${append.residentId}\t${append.sourceArchiveFingerprint}\t${canonicalRow(append.row)}`
  );
  return {
    spreadsheetId: sheet.spreadsheetId,
    tabName: sheet.tabName,
    zone: sheet.zone,
    appends,
    blocked,
    fingerprint: hash(lines.sort().join('\n')),
  };
}

function remapRow(sourceHeaders: string[], sourceRow: CellValue[], targetHeaders: string[]): CellValue[] {
  const values = new Map<string, CellValue>();
  sourceHeaders.forEach((header, index) => {
    if (header && !values.has(header)) values.set(header, sourceRow[index]);
  });
  return targetHeaders.map((header) => values.get(header) ?? '');
}

function canonicalArchive(archive: Omit<ArchivedDeletionRow, 'fingerprint'>): string {
  return [
    archive.spreadsheetId,
    archive.tabName,
    archive.zone,
    String(archive.rowNumber),
    archive.residentId,
    archive.addressId,
    archive.placeholder ? 'placeholder' : 'person',
    canonicalRow(archive.row),
  ].join('\t');
}

function canonicalRow(row: CellValue[]): string {
  return row.map(canonicalCell).join('\u0001');
}

function canonicalCell(value: CellValue): string {
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (value === null) return 'null:';
  if (value === undefined) return 'undefined:';
  return `${typeof value}:${String(value)}`;
}

function compareArchive(a: ArchivedDeletionRow, b: ArchivedDeletionRow): number {
  return (
    a.spreadsheetId.localeCompare(b.spreadsheetId) ||
    a.tabName.localeCompare(b.tabName) ||
    a.rowNumber - b.rowNumber ||
    a.fingerprint.localeCompare(b.fingerprint)
  );
}

function sheetIdentity(entry: IndexedRow): string {
  return `${entry.sheet.spreadsheetId}\u0000${entry.sheet.tabName}`;
}

function headersOf(grid: Grid): string[] {
  return (grid[0] || []).map((value) => String(value == null ? '' : value).trim());
}

function cleanIdentity(value: CellValue): string {
  const text = String(value == null ? '' : value).trim();
  return text === 'undefined' || text === 'null' ? '' : text;
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

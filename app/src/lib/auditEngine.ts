// Pure audit engine — a faithful port of the legacy standalone audit
// (`legacy-appsscript/Code.gs`, `runAudit()`), which is the behavioral source of
// truth for Health metrics (SHEETSMART_VISION_AND_ROADMAP.md §5.4, Phase B).
//
// Every function here is pure: it takes plain 2D arrays (as read from the Sheets
// API) and returns a structured report. It performs NO I/O, so it is unit-
// testable and can be diffed against legacy golden outputs by the parity harness.
//
// Parity notes (why the code looks the way it does):
//  - Apps Script `getDataRange().getValues()` returns a rectangular grid, padding
//    short rows with ''. The Sheets REST API trims trailing blanks instead, so we
//    normalize each grid to a rectangle first (see normalizeGrid) to match legacy
//    counting exactly.
//  - Blank means '' | null | undefined (and whitespace for isBlankCell), matching
//    legacy `countNonBlankInColumn_` / `isBlankCell_`.
//  - Checkbox columns are counted with strict `=== true` (legacy
//    `countTrueInColumn_`), never as "non-blank".

import type { CellValue } from './values';
import { columnLetter } from './columns';

export type Grid = CellValue[][];

// A count that is either a number or the string 'N/A' when the required column
// is absent (legacy returns 'N/A' from the count helpers in that case).
export type Count = number | 'N/A';

// One captain/user spreadsheet handed to the audit. `data` is the full grid
// including the header row. `error` marks a sheet that couldn't be opened.
export interface SheetInput {
  name: string;
  url?: string;
  data?: Grid;
  error?: string;
}

export interface MasterModel {
  headers: string[]; // non-blank master headers, in order (legacy `masterHeaders`)
  roster: Record<string, Record<string, true>>; // zoneName -> { resident_id: true }
  residents: Record<string, MasterResident>; // resident_id -> info
  rowMembershipSkipReason: string;
}

export interface MasterResident {
  zoneName: string;
  name: string;
  address: string;
  masterRow: number;
}

export type SheetStatus =
  | 'Match'
  | 'Missing Columns'
  | 'Extra Columns'
  | 'Missing + Extra'
  | 'Empty'
  | 'ERROR';

export interface SheetAudit {
  name: string;
  url: string;
  status: SheetStatus;
  error?: string;
  totalColumns: number;
  dataRows: number;
  apnValues: Count;
  damageValues: Count;
  addressesMissingApn: Count;
  zone: string; // detected zone (mode of ZoneName); '' when none detected
  apnInconsistentAddresses: number;
  missingRows: Count;
  extraNotInMaster: Count;
  extraWrongZone: Count;
  missingColumns: string[]; // master columns absent from this sheet
  extraColumns: string[]; // sheet columns not present in master
}

export interface ColumnDetailRow {
  spreadsheet: string;
  column: string;
  position: string; // column letter (A, B, ... , AA)
  inMaster: boolean;
  nonBlank: number;
  totalDataRows: number;
}

export interface DuplicateResidentRow {
  residentId: string;
  spreadsheet: string;
  url: string;
  row: number;
  totalOccurrences: number;
  scope: 'Within Sheet' | 'Across Sheets';
}

export interface MissingRow {
  spreadsheet: string;
  url: string;
  zoneName: string;
  residentId: string;
  residentName: string;
  address: string;
  masterRow: number | '';
}

export interface ExtraRow {
  spreadsheet: string;
  url: string;
  sheetZone: string;
  residentId: string;
  residentName: string;
  address: string;
  reason: 'Not in master' | 'Wrong zone';
  masterZoneName: string;
}

export interface MissingSitusRow {
  spreadsheet: string;
  url: string;
  zoneName: string;
  row: number;
  residentId: string;
  residentName: string;
  house: string;
  street: string;
  situsHouseNo: string;
  situsStreet: string;
  missingFields: string;
}

export interface ApnInconsistencyRow {
  spreadsheet: string;
  url: string;
  zoneName: string;
  address: string;
  addressSource: string;
  rowsAtAddress: number;
  rowsWithApn: number;
  rowsMissingApn: number;
  apnValues: string;
  missingApnRows: string;
  reason: string;
}

export interface AuditSummary {
  sheetsScanned: number;
  sheetsWithErrors: number;
  sheetsEmpty: number;
  sheetsMatching: number;
  sheetsWithColumnDrift: number;
  totalDataRows: number;
  duplicateResidentIds: number; // distinct ids that are duplicated
  totalMissingRows: number;
  totalExtraNotInMaster: number;
  totalExtraWrongZone: number;
  totalAddressesMissingApn: number;
  totalApnInconsistencies: number;
  totalMissingSitus: number;
  rowMembershipSkipReason: string;
}

export interface AuditReport {
  generatedAt: string;
  masterHeaders: string[];
  summary: AuditSummary;
  sheets: SheetAudit[];
  columnDetail: ColumnDetailRow[];
  duplicateResidentIds: DuplicateResidentRow[];
  missingRows: MissingRow[];
  extraRows: ExtraRow[];
  missingSitusRows: MissingSitusRow[];
  apnInconsistencies: ApnInconsistencyRow[];
}

// -------  Blank / cell helpers (legacy parity)  -------

function isBlankCell(value: CellValue): boolean {
  return value === '' || value === null || value === undefined || String(value).trim() === '';
}

// Normalize a grid to a rectangle, padding short rows and null/undefined cells
// with '' — mirrors Apps Script getValues(). Booleans (checkbox state) preserved.
function normalizeGrid(grid: Grid): Grid {
  if (!grid || grid.length === 0) return [];
  let width = 0;
  for (const row of grid) width = Math.max(width, row ? row.length : 0);
  return grid.map((row) => {
    const out: CellValue[] = new Array(width);
    for (let i = 0; i < width; i++) {
      const v = row ? row[i] : undefined;
      out[i] = v === undefined || v === null ? '' : v;
    }
    return out;
  });
}

function trimHeaders(headerRow: CellValue[] | undefined): string[] {
  return (headerRow || []).map((h) => String(h == null ? '' : h).trim());
}

// -------  Master parsing (legacy readMasterData_)  -------

export function buildMasterModel(masterGrid: Grid): MasterModel {
  const data = normalizeGrid(masterGrid);
  if (data.length === 0) {
    return {
      headers: [],
      roster: {},
      residents: {},
      rowMembershipSkipReason: 'Row membership audit skipped: master spreadsheet is empty.',
    };
  }

  const rawHeaders = trimHeaders(data[0]);
  const headers = rawHeaders.filter((h) => h !== '');

  const residentIdCol = rawHeaders.indexOf('resident_id');
  const zoneCol = rawHeaders.indexOf('ZoneName');
  const nameCol = rawHeaders.indexOf('Resident Name');
  const houseCol = rawHeaders.indexOf('House');
  const streetCol = rawHeaders.indexOf('Street');

  const roster: Record<string, Record<string, true>> = {};
  const residents: Record<string, MasterResident> = {};

  const missingCols: string[] = [];
  if (residentIdCol === -1) missingCols.push('resident_id');
  if (zoneCol === -1) missingCols.push('ZoneName');
  const rowMembershipSkipReason =
    missingCols.length > 0
      ? 'Row membership audit skipped: master spreadsheet is missing required column(s): ' +
        missingCols.join(', ') +
        '.'
      : '';

  if (residentIdCol === -1) {
    return { headers, roster, residents, rowMembershipSkipReason };
  }

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const residentId = String(row[residentIdCol] == null ? '' : row[residentIdCol]).trim();
    if (residentId === '' || residentId === 'undefined' || residentId === 'null') continue;

    const zoneName = zoneCol !== -1 ? String(row[zoneCol] == null ? '' : row[zoneCol]).trim() : '';
    const name = nameCol !== -1 ? String(row[nameCol] == null ? '' : row[nameCol]).trim() : '';
    const house = houseCol !== -1 ? String(row[houseCol] == null ? '' : row[houseCol]).trim() : '';
    const street = streetCol !== -1 ? String(row[streetCol] == null ? '' : row[streetCol]).trim() : '';
    const address = (house + ' ' + street).trim();

    residents[residentId] = { zoneName, name, address, masterRow: i + 1 };

    if (zoneName !== '') {
      if (!roster[zoneName]) roster[zoneName] = {};
      roster[zoneName][residentId] = true;
    }
  }

  return { headers, roster, residents, rowMembershipSkipReason };
}

// -------  Zone detection (legacy detectSheetZone_)  -------

export function detectSheetZone(headers: string[], dataRows: Grid): string {
  const zoneCol = headers.indexOf('ZoneName');
  if (zoneCol === -1) return '';
  const counts: Record<string, number> = {};
  for (const row of dataRows) {
    const val = String(row[zoneCol] == null ? '' : row[zoneCol]).trim();
    if (val === '') continue;
    counts[val] = (counts[val] || 0) + 1;
  }
  let topZone = '';
  let topCount = 0;
  for (const z of Object.keys(counts)) {
    if (counts[z] > topCount) {
      topZone = z;
      topCount = counts[z];
    }
  }
  return topZone;
}

// -------  Column counts (legacy count helpers)  -------

function countNonBlankInColumn(headers: string[], dataRows: Grid, columnName: string): Count {
  const idx = headers.indexOf(columnName);
  if (idx === -1) return 'N/A';
  let count = 0;
  for (const row of dataRows) {
    const val = row[idx];
    if (val !== '' && val !== null && val !== undefined) count++;
  }
  return count;
}

// Strict `=== true` counting for checkbox columns (unchecked returns false).
export function countTrueInColumn(headers: string[], dataRows: Grid, columnName: string): Count {
  const idx = headers.indexOf(columnName);
  if (idx === -1) return 'N/A';
  let count = 0;
  for (const row of dataRows) if (row[idx] === true) count++;
  return count;
}

function countUniqueAddressesMissingApn(headers: string[], dataRows: Grid): Count {
  const addrCol = headers.indexOf('Address');
  const apnCol = headers.indexOf('APN');
  if (addrCol === -1) return 'N/A';
  if (apnCol === -1) return 'N/A';
  const seen: Record<string, true> = {};
  let count = 0;
  for (const row of dataRows) {
    const addr = String(row[addrCol] == null ? '' : row[addrCol]).trim();
    const apn = row[apnCol];
    const apnBlank = apn === '' || apn === null || apn === undefined;
    if (addr !== '' && apnBlank && !seen[addr]) {
      seen[addr] = true;
      count++;
    }
  }
  return count;
}

// -------  Row membership (legacy computeRowMembership_)  -------

interface Membership {
  missing: MissingRow[];
  extra: ExtraRow[];
  missingCount: Count;
  extraNotInMasterCount: Count;
  extraWrongZoneCount: Count;
}

function computeRowMembership(
  headers: string[],
  dataRows: Grid,
  sheetName: string,
  sheetUrl: string,
  assignedZone: string,
  master: MasterModel
): Membership {
  const result: Membership = {
    missing: [],
    extra: [],
    missingCount: 0,
    extraNotInMasterCount: 0,
    extraWrongZoneCount: 0,
  };

  if (assignedZone === '') return result;

  const residentIdCol = headers.indexOf('resident_id');
  if (residentIdCol === -1) return result;

  const nameCol = headers.indexOf('Resident Name');
  const houseCol = headers.indexOf('House');
  const streetCol = headers.indexOf('Street');

  const userIds: Record<string, { row: number; name: string; address: string }> = {};
  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r];
    const id = String(row[residentIdCol] == null ? '' : row[residentIdCol]).trim();
    if (id === '' || id === 'undefined' || id === 'null') continue;
    const uName = nameCol !== -1 ? String(row[nameCol] == null ? '' : row[nameCol]).trim() : '';
    const uHouse = houseCol !== -1 ? String(row[houseCol] == null ? '' : row[houseCol]).trim() : '';
    const uStreet = streetCol !== -1 ? String(row[streetCol] == null ? '' : row[streetCol]).trim() : '';
    userIds[id] = { row: r + 2, name: uName, address: (uHouse + ' ' + uStreet).trim() };
  }

  const expectedIds = master.roster[assignedZone] || {};

  for (const expId of Object.keys(expectedIds)) {
    if (!userIds[expId]) {
      const m = master.residents[expId] || ({} as MasterResident);
      result.missing.push({
        spreadsheet: sheetName,
        url: sheetUrl,
        zoneName: assignedZone,
        residentId: expId,
        residentName: m.name || '',
        address: m.address || '',
        masterRow: m.masterRow || '',
      });
      (result.missingCount as number)++;
    }
  }

  for (const userId of Object.keys(userIds)) {
    if (!expectedIds[userId]) {
      const u = userIds[userId];
      const masterInfo = master.residents[userId];
      if (!masterInfo) {
        result.extra.push({
          spreadsheet: sheetName,
          url: sheetUrl,
          sheetZone: assignedZone,
          residentId: userId,
          residentName: u.name,
          address: u.address,
          reason: 'Not in master',
          masterZoneName: '',
        });
        (result.extraNotInMasterCount as number)++;
      } else {
        const otherZone = masterInfo.zoneName || '(unassigned)';
        result.extra.push({
          spreadsheet: sheetName,
          url: sheetUrl,
          sheetZone: assignedZone,
          residentId: userId,
          residentName: u.name,
          address: u.address,
          reason: 'Wrong zone',
          masterZoneName: otherZone,
        });
        (result.extraWrongZoneCount as number)++;
      }
    }
  }

  return result;
}

// -------  Missing situs address (legacy collectRowsMissingSitusAddress_)  -------

function collectRowsMissingSitusAddress(
  headers: string[],
  dataRows: Grid,
  sheetName: string,
  url: string,
  assignedZone: string
): MissingSitusRow[] {
  const houseCol = headers.indexOf('_SitusHouseNo');
  const streetCol = headers.indexOf('_SitusStreet');
  const residentIdCol = headers.indexOf('resident_id');
  const nameCol = headers.indexOf('Resident Name');
  const legacyHouseCol = headers.indexOf('House');
  const legacyStreetCol = headers.indexOf('Street');
  const rows: MissingSitusRow[] = [];

  dataRows.forEach((row, i) => {
    const situsHouse = houseCol !== -1 ? row[houseCol] : '';
    const situsStreet = streetCol !== -1 ? row[streetCol] : '';
    const missingFields: string[] = [];
    if (isBlankCell(situsHouse)) missingFields.push('_SitusHouseNo');
    if (isBlankCell(situsStreet)) missingFields.push('_SitusStreet');
    if (missingFields.length === 0) return;

    rows.push({
      spreadsheet: sheetName,
      url,
      zoneName: assignedZone || '',
      row: i + 2,
      residentId: residentIdCol !== -1 ? String(row[residentIdCol] == null ? '' : row[residentIdCol]).trim() : '',
      residentName: nameCol !== -1 ? String(row[nameCol] == null ? '' : row[nameCol]).trim() : '',
      house: legacyHouseCol !== -1 ? String(row[legacyHouseCol] == null ? '' : row[legacyHouseCol]).trim() : '',
      street: legacyStreetCol !== -1 ? String(row[legacyStreetCol] == null ? '' : row[legacyStreetCol]).trim() : '',
      situsHouseNo: houseCol !== -1 ? String(situsHouse == null ? '' : situsHouse).trim() : '(column missing)',
      situsStreet: streetCol !== -1 ? String(situsStreet == null ? '' : situsStreet).trim() : '(column missing)',
      missingFields: missingFields.join(', '),
    });
  });

  return rows;
}

// -------  APN inconsistencies (legacy collectApnInconsistencies_)  -------

interface AddressKey {
  key: string;
  displayAddress: string;
  source: string;
}

function buildAddressKey(address: string, source: string): AddressKey {
  const normalized = address.replace(/\s+/g, ' ').trim();
  return {
    key: normalized.toLowerCase(),
    displayAddress: normalized,
    source: normalized === '' ? '' : source,
  };
}

function addressKeyForRow(headers: string[], row: CellValue[]): AddressKey {
  const situsHouseCol = headers.indexOf('_SitusHouseNo');
  const situsDirectionCol = headers.indexOf('_SitusDirection');
  const situsStreetCol = headers.indexOf('_SitusStreet');
  const situsUnitCol = headers.indexOf('_SitusUnit');
  const legacyHouseCol = headers.indexOf('House');
  const legacyStreetCol = headers.indexOf('Street');
  const addressCol = headers.indexOf('Address');

  const s = (idx: number) => (idx !== -1 ? String(row[idx] == null ? '' : row[idx]).trim() : '');
  const situsHouse = s(situsHouseCol);
  const situsDirection = s(situsDirectionCol);
  const situsStreet = s(situsStreetCol);
  const situsUnit = s(situsUnitCol);
  const situsAddress = [situsHouse, situsDirection, situsStreet, situsUnit].filter((p) => p !== '').join(' ');
  if (situsHouse !== '' && situsStreet !== '') {
    return buildAddressKey(situsAddress, '_SitusHouseNo + _SitusDirection + _SitusStreet + _SitusUnit');
  }

  const legacyHouse = s(legacyHouseCol);
  const legacyStreet = s(legacyStreetCol);
  const legacyAddress = (legacyHouse + ' ' + legacyStreet).trim();
  if (legacyAddress !== '') return buildAddressKey(legacyAddress, 'House + Street');

  return buildAddressKey(s(addressCol), 'Address');
}

function collectApnInconsistencies(
  headers: string[],
  dataRows: Grid,
  sheetName: string,
  url: string,
  assignedZone: string
): ApnInconsistencyRow[] {
  const apnCol = headers.indexOf('APN');
  if (apnCol === -1) return [];

  interface Group {
    displayAddress: string;
    source: string;
    totalRows: number;
    rowsWithApn: number[];
    rowsMissingApn: number[];
    apnValues: Record<string, true>;
  }
  const groups: Record<string, Group> = {};

  dataRows.forEach((row, i) => {
    const addressInfo = addressKeyForRow(headers, row);
    if (addressInfo.key === '') return;
    if (!groups[addressInfo.key]) {
      groups[addressInfo.key] = {
        displayAddress: addressInfo.displayAddress,
        source: addressInfo.source,
        totalRows: 0,
        rowsWithApn: [],
        rowsMissingApn: [],
        apnValues: {},
      };
    }
    const group = groups[addressInfo.key];
    const sheetRow = i + 2;
    const apn = row[apnCol];
    group.totalRows++;
    if (isBlankCell(apn)) {
      group.rowsMissingApn.push(sheetRow);
    } else {
      group.apnValues[String(apn).trim()] = true;
      group.rowsWithApn.push(sheetRow);
    }
  });

  const rows: ApnInconsistencyRow[] = [];
  for (const key of Object.keys(groups)) {
    const group = groups[key];
    const apnValues = Object.keys(group.apnValues).sort();
    const hasMixedCompleteness = group.rowsWithApn.length > 0 && group.rowsMissingApn.length > 0;
    const hasMultipleApns = apnValues.length > 1;
    if (group.totalRows < 2 || (!hasMixedCompleteness && !hasMultipleApns)) continue;

    const reasons: string[] = [];
    if (hasMixedCompleteness) reasons.push('Some rows missing APN');
    if (hasMultipleApns) reasons.push('Multiple APN values at same address');

    rows.push({
      spreadsheet: sheetName,
      url,
      zoneName: assignedZone || '',
      address: group.displayAddress,
      addressSource: group.source,
      rowsAtAddress: group.totalRows,
      rowsWithApn: group.rowsWithApn.length,
      rowsMissingApn: group.rowsMissingApn.length,
      apnValues: apnValues.join(', '),
      missingApnRows: group.rowsMissingApn.join(', '),
      reason: reasons.join(' + '),
    });
  }

  return rows;
}

// -------  Duplicate resident_id (legacy collect + findDuplicate)  -------

interface ResidentIdEntry {
  id: string;
  sheet: string;
  url: string;
  row: number;
}

function collectResidentIds(
  headers: string[],
  dataRows: Grid,
  sheetName: string,
  url: string,
  entries: ResidentIdEntry[]
): void {
  const col = headers.indexOf('resident_id');
  if (col === -1) return;
  dataRows.forEach((row, i) => {
    const val = row[col];
    if (val !== '' && val !== null && val !== undefined) {
      entries.push({ id: String(val).trim(), sheet: sheetName, url, row: i + 2 });
    }
  });
}

function findDuplicateResidentIds(entries: ResidentIdEntry[]): DuplicateResidentRow[] {
  const map: Record<string, ResidentIdEntry[]> = {};
  for (const e of entries) {
    if (!map[e.id]) map[e.id] = [];
    map[e.id].push(e);
  }
  const rows: DuplicateResidentRow[] = [];
  for (const id of Object.keys(map)) {
    const group = map[id];
    if (group.length < 2) continue;
    const sheetNames = group.map((g) => g.sheet);
    const unique = sheetNames.filter((n, i) => sheetNames.indexOf(n) === i);
    const scope = unique.length === 1 ? 'Within Sheet' : 'Across Sheets';
    for (const e of group) {
      rows.push({
        residentId: e.id,
        spreadsheet: e.sheet,
        url: e.url,
        row: e.row,
        totalOccurrences: group.length,
        scope,
      });
    }
  }
  return rows;
}

// -------  Top-level audit (legacy runAudit, minus the spreadsheet writer)  -------

export function runAudit(masterGrid: Grid, sheets: SheetInput[]): AuditReport {
  const master = buildMasterModel(masterGrid);
  const skip = master.rowMembershipSkipReason;

  const masterSet: Record<string, true> = {};
  master.headers.forEach((h) => (masterSet[h] = true));

  const sheetAudits: SheetAudit[] = [];
  const columnDetail: ColumnDetailRow[] = [];
  const residentIdEntries: ResidentIdEntry[] = [];
  const missingRowsAll: MissingRow[] = [];
  const extraRowsAll: ExtraRow[] = [];
  const missingSitusAll: MissingSitusRow[] = [];
  const apnInconsistencyAll: ApnInconsistencyRow[] = [];

  for (const file of sheets) {
    const name = file.name;
    const url = file.url || '';

    if (file.error) {
      sheetAudits.push(errorAudit(name, url, file.error));
      continue;
    }

    const data = normalizeGrid(file.data || []);
    if (data.length === 0) {
      sheetAudits.push(emptyAudit(name, url));
      continue;
    }

    const headers = trimHeaders(data[0]);
    const dataRows = data.slice(1);
    const totalDataRows = dataRows.length;

    const assignedZone = detectSheetZone(headers, dataRows);

    collectResidentIds(headers, dataRows, name, url, residentIdEntries);

    const missingSitus = collectRowsMissingSitusAddress(headers, dataRows, name, url, assignedZone);
    for (const ms of missingSitus) missingSitusAll.push(ms);

    const sheetSet: Record<string, true> = {};
    headers.forEach((h) => {
      if (h !== '') sheetSet[h] = true;
    });

    const missing = master.headers.filter((h) => !sheetSet[h]);
    const extra = headers.filter((h) => h !== '' && !masterSet[h]);

    let status: SheetStatus = 'Match';
    if (missing.length > 0 && extra.length > 0) status = 'Missing + Extra';
    else if (missing.length > 0) status = 'Missing Columns';
    else if (extra.length > 0) status = 'Extra Columns';

    const apnCount = countNonBlankInColumn(headers, dataRows, 'APN');
    const damageCount = countNonBlankInColumn(headers, dataRows, 'Damage');
    const missingApn = countUniqueAddressesMissingApn(headers, dataRows);
    const apnInconsistencyRows = collectApnInconsistencies(headers, dataRows, name, url, assignedZone);
    for (const ai of apnInconsistencyRows) apnInconsistencyAll.push(ai);

    let missingRows: Count = 'N/A';
    let extraNotInMaster: Count = 'N/A';
    let extraWrongZone: Count = 'N/A';
    if (skip === '') {
      const membership = computeRowMembership(headers, dataRows, name, url, assignedZone, master);
      for (const mi of membership.missing) missingRowsAll.push(mi);
      for (const mx of membership.extra) extraRowsAll.push(mx);
      missingRows = membership.missingCount;
      extraNotInMaster = membership.extraNotInMasterCount;
      extraWrongZone = membership.extraWrongZoneCount;
    }

    sheetAudits.push({
      name,
      url,
      status,
      totalColumns: headers.filter((h) => h !== '').length,
      dataRows: totalDataRows,
      apnValues: apnCount,
      damageValues: damageCount,
      addressesMissingApn: missingApn,
      zone: assignedZone,
      apnInconsistentAddresses: apnInconsistencyRows.length,
      missingRows,
      extraNotInMaster,
      extraWrongZone,
      missingColumns: missing,
      extraColumns: extra,
    });

    headers.forEach((header, colIdx) => {
      if (header === '') return;
      let nonBlank = 0;
      for (const row of dataRows) {
        const val = row[colIdx];
        if (val !== '' && val !== null && val !== undefined) nonBlank++;
      }
      columnDetail.push({
        spreadsheet: name,
        column: header,
        position: columnLetter(colIdx),
        inMaster: Boolean(masterSet[header]),
        nonBlank,
        totalDataRows,
      });
    });
  }

  const duplicateResidentIds = findDuplicateResidentIds(residentIdEntries);

  const summary = buildSummary(
    sheetAudits,
    duplicateResidentIds,
    missingRowsAll,
    extraRowsAll,
    missingSitusAll,
    apnInconsistencyAll,
    skip
  );

  return {
    generatedAt: new Date().toISOString(),
    masterHeaders: master.headers,
    summary,
    sheets: sheetAudits,
    columnDetail,
    duplicateResidentIds,
    missingRows: missingRowsAll,
    extraRows: extraRowsAll,
    missingSitusRows: missingSitusAll,
    apnInconsistencies: apnInconsistencyAll,
  };
}

function errorAudit(name: string, url: string, error: string): SheetAudit {
  return {
    name,
    url,
    status: 'ERROR',
    error,
    totalColumns: 0,
    dataRows: 0,
    apnValues: 'N/A',
    damageValues: 'N/A',
    addressesMissingApn: 'N/A',
    zone: '',
    apnInconsistentAddresses: 0,
    missingRows: 'N/A',
    extraNotInMaster: 'N/A',
    extraWrongZone: 'N/A',
    missingColumns: [],
    extraColumns: [],
  };
}

function emptyAudit(name: string, url: string): SheetAudit {
  return {
    name,
    url,
    status: 'Empty',
    totalColumns: 0,
    dataRows: 0,
    apnValues: 'N/A',
    damageValues: 'N/A',
    addressesMissingApn: 'N/A',
    zone: '',
    apnInconsistentAddresses: 0,
    missingRows: 'N/A',
    extraNotInMaster: 'N/A',
    extraWrongZone: 'N/A',
    missingColumns: [],
    extraColumns: [],
  };
}

function num(v: Count): number {
  return typeof v === 'number' ? v : 0;
}

function buildSummary(
  sheets: SheetAudit[],
  duplicates: DuplicateResidentRow[],
  missingRows: MissingRow[],
  extraRows: ExtraRow[],
  missingSitus: MissingSitusRow[],
  apnInconsistencies: ApnInconsistencyRow[],
  rowMembershipSkipReason: string
): AuditSummary {
  const distinctDuplicates = new Set(duplicates.map((d) => d.residentId)).size;
  let totalDataRows = 0;
  let sheetsWithErrors = 0;
  let sheetsEmpty = 0;
  let sheetsMatching = 0;
  let sheetsWithColumnDrift = 0;
  let totalAddressesMissingApn = 0;

  for (const s of sheets) {
    totalDataRows += s.dataRows;
    if (s.status === 'ERROR') sheetsWithErrors++;
    else if (s.status === 'Empty') sheetsEmpty++;
    else if (s.status === 'Match') sheetsMatching++;
    if (s.status === 'Missing Columns' || s.status === 'Extra Columns' || s.status === 'Missing + Extra') {
      sheetsWithColumnDrift++;
    }
    totalAddressesMissingApn += num(s.addressesMissingApn);
  }

  return {
    sheetsScanned: sheets.length,
    sheetsWithErrors,
    sheetsEmpty,
    sheetsMatching,
    sheetsWithColumnDrift,
    totalDataRows,
    duplicateResidentIds: distinctDuplicates,
    totalMissingRows: missingRows.length,
    totalExtraNotInMaster: extraRows.filter((e) => e.reason === 'Not in master').length,
    totalExtraWrongZone: extraRows.filter((e) => e.reason === 'Wrong zone').length,
    totalAddressesMissingApn,
    totalApnInconsistencies: apnInconsistencies.length,
    totalMissingSitus: missingSitus.length,
    rowMembershipSkipReason,
  };
}

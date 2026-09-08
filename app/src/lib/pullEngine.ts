// Use Case 2: bring captain edits back into the master. Pure planning only —
// no I/O — mirroring mergeEngine/zoneEngine so the safety model stays testable.
//
// Direction is the reverse of planCellFill: the captain sheet is the source and
// the master is the target, matched by resident_id. Every proposed cell passes
// through the write guard, so a captain value can only replace a non-blank
// master value when that column's policy is explicitly `overwrite`. Everything
// else that disagrees becomes a conflict for the Operator to triage.
//
// Behavioral source of truth: legacy `pullDataIntoMaster_` in MergeEngine.gs.
// One deliberate difference: this planner never appends new master rows. Rows
// present only on a captain sheet are reported as `unmatchedResidents` so the
// Operator can decide, keeping this slice reversible cell-by-cell.

import { createHash } from 'node:crypto';
import { trimHeaders, type Grid } from './mergeEngine';
import { isZoneDashboardSalesField } from './salesFieldPolicy';
import { decideWrite, normalizePolicy, type Policy } from './writeGuard';
import {
  ADDRESS_PLACEHOLDER_COLUMN,
  ADDRESS_PLACEHOLDER_NAME,
  isAddressPlaceholderName,
  isAddressPlaceholderValue,
} from './addressPlaceholder';
import {
  type CellValue,
  type FieldCompareMeta,
  type FieldMetaMap,
  isSuspectedTextCoercion,
  normalizeForCompare,
  valueForTypedWrite,
} from './values';

export interface PullCellChange {
  residentId: string;
  residentName: string;
  column: string;
  masterRow: number; // 1-based sheet row
  masterCol: number; // 1-based sheet column
  captainRow: number; // 1-based sheet row
  masterValue: CellValue;
  captainValue: CellValue;
  policy: Policy;
  fieldMeta?: FieldCompareMeta;
  masterNormalized: string;
  captainNormalized: string;
  suspectedTextCoercion: boolean;
}

export interface PullSkip {
  residentId: string;
  column: string;
  reason: string;
}

export interface UnmatchedResident {
  residentId: string;
  residentName: string;
  captainRow: number;
}

export interface PullToMasterPlan {
  fills: PullCellChange[];
  overwrites: PullCellChange[];
  conflicts: PullCellChange[];
  skipped: PullSkip[];
  unmatchedResidents: UnmatchedResident[];
  columnsCompared: string[];
  errors: string[];
  fingerprint: string;
}

export interface PullToMasterOptions {
  /** Per-column policy, usually the Field Dictionary's default_policy. */
  policies?: Record<string, string>;
  /** Per-column Field Dictionary data_type/is_text_safe semantics. */
  fieldMeta?: FieldMetaMap;
  /** Policy for columns with no entry. Legacy default is conflict-only. */
  defaultPolicy?: string;
  identityColumn?: string;
  nameColumn?: string;
  /** Restrict the comparison to these columns (default: all shared columns). */
  columns?: string[];
}

/** The identity of one approved cell, stable across JSON round-trips. */
export interface PullCellKey {
  residentId: string;
  column: string;
  value: string;
}

export function pullCellValueKey(value: CellValue): string {
  return value instanceof Date ? value.toISOString() : text(value);
}

export function fingerprintPullCells(cells: PullCellKey[]): string {
  const lines = cells.map((cell) => `${cell.residentId}\t${cell.column}\t${cell.value}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function fingerprintPullChanges(changes: PullCellChange[]): string {
  return fingerprintPullCells(
    changes.map((change) => ({
      residentId: change.residentId,
      column: change.column,
      value: pullCellValueKey(change.captainValue),
    }))
  );
}

/**
 * Compare one captain sheet against the master and plan what should come back.
 * Writes are proposed only for columns both sheets carry; identity columns are
 * never written.
 */
export function planPullToMaster(
  masterGrid: Grid,
  captainGrid: Grid,
  options: PullToMasterOptions = {}
): PullToMasterPlan {
  const identityColumn = options.identityColumn || 'resident_id';
  const nameColumn = options.nameColumn || 'Resident Name';
  const defaultPolicy = options.defaultPolicy || 'conflict';
  const policies = options.policies || {};
  const fieldMeta = options.fieldMeta || {};

  const plan: PullToMasterPlan = {
    fills: [],
    overwrites: [],
    conflicts: [],
    skipped: [],
    unmatchedResidents: [],
    columnsCompared: [],
    errors: [],
    fingerprint: fingerprintPullChanges([]),
  };

  const masterHeaders = trimHeaders(masterGrid[0]);
  const captainHeaders = trimHeaders(captainGrid[0]);
  const masterIdCol = masterHeaders.indexOf(identityColumn);
  const captainIdCol = captainHeaders.indexOf(identityColumn);
  if (masterIdCol === -1) {
    plan.errors.push(`The master has no ${identityColumn} column.`);
    return plan;
  }
  if (captainIdCol === -1) {
    plan.errors.push(`The captain sheet has no ${identityColumn} column.`);
    return plan;
  }

  const restrict = options.columns && options.columns.length > 0 ? new Set(options.columns) : null;
  const comparable: Array<{
    column: string;
    masterCol: number;
    captainCol: number;
    policy: Policy;
    fieldMeta?: FieldCompareMeta;
  }> = [];
  for (let captainCol = 0; captainCol < captainHeaders.length; captainCol++) {
    const column = captainHeaders[captainCol];
    if (!column || column === identityColumn) continue;
    if (isZoneDashboardSalesField(column)) continue;
    if (restrict && !restrict.has(column)) continue;
    const masterCol = masterHeaders.indexOf(column);
    if (masterCol === -1) continue;
    if (comparable.some((entry) => entry.column === column)) continue;
    const policy = normalizePolicy(policies[column]) || normalizePolicy(defaultPolicy) || 'conflict';
    comparable.push({ column, masterCol, captainCol, policy, fieldMeta: fieldMeta[column] });
  }
  plan.columnsCompared = comparable.map((entry) => entry.column);
  if (comparable.length === 0) {
    plan.errors.push('The master and captain sheet share no comparable columns.');
    return plan;
  }

  const masterNameCol = masterHeaders.indexOf(nameColumn);
  const captainNameCol = captainHeaders.indexOf(nameColumn);
  const masterRowsById = new Map<string, number[]>();
  for (let row = 1; row < masterGrid.length; row++) {
    const residentId = identity(masterGrid[row]?.[masterIdCol]);
    if (!residentId) continue;
    const rows = masterRowsById.get(residentId) ?? [];
    rows.push(row);
    masterRowsById.set(residentId, rows);
  }

  const seenCaptainIds = new Set<string>();
  for (let row = 1; row < captainGrid.length; row++) {
    const captainRow = captainGrid[row] || [];
    const residentId = identity(captainRow[captainIdCol]);
    if (!residentId) continue;
    if (seenCaptainIds.has(residentId)) {
      plan.skipped.push({
        residentId,
        column: '',
        reason: 'This resident appears more than once on the captain sheet; only the first row was used.',
      });
      continue;
    }
    seenCaptainIds.add(residentId);

    const residentName =
      (captainNameCol !== -1 ? text(captainRow[captainNameCol]) : '') || '';
    const masterRows = masterRowsById.get(residentId) ?? [];
    if (masterRows.length === 0) {
      plan.unmatchedResidents.push({ residentId, residentName, captainRow: row + 1 });
      continue;
    }
    if (masterRows.length > 1) {
      plan.skipped.push({
        residentId,
        column: '',
        reason: 'This resident appears more than once on the master; the row is ambiguous.',
      });
      continue;
    }

    const masterRowIndex = masterRows[0];
    const masterRow = masterGrid[masterRowIndex] || [];
    const nameForLog =
      residentName || (masterNameCol !== -1 ? text(masterRow[masterNameCol]) : '');

    for (const entry of comparable) {
      const rawCaptainValue = captainRow[entry.captainCol];
      const captainValue = valueForTypedWrite(rawCaptainValue, entry.fieldMeta);
      const masterValue = masterRow[entry.masterCol];
      const decision = decideWrite({
        column: entry.column,
        target: masterValue,
        source: captainValue,
        policy: entry.policy,
        fieldMeta: entry.fieldMeta,
      });
      const change: PullCellChange = {
        residentId,
        residentName: nameForLog,
        column: entry.column,
        masterRow: masterRowIndex + 1,
        masterCol: entry.masterCol + 1,
        captainRow: row + 1,
        masterValue,
        captainValue,
        policy: decision.effectivePolicy,
        fieldMeta: entry.fieldMeta,
        masterNormalized: normalizeForCompare(masterValue, entry.fieldMeta),
        captainNormalized: normalizeForCompare(rawCaptainValue, entry.fieldMeta),
        suspectedTextCoercion:
          isSuspectedTextCoercion(masterValue, entry.fieldMeta) ||
          isSuspectedTextCoercion(rawCaptainValue, entry.fieldMeta),
      };

      if (decision.action === 'fill') plan.fills.push(change);
      else if (decision.action === 'overwrite') plan.overwrites.push(change);
      else if (decision.action === 'conflict') plan.conflicts.push(change);
      else if (decision.action === 'skip' && decision.effectivePolicy === 'never') {
        plan.skipped.push({ residentId, column: entry.column, reason: decision.reason });
      }
      // Blank captain values and equal values are intentionally silent.
    }
  }

  plan.fingerprint = fingerprintPullChanges([...plan.fills, ...plan.overwrites]);
  return plan;
}

// ---- Captain-created residents (whole new master rows) ----

export type DuplicateRisk = 'likely' | 'possible' | 'none';

export interface NewResidentCandidate {
  residentId: string;
  residentName: string;
  addressPlaceholder: boolean;
  captainRow: number;
  /** Values ordered to match the master's headers, ready to append. */
  row: CellValue[];
  /** Human-readable property, for the approval table. */
  property: string;
  filledColumns: number;
  risk: DuplicateRisk;
  /** Why the row was flagged; empty when risk is 'none'. */
  riskReason: string;
  /** The master (or in-batch) resident this may duplicate. */
  matchedResidentId: string;
  missingRequired: string[];
}

export interface NewResidentsPlan {
  candidates: NewResidentCandidate[];
  skipped: PullSkip[];
  columnsOnlyOnCaptain: string[];
  errors: string[];
  fingerprint: string;
}

export interface NewResidentsOptions {
  identityColumn?: string;
  nameColumn?: string;
  /** Parcel key. Shared by everyone at an address, so never a signal on its own. */
  apnColumn?: string;
  emailColumn?: string;
  phoneColumns?: string[];
  /** Columns a new master row must carry to be proposed at all. */
  requiredColumns?: string[];
  /** Canonical headers and dictionary aliases that must never be imported. */
  forbiddenColumns?: string[];
}

/**
 * Plan whole new master rows for residents a captain added to their sheet.
 *
 * Duplicate detection is deliberately person-level. A shared APN means only
 * that two people live at the same address, which is normal and common, so it
 * is never a duplicate signal by itself. What flags a row is the same *person*
 * appearing again: the same name at the same parcel, or a re-used email.
 */
export function planPullNewResidents(
  masterGrid: Grid,
  captainGrid: Grid,
  options: NewResidentsOptions = {}
): NewResidentsPlan {
  const identityColumn = options.identityColumn || 'resident_id';
  const nameColumn = options.nameColumn || 'Resident Name';
  const apnColumn = options.apnColumn || 'APN';
  const emailColumn = options.emailColumn || 'Email';
  const requiredColumns = options.requiredColumns ?? [nameColumn];

  const plan: NewResidentsPlan = {
    candidates: [],
    skipped: [],
    columnsOnlyOnCaptain: [],
    errors: [],
    fingerprint: fingerprintPullCells([]),
  };

  const masterHeaders = trimHeaders(masterGrid[0]);
  const captainHeaders = trimHeaders(captainGrid[0]);
  const masterIdCol = masterHeaders.indexOf(identityColumn);
  const captainIdCol = captainHeaders.indexOf(identityColumn);
  if (masterIdCol === -1) {
    plan.errors.push(`The master has no ${identityColumn} column.`);
    return plan;
  }
  if (captainIdCol === -1) {
    plan.errors.push(`The captain sheet has no ${identityColumn} column.`);
    return plan;
  }

  plan.columnsOnlyOnCaptain = captainHeaders.filter(
    (header) => header !== '' && !masterHeaders.includes(header)
  );

  const masterIds = new Set<string>();
  // person key -> resident_id already on the master
  const masterByNameAndParcel = new Map<string, string>();
  const masterByEmail = new Map<string, string>();
  const masterByName = new Map<string, string>();
  const masterName = columnReader(masterHeaders, nameColumn);
  const masterApn = columnReader(masterHeaders, apnColumn);
  const masterEmail = columnReader(masterHeaders, emailColumn);
  const masterPlaceholder = columnReader(masterHeaders, ADDRESS_PLACEHOLDER_COLUMN);

  for (let row = 1; row < masterGrid.length; row++) {
    const cells = masterGrid[row] || [];
    const residentId = identity(cells[masterIdCol]);
    if (!residentId) continue;
    masterIds.add(residentId);
    if (isAddressPlaceholderValue(masterPlaceholder(cells))) continue;
    const name = normalizeKey(masterName(cells));
    const apn = normalizeKey(masterApn(cells));
    const email = normalizeKey(masterEmail(cells));
    if (name && apn && !masterByNameAndParcel.has(`${name}|${apn}`)) {
      masterByNameAndParcel.set(`${name}|${apn}`, residentId);
    }
    if (email && !masterByEmail.has(email)) masterByEmail.set(email, residentId);
    if (name && !masterByName.has(name)) masterByName.set(name, residentId);
  }

  const captainName = columnReader(captainHeaders, nameColumn);
  const captainApn = columnReader(captainHeaders, apnColumn);
  const captainEmail = columnReader(captainHeaders, emailColumn);
  const captainPlaceholder = columnReader(captainHeaders, ADDRESS_PLACEHOLDER_COLUMN);
  const houseReader = columnReader(captainHeaders, '_SitusHouseNo', 'House');
  const streetReader = columnReader(captainHeaders, '_SitusStreet', 'Street');

  // In-batch duplicates matter too: the same person can appear twice in the
  // rows a captain appended.
  const batchByNameAndParcel = new Map<string, string>();
  const batchByEmail = new Map<string, string>();
  const seenIds = new Set<string>();

  for (let row = 1; row < captainGrid.length; row++) {
    const cells = captainGrid[row] || [];
    const residentId = identity(cells[captainIdCol]);
    if (!residentId) {
      if (cells.some((cell) => text(cell) !== '')) {
        plan.skipped.push({
          residentId: '',
          column: '',
          reason: `Captain row ${row + 1} has no ${identityColumn}, so it cannot be added safely.`,
        });
      }
      continue;
    }
    if (masterIds.has(residentId)) continue; // already on the master; the cell pull handles it
    if (seenIds.has(residentId)) {
      plan.skipped.push({
        residentId,
        column: '',
        reason: 'This resident appears more than once on the captain sheet; only the first row was used.',
      });
      continue;
    }
    seenIds.add(residentId);

    const name = text(captainName(cells));
    const addressPlaceholder =
      isAddressPlaceholderValue(captainPlaceholder(cells)) || isAddressPlaceholderName(name);
    const nameKey = normalizeKey(name);
    const apnKey = normalizeKey(captainApn(cells));
    const emailKey = normalizeKey(captainEmail(cells));

    let risk: DuplicateRisk = 'none';
    let riskReason = '';
    let matchedResidentId = '';
    const nameAndParcel = nameKey && apnKey ? `${nameKey}|${apnKey}` : '';

    if (!addressPlaceholder && nameAndParcel && masterByNameAndParcel.has(nameAndParcel)) {
      risk = 'likely';
      matchedResidentId = masterByNameAndParcel.get(nameAndParcel)!;
      riskReason = 'The master already has this name at this same parcel, under a different resident_id.';
    } else if (!addressPlaceholder && emailKey && masterByEmail.has(emailKey)) {
      risk = 'likely';
      matchedResidentId = masterByEmail.get(emailKey)!;
      riskReason = 'The master already has this email address, under a different resident_id.';
    } else if (!addressPlaceholder && nameAndParcel && batchByNameAndParcel.has(nameAndParcel)) {
      risk = 'likely';
      matchedResidentId = batchByNameAndParcel.get(nameAndParcel)!;
      riskReason = 'Another row in this same batch has this name at this parcel.';
    } else if (!addressPlaceholder && emailKey && batchByEmail.has(emailKey)) {
      risk = 'likely';
      matchedResidentId = batchByEmail.get(emailKey)!;
      riskReason = 'Another row in this same batch has this email address.';
    } else if (!addressPlaceholder && nameKey && masterByName.has(nameKey)) {
      risk = 'possible';
      matchedResidentId = masterByName.get(nameKey)!;
      riskReason = 'Someone with this name is already on the master, but at a different parcel.';
    }

    if (!addressPlaceholder && nameAndParcel && !batchByNameAndParcel.has(nameAndParcel)) {
      batchByNameAndParcel.set(nameAndParcel, residentId);
    }
    if (!addressPlaceholder && emailKey && !batchByEmail.has(emailKey)) {
      batchByEmail.set(emailKey, residentId);
    }

    const mapped = remapToMasterHeaders(cells, captainHeaders, masterHeaders, options.forbiddenColumns);
    const mappedPlaceholderCol = masterHeaders.indexOf(ADDRESS_PLACEHOLDER_COLUMN);
    if (mappedPlaceholderCol !== -1) mapped[mappedPlaceholderCol] = addressPlaceholder;
    const mappedNameCol = masterHeaders.indexOf(nameColumn);
    if (addressPlaceholder && mappedNameCol !== -1 && isAddressPlaceholderName(name)) {
      mapped[mappedNameCol] = ADDRESS_PLACEHOLDER_NAME;
    }
    const missingRequired = requiredColumns.filter((column) => {
      const index = masterHeaders.indexOf(column);
      return index === -1 || text(mapped[index]) === '';
    });
    if (addressPlaceholder) {
      for (const column of [nameColumn, ADDRESS_PLACEHOLDER_COLUMN]) {
        const index = masterHeaders.indexOf(column);
        if ((index === -1 || text(mapped[index]) === '') && !missingRequired.includes(column)) {
          missingRequired.push(column);
        }
      }
      if (!isAddressPlaceholderName(name) && !missingRequired.includes(nameColumn)) {
        missingRequired.push(nameColumn);
      }
    }
    const house = text(houseReader(cells));
    const street = text(streetReader(cells));
    const apn = text(captainApn(cells));

    plan.candidates.push({
      residentId,
      residentName: name,
      addressPlaceholder,
      captainRow: row + 1,
      row: mapped,
      property: [`${house} ${street}`.trim(), apn ? `APN ${apn}` : ''].filter(Boolean).join(' · '),
      filledColumns: mapped.filter((cell) => text(cell) !== '').length,
      risk,
      riskReason,
      matchedResidentId,
      missingRequired,
    });
  }

  plan.fingerprint = fingerprintPullCells(newResidentCellKeys(plan.candidates));
  return plan;
}

/**
 * Fingerprint inputs for whole candidate rows, so an approved subset can be
 * re-verified against a freshly read sheet without storing the rows twice.
 */
export function newResidentCellKeys(candidates: NewResidentCandidate[]): PullCellKey[] {
  return candidates.map((candidate) => ({
    residentId: candidate.residentId,
    column: '__row',
    value: candidate.row.map((cell) => pullCellValueKey(cell)).join('\u0001'),
  }));
}

// ---- Folder-wide captain-created residents, grouped by address ----

export interface CaptainPullSheet {
  spreadsheetId: string;
  spreadsheetName: string;
  tabName: string;
  zone: string;
  grid: Grid;
}

export interface FolderNewResident extends NewResidentCandidate {
  addressId: string;
  sourceSpreadsheetId: string;
  sourceSpreadsheetName: string;
  sourceTabName: string;
  sourceZone: string;
}

export interface FolderNewAddress {
  addressId: string;
  displayAddress: string;
  kind: 'new_address' | 'existing_address';
  sourceSpreadsheetId: string;
  sourceSpreadsheetName: string;
  sourceTabName: string;
  sourceZone: string;
  residents: FolderNewResident[];
  risk: DuplicateRisk;
}

export interface FolderPullBlock {
  code:
    | 'missing_address_id'
    | 'duplicate_resident'
    | 'split_across_sheets'
    | 'address_id_mismatch'
    | 'missing_required_field';
  addressId: string;
  residentIds: string[];
  reason: string;
  displayAddress: string;
  sourceSpreadsheetId: string;
  sourceSpreadsheetName: string;
  sourceTabName: string;
  sourceRows: number[];
  masterAddressId?: string;
}

export interface FolderNewResidentsPlan {
  addresses: FolderNewAddress[];
  blocked: FolderPullBlock[];
  skipped: Array<PullSkip & { spreadsheetName: string }>;
  columnsOnlyOnCaptains: string[];
  errors: string[];
  fingerprint: string;
}

/**
 * Find captain-created residents across a whole folder and make address_id the
 * approval boundary. Ambiguous identities, missing address IDs, and households
 * split across captain sheets are blocked instead of guessed.
 */
export function planPullNewResidentsFromFolder(
  masterGrid: Grid,
  captainSheets: CaptainPullSheet[],
  options: NewResidentsOptions & { addressColumn?: string } = {}
): FolderNewResidentsPlan {
  const identityColumn = options.identityColumn || 'resident_id';
  const addressColumn = options.addressColumn || 'address_id';
  const masterHeaders = trimHeaders(masterGrid[0]);
  const masterIdCol = masterHeaders.indexOf(identityColumn);
  const masterAddressCol = masterHeaders.indexOf(addressColumn);
  const plan: FolderNewResidentsPlan = {
    addresses: [],
    blocked: [],
    skipped: [],
    columnsOnlyOnCaptains: [],
    errors: [],
    fingerprint: folderNewResidentsFingerprint([]),
  };
  if (masterIdCol === -1) plan.errors.push(`The master has no ${identityColumn} column.`);
  if (masterAddressCol === -1) plan.errors.push(`The master has no ${addressColumn} column.`);
  if (plan.errors.length > 0) return plan;

  const masterAddressIds = new Set(
    masterGrid.slice(1).map((row) => identity(row?.[masterAddressCol])).filter(Boolean)
  );
  const masterAddressIdsBySitus = new Map<string, Set<string>>();
  for (const row of masterGrid.slice(1)) {
    const addressId = identity(row?.[masterAddressCol]);
    const situs = normalizedSitusKey(masterHeaders, row);
    if (!addressId || !situs) continue;
    const ids = masterAddressIdsBySitus.get(situs) || new Set<string>();
    ids.add(addressId);
    masterAddressIdsBySitus.set(situs, ids);
  }
  const candidates: FolderNewResident[] = [];
  const occurrences = new Map<string, Array<{ addressId: string; spreadsheetId: string }>>();
  const droppedColumns = new Set<string>();

  for (const sheet of captainSheets) {
    const headers = trimHeaders(sheet.grid[0]);
    const idCol = headers.indexOf(identityColumn);
    const addressCol = headers.indexOf(addressColumn);
    if (idCol === -1) {
      plan.errors.push(`${sheet.spreadsheetName} has no ${identityColumn} column.`);
      continue;
    }
    if (addressCol === -1) {
      plan.errors.push(`${sheet.spreadsheetName} has no ${addressColumn} column.`);
      continue;
    }

    for (let rowIndex = 1; rowIndex < sheet.grid.length; rowIndex++) {
      const row = sheet.grid[rowIndex] || [];
      const residentId = identity(row[idCol]);
      if (!residentId) continue;
      const list = occurrences.get(residentId) || [];
      list.push({ addressId: identity(row[addressCol]), spreadsheetId: sheet.spreadsheetId });
      occurrences.set(residentId, list);
    }

    const sheetPlan = planPullNewResidents(masterGrid, sheet.grid, options);
    sheetPlan.columnsOnlyOnCaptain.forEach((column) => droppedColumns.add(column));
    plan.skipped.push(
      ...sheetPlan.skipped.map((skip) => ({ ...skip, spreadsheetName: sheet.spreadsheetName }))
    );
    for (const candidate of sheetPlan.candidates) {
      const sourceRow = sheet.grid[candidate.captainRow - 1] || [];
      candidates.push({
        ...candidate,
        addressId: identity(sourceRow[addressCol]),
        sourceSpreadsheetId: sheet.spreadsheetId,
        sourceSpreadsheetName: sheet.spreadsheetName,
        sourceTabName: sheet.tabName,
        sourceZone: sheet.zone,
      });
    }
  }
  plan.columnsOnlyOnCaptains = [...droppedColumns].sort();

  // Add cross-folder person duplicate warnings. A shared address is expected;
  // the same person key or email under another new resident_id is not.
  const nameCol = masterHeaders.indexOf(options.nameColumn || 'Resident Name');
  const emailCol = masterHeaders.indexOf(options.emailColumn || 'Email');
  const seenNameAtAddress = new Map<string, string>();
  const seenEmail = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.addressPlaceholder) continue;
    const name = nameCol === -1 ? '' : normalizeKey(candidate.row[nameCol]);
    const email = emailCol === -1 ? '' : normalizeKey(candidate.row[emailCol]);
    const personAtAddress = name && candidate.addressId ? `${name}|${normalizeKey(candidate.addressId)}` : '';
    const matched =
      (personAtAddress && seenNameAtAddress.get(personAtAddress)) || (email && seenEmail.get(email)) || '';
    if (matched && candidate.risk === 'none') {
      candidate.risk = 'likely';
      candidate.matchedResidentId = matched;
      candidate.riskReason = 'Another captain-created row appears to be this same person.';
    }
    if (personAtAddress && !seenNameAtAddress.has(personAtAddress)) {
      seenNameAtAddress.set(personAtAddress, candidate.residentId);
    }
    if (email && !seenEmail.has(email)) seenEmail.set(email, candidate.residentId);
  }

  const byAddress = new Map<string, FolderNewResident[]>();
  const addressesWithRealCandidates = new Set(
    candidates
      .filter((candidate) => !candidate.addressPlaceholder && candidate.addressId)
      .map((candidate) => candidate.addressId)
  );
  for (const candidate of candidates) {
    if (
      candidate.addressPlaceholder &&
      candidate.addressId &&
      (masterAddressIds.has(candidate.addressId) || addressesWithRealCandidates.has(candidate.addressId))
    ) {
      plan.skipped.push({
        residentId: candidate.residentId,
        column: ADDRESS_PLACEHOLDER_COLUMN,
        reason: 'This address already has a master row or a real new resident, so its extra placeholder was not imported.',
        spreadsheetName: candidate.sourceSpreadsheetName,
      });
      continue;
    }
    const key = candidate.addressId || `__missing__:${candidate.sourceSpreadsheetId}:${candidate.residentId}`;
    const group = byAddress.get(key) || [];
    group.push(candidate);
    byAddress.set(key, group);
  }

  for (const residents of byAddress.values()) {
    const addressId = residents[0].addressId;
    const residentIds = residents.map((resident) => resident.residentId);
    const first = residents[0];
    const matchingMasterAddressIds = masterAddressIdsBySitus.get(
      normalizedSitusKey(masterHeaders, first.row)
    );
    const duplicateIdentity = residents.find(
      (resident) => (occurrences.get(resident.residentId)?.length || 0) > 1
    );
    const duplicatePlaceholders = residents.filter((resident) => resident.addressPlaceholder);
    const invalidPlaceholder = duplicatePlaceholders.find(
      (resident) => !isAddressPlaceholderName(resident.residentName)
    );
    const sourceIds = new Set(residents.map((resident) => resident.sourceSpreadsheetId));
    let reason = '';
    let code: FolderPullBlock['code'] = 'missing_required_field';
    let masterAddressId: string | undefined;
    if (!addressId) {
      code = 'missing_address_id';
      reason = `A captain-created resident has no ${addressColumn}.`;
    }
    else if (duplicateIdentity) {
      code = 'duplicate_resident';
      reason = `Resident ${duplicateIdentity.residentId} appears more than once in the captain folder.`;
    } else if (duplicatePlaceholders.length > 1) {
      code = 'duplicate_resident';
      reason = 'This new address has more than one placeholder row. Keep one placeholder before importing it.';
    } else if (sourceIds.size > 1) {
      code = 'split_across_sheets';
      reason = 'Residents at this address appear on more than one captain sheet.';
    } else if (
      !masterAddressIds.has(addressId) &&
      matchingMasterAddressIds &&
      !matchingMasterAddressIds.has(addressId)
    ) {
      const matches = [...matchingMasterAddressIds].sort();
      code = 'address_id_mismatch';
      masterAddressId = matches.length === 1 ? matches[0] : undefined;
      reason =
        matches.length === 1
          ? `${first.property || 'This address'} already exists on the master as address_id ${matches[0]}. ` +
            `The captain row uses a different address_id and must be reconciled before import.`
          : `${first.property || 'This address'} matches multiple master address IDs. Reconcile the duplicate addresses before import.`;
    } else if (invalidPlaceholder) {
      code = 'missing_required_field';
      reason = 'Address Placeholder is TRUE, but Resident Name is not exactly "Placeholder Resident".';
    } else if (residents.some((resident) => resident.missingRequired.length > 0)) {
      code = 'missing_required_field';
      reason = 'At least one resident is missing a required field.';
    }
    if (reason) {
      plan.blocked.push({
        code,
        addressId,
        residentIds,
        reason,
        displayAddress: first.property,
        sourceSpreadsheetId: first.sourceSpreadsheetId,
        sourceSpreadsheetName: first.sourceSpreadsheetName,
        sourceTabName: first.sourceTabName,
        sourceRows: residents.map((resident) => resident.captainRow).sort((a, b) => a - b),
        masterAddressId,
      });
      continue;
    }

    plan.addresses.push({
      addressId,
      displayAddress: first.property,
      kind: masterAddressIds.has(addressId) ? 'existing_address' : 'new_address',
      sourceSpreadsheetId: first.sourceSpreadsheetId,
      sourceSpreadsheetName: first.sourceSpreadsheetName,
      sourceTabName: first.sourceTabName,
      sourceZone: first.sourceZone,
      residents,
      risk: residents.some((resident) => resident.risk === 'likely')
        ? 'likely'
        : residents.some((resident) => resident.risk === 'possible')
          ? 'possible'
          : 'none',
    });
  }

  plan.addresses.sort((a, b) => a.displayAddress.localeCompare(b.displayAddress) || a.addressId.localeCompare(b.addressId));
  plan.fingerprint = folderNewResidentsFingerprint(plan.addresses);
  return plan;
}

function normalizedSitusKey(headers: string[], row: CellValue[]): string {
  const house = normalizeKey(columnReader(headers, '_SitusHouseNo', 'House')(row));
  const direction = normalizeKey(columnReader(headers, '_SitusDirection')(row));
  const street = normalizeKey(columnReader(headers, '_SitusStreet', 'Street')(row));
  const unit = normalizeKey(columnReader(headers, '_SitusUnit')(row));
  if (!house || !street) return '';
  return [house, direction, street, unit].join('|');
}

export function folderNewResidentsFingerprint(addresses: FolderNewAddress[]): string {
  const lines = addresses
    .flatMap((address) =>
      address.residents.map(
        (resident) =>
          `${address.addressId}\t${address.kind}\t${address.risk}\t${resident.sourceSpreadsheetId}\t${
            resident.residentId
          }\t${resident.risk}\t${resident.matchedResidentId}\t${resident.row
            .map((cell) => pullCellValueKey(cell))
            .join('\u0001')}`
      )
    )
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function remapToMasterHeaders(
  cells: CellValue[],
  captainHeaders: string[],
  masterHeaders: string[],
  forbiddenColumns: string[] = []
): CellValue[] {
  const byHeader = new Map<string, CellValue>();
  const forbidden = new Set(forbiddenColumns.map((header) => String(header).trim().toLocaleLowerCase()));
  captainHeaders.forEach((header, index) => {
    if (header && !byHeader.has(header)) byHeader.set(header, cells[index]);
  });
  return masterHeaders.map((header) =>
    header &&
    !isZoneDashboardSalesField(header) &&
    !forbidden.has(header.trim().toLocaleLowerCase())
      ? (byHeader.get(header) ?? '')
      : ''
  );
}

function columnReader(headers: string[], ...candidates: string[]): (cells: CellValue[]) => CellValue {
  const indexes = candidates.map((candidate) => headers.indexOf(candidate)).filter((index) => index !== -1);
  return (cells: CellValue[]) => {
    for (const index of indexes) {
      const value = cells[index];
      if (text(value) !== '') return value;
    }
    return '';
  };
}

function normalizeKey(value: CellValue): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function identity(value: CellValue): string {
  const value_ = text(value);
  return value_ === 'undefined' || value_ === 'null' ? '' : value_;
}

function text(value: CellValue): string {
  return String(value == null ? '' : value).trim();
}

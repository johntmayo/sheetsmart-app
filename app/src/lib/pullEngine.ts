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
import { decideWrite, normalizePolicy, type Policy } from './writeGuard';
import type { CellValue } from './values';

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
  const comparable: Array<{ column: string; masterCol: number; captainCol: number; policy: Policy }> = [];
  for (let captainCol = 0; captainCol < captainHeaders.length; captainCol++) {
    const column = captainHeaders[captainCol];
    if (!column || column === identityColumn) continue;
    if (restrict && !restrict.has(column)) continue;
    const masterCol = masterHeaders.indexOf(column);
    if (masterCol === -1) continue;
    if (comparable.some((entry) => entry.column === column)) continue;
    const policy = normalizePolicy(policies[column]) || normalizePolicy(defaultPolicy) || 'conflict';
    comparable.push({ column, masterCol, captainCol, policy });
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
      const captainValue = captainRow[entry.captainCol];
      const masterValue = masterRow[entry.masterCol];
      const decision = decideWrite({
        column: entry.column,
        target: masterValue,
        source: captainValue,
        policy: entry.policy,
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

  for (let row = 1; row < masterGrid.length; row++) {
    const cells = masterGrid[row] || [];
    const residentId = identity(cells[masterIdCol]);
    if (!residentId) continue;
    masterIds.add(residentId);
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
  const houseReader = columnReader(captainHeaders, 'House', '_SitusHouseNo');
  const streetReader = columnReader(captainHeaders, 'Street', '_SitusStreet');

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
    const nameKey = normalizeKey(name);
    const apnKey = normalizeKey(captainApn(cells));
    const emailKey = normalizeKey(captainEmail(cells));

    let risk: DuplicateRisk = 'none';
    let riskReason = '';
    let matchedResidentId = '';
    const nameAndParcel = nameKey && apnKey ? `${nameKey}|${apnKey}` : '';

    if (nameAndParcel && masterByNameAndParcel.has(nameAndParcel)) {
      risk = 'likely';
      matchedResidentId = masterByNameAndParcel.get(nameAndParcel)!;
      riskReason = 'The master already has this name at this same parcel, under a different resident_id.';
    } else if (emailKey && masterByEmail.has(emailKey)) {
      risk = 'likely';
      matchedResidentId = masterByEmail.get(emailKey)!;
      riskReason = 'The master already has this email address, under a different resident_id.';
    } else if (nameAndParcel && batchByNameAndParcel.has(nameAndParcel)) {
      risk = 'likely';
      matchedResidentId = batchByNameAndParcel.get(nameAndParcel)!;
      riskReason = 'Another row in this same batch has this name at this parcel.';
    } else if (emailKey && batchByEmail.has(emailKey)) {
      risk = 'likely';
      matchedResidentId = batchByEmail.get(emailKey)!;
      riskReason = 'Another row in this same batch has this email address.';
    } else if (nameKey && masterByName.has(nameKey)) {
      risk = 'possible';
      matchedResidentId = masterByName.get(nameKey)!;
      riskReason = 'Someone with this name is already on the master, but at a different parcel.';
    }

    if (nameAndParcel && !batchByNameAndParcel.has(nameAndParcel)) {
      batchByNameAndParcel.set(nameAndParcel, residentId);
    }
    if (emailKey && !batchByEmail.has(emailKey)) batchByEmail.set(emailKey, residentId);

    const mapped = remapToMasterHeaders(cells, captainHeaders, masterHeaders);
    const missingRequired = requiredColumns.filter((column) => {
      const index = masterHeaders.indexOf(column);
      return index === -1 || text(mapped[index]) === '';
    });
    const house = text(houseReader(cells));
    const street = text(streetReader(cells));
    const apn = text(captainApn(cells));

    plan.candidates.push({
      residentId,
      residentName: name,
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

function remapToMasterHeaders(
  cells: CellValue[],
  captainHeaders: string[],
  masterHeaders: string[]
): CellValue[] {
  const byHeader = new Map<string, CellValue>();
  captainHeaders.forEach((header, index) => {
    if (header && !byHeader.has(header)) byHeader.set(header, cells[index]);
  });
  return masterHeaders.map((header) => (header ? (byHeader.get(header) ?? '') : ''));
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

// Pure Phase-C execution planning. Live routes must re-read the target and run
// proposals through this module immediately before calling Google. This avoids
// trusting stale row numbers from a preview and keeps every value behind the
// write guard.

import { cellValuesEqual, type CellValue } from './values';
import type { Grid } from './mergeEngine';
import { trimHeaders } from './mergeEngine';
import { decideAppendCell, decideWrite, type Policy, type WriteAction } from './writeGuard';

export interface IdentityCellProposal {
  residentId: string;
  column: string;
  value: CellValue;
  policy?: string;
}

export interface GuardedCellWrite {
  residentId: string;
  row: number;
  col: number;
  column: string;
  before: CellValue;
  after: CellValue;
  action: WriteAction;
  policy: Policy;
}

export interface RejectedProposal extends IdentityCellProposal {
  reason: string;
}

export interface GuardedCellPlan {
  writes: GuardedCellWrite[];
  conflicts: GuardedCellWrite[];
  skipped: RejectedProposal[];
  errors: string[];
}

export interface GuardedAppend {
  residentId: string;
  row: CellValue[];
}

export interface RejectedAppend {
  residentId: string;
  reason: string;
}

export interface GuardedAppendPlan {
  appends: GuardedAppend[];
  skipped: RejectedAppend[];
  errors: string[];
}

export interface AppendSnapshot {
  snapshotId: number;
  residentId: string;
  row: CellValue[];
}

export interface RevertableAppend {
  snapshotId: number;
  residentId: string;
  rowIndex: number; // zero-based grid index; also the Sheets API startIndex
  row: CellValue[];
}

export interface RejectedRevert {
  snapshotId: number;
  residentId: string;
  reason: string;
}

export interface AppendRevertPlan {
  deletions: RevertableAppend[];
  conflicts: RejectedRevert[];
  skipped: RejectedRevert[];
  errors: string[];
}

export interface CellSnapshot {
  snapshotId: number;
  residentId: string;
  column: string;
  rangeA1: string;
  before: CellValue;
  after: CellValue;
}

export interface RevertableCell {
  snapshotId: number;
  residentId: string;
  column: string;
  row: number;
  col: number;
  rangeA1: string;
  before: CellValue;
  after: CellValue;
}

export interface CellRevertPlan {
  restores: RevertableCell[];
  conflicts: RejectedRevert[];
  skipped: RejectedRevert[];
  errors: string[];
}

export interface GuardedDeletion {
  residentId: string;
  rowIndex: number; // zero-based grid index; Sheets API startIndex
  row: CellValue[];
}

export interface GuardedDeletePlan {
  deletions: GuardedDeletion[];
  skipped: RejectedAppend[];
  errors: string[];
}

export interface GuardedMove {
  residentId: string;
  appendRow: CellValue[];
  sourceRow: CellValue[];
  sourceRowIndex: number;
}

export interface GuardedMovePlan {
  moves: GuardedMove[];
  skipped: RejectedAppend[];
  errors: string[];
}

export interface RestorableRow {
  residentId: string;
  row: CellValue[];
  snapshotId: number;
}

export interface RowRestorePlan {
  appends: RestorableRow[];
  conflicts: RejectedRevert[];
  skipped: RejectedRevert[];
  errors: string[];
}

/** Extend the header row with any missing columns (appended at the right). */
export function ensureHeaderColumns(
  targetData: Grid,
  columnsToAdd: string[]
): { headers: string[]; added: string[]; addedIndexes: number[] } {
  const headers = trimHeaders(targetData[0]);
  const added: string[] = [];
  const addedIndexes: number[] = [];
  for (const column of columnsToAdd) {
    if (!column || headers.includes(column)) continue;
    headers.push(column);
    added.push(column);
    addedIndexes.push(headers.length); // 1-based Sheets column index
  }
  if (targetData[0]) {
    // Keep the in-memory grid aligned with the headers we will write.
    for (let i = 0; i < headers.length; i++) targetData[0][i] = headers[i];
  }
  return { headers, added, addedIndexes };
}

interface IdentityIndex {
  headerIndex: number;
  rowsById: Map<string, number[]>;
}

/**
 * Re-locate proposed cell changes by resident_id and re-run the write guard
 * against current target values. Ambiguous duplicate identities are never
 * written.
 */
export function planGuardedCellWrites(
  targetData: Grid,
  proposals: IdentityCellProposal[],
  identityColumn = 'resident_id'
): GuardedCellPlan {
  const plan: GuardedCellPlan = { writes: [], conflicts: [], skipped: [], errors: [] };
  const headers = trimHeaders(targetData[0]);
  const identity = buildIdentityIndex(targetData, headers, identityColumn);
  if (identity.headerIndex === -1) {
    plan.errors.push(`Target sheet has no ${identityColumn} column`);
    return plan;
  }

  const proposedCells = new Set<string>();
  for (const proposal of proposals) {
    const residentId = cleanIdentity(proposal.residentId);
    if (!residentId) {
      plan.skipped.push({ ...proposal, reason: `Blank ${identityColumn}` });
      continue;
    }

    const rows = identity.rowsById.get(residentId) ?? [];
    if (rows.length === 0) {
      plan.skipped.push({ ...proposal, reason: `${identityColumn} not found in current target` });
      continue;
    }
    if (rows.length > 1) {
      plan.skipped.push({ ...proposal, reason: `Duplicate ${identityColumn} in current target; row is ambiguous` });
      continue;
    }

    const colIndex = headers.indexOf(proposal.column);
    if (colIndex === -1) {
      plan.skipped.push({ ...proposal, reason: `Column "${proposal.column}" not found in current target` });
      continue;
    }

    const rowIndex = rows[0];
    const cellKey = `${residentId}\u0000${proposal.column}`;
    if (proposedCells.has(cellKey)) {
      plan.skipped.push({ ...proposal, reason: 'Duplicate proposal for the same resident and column' });
      continue;
    }
    proposedCells.add(cellKey);

    const before = targetData[rowIndex]?.[colIndex];
    const decision = decideWrite({
      column: proposal.column,
      target: before,
      source: proposal.value,
      policy: proposal.policy,
    });
    const guarded: GuardedCellWrite = {
      residentId,
      row: rowIndex + 1,
      col: colIndex + 1,
      column: proposal.column,
      before,
      after: proposal.value,
      action: decision.action,
      policy: decision.effectivePolicy,
    };
    if (decision.willWrite) {
      plan.writes.push(guarded);
    } else if (decision.action === 'conflict') {
      plan.conflicts.push(guarded);
    } else {
      plan.skipped.push({ ...proposal, reason: decision.reason });
    }
  }
  return plan;
}

/**
 * Re-check whole-row appends against the target's current resident identities.
 * Every candidate cell passes through decideAppendCell; blank cells are kept as
 * blanks and resident_id is allowed only because this creates a new row.
 */
export function planGuardedAppends(
  targetData: Grid,
  candidateRows: CellValue[][],
  identityColumn = 'resident_id'
): GuardedAppendPlan {
  const plan: GuardedAppendPlan = { appends: [], skipped: [], errors: [] };
  const headers = trimHeaders(targetData[0]);
  const identity = buildIdentityIndex(targetData, headers, identityColumn);
  if (identity.headerIndex === -1) {
    plan.errors.push(`Target sheet has no ${identityColumn} column`);
    return plan;
  }

  const seen = new Set(identity.rowsById.keys());
  for (const candidate of candidateRows) {
    const residentId = cleanIdentity(candidate[identity.headerIndex]);
    if (!residentId) {
      plan.skipped.push({ residentId: '', reason: `Blank ${identityColumn}` });
      continue;
    }
    if (seen.has(residentId)) {
      plan.skipped.push({ residentId, reason: `${identityColumn} already exists in current target` });
      continue;
    }

    const guardedRow = headers.map((column, index) => {
      const value = candidate[index];
      const decision = decideAppendCell({ column, source: value });
      return decision.willWrite ? value : '';
    });
    plan.appends.push({ residentId, row: guardedRow });
    seen.add(residentId);
  }
  return plan;
}

/**
 * Restore cells from a prior live write. A cell is restored only when its
 * resident_id is unique and the current value still matches the post-write
 * snapshot. Later edits become conflicts and are left alone.
 */
export function planCellRevert(
  targetData: Grid,
  snapshots: CellSnapshot[],
  identityColumn = 'resident_id'
): CellRevertPlan {
  const plan: CellRevertPlan = { restores: [], conflicts: [], skipped: [], errors: [] };
  const headers = trimHeaders(targetData[0]);
  const identity = buildIdentityIndex(targetData, headers, identityColumn);
  if (identity.headerIndex === -1) {
    plan.errors.push(`Target sheet has no ${identityColumn} column`);
    return plan;
  }

  for (const snapshot of snapshots) {
    const residentId = cleanIdentity(snapshot.residentId);
    const rows = identity.rowsById.get(residentId) ?? [];
    if (rows.length === 0) {
      plan.skipped.push({ snapshotId: snapshot.snapshotId, residentId, reason: 'Resident row is no longer present' });
      continue;
    }
    if (rows.length > 1) {
      plan.conflicts.push({
        snapshotId: snapshot.snapshotId,
        residentId,
        reason: `Duplicate ${identityColumn}; cell is ambiguous`,
      });
      continue;
    }

    const colIndex = headers.indexOf(snapshot.column);
    if (colIndex === -1) {
      plan.skipped.push({
        snapshotId: snapshot.snapshotId,
        residentId,
        reason: `Column "${snapshot.column}" is no longer present`,
      });
      continue;
    }

    const rowIndex = rows[0];
    const current = targetData[rowIndex]?.[colIndex];
    if (cellValuesEqual(current, snapshot.before)) {
      // Either the write never landed, or an earlier undo already restored it.
      plan.skipped.push({
        snapshotId: snapshot.snapshotId,
        residentId,
        reason: 'Cell already matches its pre-run value',
      });
      continue;
    }
    if (!cellValuesEqual(current, snapshot.after)) {
      plan.conflicts.push({
        snapshotId: snapshot.snapshotId,
        residentId,
        reason: 'The cell changed after this run, so SheetSmart left it in place',
      });
      continue;
    }

    plan.restores.push({
      snapshotId: snapshot.snapshotId,
      residentId,
      column: snapshot.column,
      row: rowIndex + 1,
      col: colIndex + 1,
      rangeA1: snapshot.rangeA1,
      before: snapshot.before,
      after: snapshot.after,
    });
  }
  return plan;
}

/** Remap one row onto a destination header order by exact header name. */
export function remapRowByHeaders(
  sourceHeaders: string[],
  sourceRow: CellValue[],
  destHeaders: string[]
): CellValue[] {
  return destHeaders.map((header) => {
    if (!header) return '';
    const index = sourceHeaders.indexOf(header);
    return index === -1 ? '' : (sourceRow[index] ?? '');
  });
}

/**
 * Plan identity-based row deletes. A resident is deleted only when their
 * resident_id is present exactly once. Structural deletes are sorted bottom-up.
 */
export function planGuardedDeletes(
  targetData: Grid,
  residentIds: string[],
  identityColumn = 'resident_id'
): GuardedDeletePlan {
  const plan: GuardedDeletePlan = { deletions: [], skipped: [], errors: [] };
  const headers = trimHeaders(targetData[0]);
  const identity = buildIdentityIndex(targetData, headers, identityColumn);
  if (identity.headerIndex === -1) {
    plan.errors.push(`Target sheet has no ${identityColumn} column`);
    return plan;
  }

  const seen = new Set<string>();
  for (const rawId of residentIds) {
    const residentId = cleanIdentity(rawId);
    if (!residentId) {
      plan.skipped.push({ residentId: '', reason: `Blank ${identityColumn}` });
      continue;
    }
    if (seen.has(residentId)) {
      plan.skipped.push({ residentId, reason: 'Duplicate delete proposal for the same resident' });
      continue;
    }
    seen.add(residentId);

    const rows = identity.rowsById.get(residentId) ?? [];
    if (rows.length === 0) {
      plan.skipped.push({ residentId, reason: `${identityColumn} not found in current target` });
      continue;
    }
    if (rows.length > 1) {
      plan.skipped.push({ residentId, reason: `Duplicate ${identityColumn} in current target; row is ambiguous` });
      continue;
    }

    const rowIndex = rows[0];
    const current = targetData[rowIndex] ?? [];
    plan.deletions.push({
      residentId,
      rowIndex,
      row: headers.map((_header, colIndex) => current[colIndex] ?? ''),
    });
  }

  plan.deletions.sort((a, b) => b.rowIndex - a.rowIndex);
  return plan;
}

/**
 * Plan a copies-only resident move: append the source row onto the destination
 * (header-joined) and prepare an identity-based delete from the source.
 * `destinationFields` overwrites zone/captain columns on the appended row
 * (typically ZoneName + NC Name/Phone/Email from Mapbox for the new zone).
 */
export function planGuardedMoves(
  fromData: Grid,
  toData: Grid,
  residentIds: string[],
  destinationFields: Record<string, string>,
  identityColumn = 'resident_id'
): GuardedMovePlan {
  const plan: GuardedMovePlan = { moves: [], skipped: [], errors: [] };
  const fromHeaders = trimHeaders(fromData[0]);
  const toHeaders = trimHeaders(toData[0]);
  const fromIdentity = buildIdentityIndex(fromData, fromHeaders, identityColumn);
  const toIdentity = buildIdentityIndex(toData, toHeaders, identityColumn);
  if (fromIdentity.headerIndex === -1) {
    plan.errors.push(`Source sheet has no ${identityColumn} column`);
    return plan;
  }
  if (toIdentity.headerIndex === -1) {
    plan.errors.push(`Destination sheet has no ${identityColumn} column`);
    return plan;
  }
  const toZone = String(destinationFields.ZoneName || '').trim();
  if (!toZone) {
    plan.errors.push('Destination ZoneName is required for a move');
    return plan;
  }

  const seen = new Set(toIdentity.rowsById.keys());
  const proposed = new Set<string>();

  for (const rawId of residentIds) {
    const residentId = cleanIdentity(rawId);
    if (!residentId) {
      plan.skipped.push({ residentId: '', reason: `Blank ${identityColumn}` });
      continue;
    }
    if (proposed.has(residentId)) {
      plan.skipped.push({ residentId, reason: 'Duplicate move proposal for the same resident' });
      continue;
    }
    proposed.add(residentId);

    const fromRows = fromIdentity.rowsById.get(residentId) ?? [];
    if (fromRows.length === 0) {
      plan.skipped.push({ residentId, reason: `${identityColumn} not found on the source sheet` });
      continue;
    }
    if (fromRows.length > 1) {
      plan.skipped.push({ residentId, reason: `Duplicate ${identityColumn} on the source sheet; row is ambiguous` });
      continue;
    }
    if (seen.has(residentId)) {
      plan.skipped.push({ residentId, reason: `${identityColumn} already exists on the destination sheet` });
      continue;
    }

    const sourceRow = fromHeaders.map((_header, colIndex) => fromData[fromRows[0]]?.[colIndex] ?? '');
    const remapped = remapRowByHeaders(fromHeaders, sourceRow, toHeaders);
    for (const [column, value] of Object.entries(destinationFields)) {
      const colIndex = toHeaders.indexOf(column);
      if (colIndex !== -1 && value !== '') remapped[colIndex] = value;
    }

    const guardedRow = toHeaders.map((column, index) => {
      const value = remapped[index];
      const decision = decideAppendCell({ column, source: value });
      return decision.willWrite ? value : '';
    });

    plan.moves.push({
      residentId,
      appendRow: guardedRow,
      sourceRow,
      sourceRowIndex: fromRows[0],
    });
    seen.add(residentId);
  }
  return plan;
}

/**
 * Restore rows removed by a prior move. A row is re-appended only when the
 * resident_id is still absent. If the identity reappeared with different values,
 * that becomes a conflict.
 */
export function planRowRestores(
  targetData: Grid,
  snapshots: AppendSnapshot[],
  identityColumn = 'resident_id'
): RowRestorePlan {
  const plan: RowRestorePlan = { appends: [], conflicts: [], skipped: [], errors: [] };
  const headers = trimHeaders(targetData[0]);
  const identity = buildIdentityIndex(targetData, headers, identityColumn);
  if (identity.headerIndex === -1) {
    plan.errors.push(`Target sheet has no ${identityColumn} column`);
    return plan;
  }

  const seen = new Set(identity.rowsById.keys());
  for (const snapshot of snapshots) {
    const residentId = cleanIdentity(snapshot.residentId);
    if (!residentId) {
      plan.skipped.push({ ...snapshot, residentId, reason: `Blank ${identityColumn}` });
      continue;
    }

    const rows = identity.rowsById.get(residentId) ?? [];
    if (rows.length > 1) {
      plan.conflicts.push({
        ...snapshot,
        residentId,
        reason: `Duplicate ${identityColumn}; restore is ambiguous`,
      });
      continue;
    }
    if (rows.length === 1) {
      const current = targetData[rows[0]] ?? [];
      const changed = headers.some(
        (_header, colIndex) => !cellValuesEqual(current[colIndex], snapshot.row[colIndex])
      );
      if (changed) {
        plan.conflicts.push({
          ...snapshot,
          residentId,
          reason: 'The resident reappeared with different values, so SheetSmart left the row in place',
        });
      } else {
        plan.skipped.push({
          ...snapshot,
          residentId,
          reason: 'Resident row is already present with matching values',
        });
      }
      continue;
    }
    if (seen.has(residentId)) {
      plan.skipped.push({ ...snapshot, residentId, reason: 'Duplicate restore proposal for the same resident' });
      continue;
    }

    const guardedRow = headers.map((column, index) => {
      const value = snapshot.row[index];
      const decision = decideAppendCell({ column, source: value });
      return decision.willWrite ? value : '';
    });
    plan.appends.push({ residentId, row: guardedRow, snapshotId: snapshot.snapshotId });
    seen.add(residentId);
  }
  return plan;
}

/**
 * Find rows created by a prior append run and decide which are still safe to
 * remove. A row is deleted only when its resident_id is unique and every cell
 * still matches the post-append snapshot. Captain edits are surfaced as
 * conflicts rather than silently discarded.
 */
export function planAppendRevert(
  targetData: Grid,
  snapshots: AppendSnapshot[],
  identityColumn = 'resident_id'
): AppendRevertPlan {
  const plan: AppendRevertPlan = { deletions: [], conflicts: [], skipped: [], errors: [] };
  const headers = trimHeaders(targetData[0]);
  const identity = buildIdentityIndex(targetData, headers, identityColumn);
  if (identity.headerIndex === -1) {
    plan.errors.push(`Target sheet has no ${identityColumn} column`);
    return plan;
  }

  for (const snapshot of snapshots) {
    const residentId = cleanIdentity(snapshot.residentId);
    const rows = identity.rowsById.get(residentId) ?? [];
    if (rows.length === 0) {
      plan.skipped.push({ ...snapshot, residentId, reason: 'Appended row is no longer present' });
      continue;
    }
    if (rows.length > 1) {
      plan.conflicts.push({ ...snapshot, residentId, reason: `Duplicate ${identityColumn}; row is ambiguous` });
      continue;
    }

    const rowIndex = rows[0];
    const current = targetData[rowIndex] ?? [];
    const changed = headers.some((_header, colIndex) => !cellValuesEqual(current[colIndex], snapshot.row[colIndex]));
    if (changed) {
      plan.conflicts.push({
        ...snapshot,
        residentId,
        reason: 'The row changed after this run, so SheetSmart left it in place',
      });
      continue;
    }

    plan.deletions.push({
      snapshotId: snapshot.snapshotId,
      residentId,
      rowIndex,
      row: headers.map((_header, colIndex) => current[colIndex] ?? ''),
    });
  }

  // Structural deletes must run bottom-up so earlier row indices do not shift.
  plan.deletions.sort((a, b) => b.rowIndex - a.rowIndex);
  return plan;
}

function buildIdentityIndex(targetData: Grid, headers: string[], identityColumn: string): IdentityIndex {
  const headerIndex = headers.indexOf(identityColumn);
  const rowsById = new Map<string, number[]>();
  if (headerIndex === -1) return { headerIndex, rowsById };

  for (let rowIndex = 1; rowIndex < targetData.length; rowIndex++) {
    const residentId = cleanIdentity(targetData[rowIndex]?.[headerIndex]);
    if (!residentId) continue;
    const rows = rowsById.get(residentId) ?? [];
    rows.push(rowIndex);
    rowsById.set(residentId, rows);
  }
  return { headerIndex, rowsById };
}

function cleanIdentity(value: CellValue): string {
  const text = String(value == null ? '' : value).trim();
  return text === 'undefined' || text === 'null' ? '' : text;
}

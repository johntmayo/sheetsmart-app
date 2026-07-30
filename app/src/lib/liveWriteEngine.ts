// Pure Phase-C execution planning. Live routes must re-read the target and run
// proposals through this module immediately before calling Google. This avoids
// trusting stale row numbers from a preview and keeps every value behind the
// write guard.

import type { CellValue } from './values';
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

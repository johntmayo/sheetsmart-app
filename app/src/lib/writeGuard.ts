// THE WRITE-GUARD (handoff Section 5). Every proposed cell write in the app
// passes through decideWrite() so no workflow can bypass the safety model.
// This is the highest-risk code in SheetSmart; it is unit-tested in
// test/writeGuard.test.ts. Change it only with tests.
//
// Safety rules enforced here:
//  - Fill blanks only by default (fill_blank).
//  - Never write a blank source over a target value (rule 3).
//  - Log conflicts instead of overwriting disagreements (rule 4).
//  - resident_id (and any protected column) is never changed on an existing row
//    (rule 5). A newly appended row must carry its identity from creation.
//  - Only `overwrite`-policy columns may replace a non-blank value (rule 7).
//  - Unlisted columns default to conflict-only (handled by the caller/default).

import { isTargetCellBlank, isSourceCellBlank, cellValuesEqual, CellValue } from './values';

// The canonical policy vocabulary (handoff Section 5, rule 7).
export type Policy = 'fill_blank' | 'overwrite' | 'conflict' | 'never';

// What the guard decided to do with a single proposed write.
export type WriteAction = 'fill' | 'overwrite' | 'conflict' | 'skip' | 'equal';

export interface WriteDecision {
  action: WriteAction;
  effectivePolicy: Policy;
  reason: string;
  willWrite: boolean;
}

export interface DecideWriteArgs {
  /** Target column header. */
  column?: string;
  /** Current value in the target cell. */
  target?: CellValue;
  /** Incoming value from the source. */
  source?: CellValue;
  /**
   * Requested policy. Defaults to 'conflict' when missing/unknown so unlisted
   * columns never overwrite.
   */
  policy?: string | null;
  /** Columns forced to 'never'. Defaults to DEFAULT_PROTECTED_COLUMNS. */
  protectedColumns?: string[];
}

export interface DecideAppendCellArgs {
  column?: string;
  source?: CellValue;
}

export const VALID_POLICIES: Policy[] = ['fill_blank', 'overwrite', 'conflict', 'never'];
export const DEFAULT_PROTECTED_COLUMNS: string[] = ['resident_id'];

// Normalize a variety of user-entered policy labels to the canonical set.
// Returns '' when the input does not map to a known policy.
export function normalizePolicy(raw: unknown): Policy | '' {
  const policy = String(raw == null ? '' : raw)
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['fill', 'fill_blank', 'fill_blanks', 'fill_blank_only'].includes(policy)) return 'fill_blank';
  if (['overwrite', 'replace'].includes(policy)) return 'overwrite';
  if (['conflict', 'log_conflict', 'log_only'].includes(policy)) return 'conflict';
  if (['never', 'skip', 'ignore'].includes(policy)) return 'never';
  return '';
}

/**
 * Decide what should happen for a single proposed write.
 *
 * action ∈ 'fill' | 'overwrite' | 'conflict' | 'skip' | 'equal'
 */
export function decideWrite({ column, target, source, policy, protectedColumns }: DecideWriteArgs = {}): WriteDecision {
  const protectedList = protectedColumns || DEFAULT_PROTECTED_COLUMNS;

  let effectivePolicy: Policy = normalizePolicy(policy) || 'conflict';
  if (column !== undefined && protectedList.includes(column)) {
    effectivePolicy = 'never';
  }

  // Rule 3: a blank source must never erase a target value.
  if (isSourceCellBlank(source)) {
    return decision('skip', effectivePolicy, 'Source value is blank', false);
  }

  // Rule 5: protected/never columns are never written.
  if (effectivePolicy === 'never') {
    return decision('skip', effectivePolicy, 'Policy is never', false);
  }

  // No-op when values already mean the same thing.
  if (cellValuesEqual(target, source)) {
    return decision('equal', effectivePolicy, 'Target already equals source', false);
  }

  const targetBlank = isTargetCellBlank(target);

  if (targetBlank) {
    // fill_blank and overwrite both fill an empty target; conflict never writes.
    if (effectivePolicy === 'conflict') {
      return decision('conflict', effectivePolicy, 'Conflict policy logs without writing', false);
    }
    return decision('fill', effectivePolicy, 'Target is blank', true);
  }

  // Target is non-blank and differs from source.
  if (effectivePolicy === 'overwrite') {
    return decision('overwrite', effectivePolicy, 'Overwrite policy replaces non-blank value', true);
  }
  // fill_blank or conflict on a non-blank differing target -> log a conflict.
  return decision('conflict', effectivePolicy, 'Values differ and policy does not allow overwrite', false);
}

/**
 * Guard a value used to create a brand-new row.
 *
 * Identity values are permitted here because an appended row without its
 * resident_id could not be safely matched, deduplicated, or undone. This does
 * not permit changing resident_id on an existing row; decideWrite() continues
 * to reject that in every policy.
 */
export function decideAppendCell({ column, source }: DecideAppendCellArgs = {}): WriteDecision {
  return decideWrite({
    column,
    target: undefined,
    source,
    policy: 'fill_blank',
    protectedColumns: [],
  });
}

function decision(action: WriteAction, effectivePolicy: Policy, reason: string, willWrite: boolean): WriteDecision {
  return { action, effectivePolicy, reason, willWrite };
}

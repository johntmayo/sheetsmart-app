// Preview (dry-run) support — turns the tested pure planners (mergeEngine) into
// guided, Field-Dictionary-driven previews with plain-language impact summaries
// (SHEETSMART_VISION_AND_ROADMAP.md §5.2/§5.4, Phase B). Everything here is pure
// (no I/O); the route feeds it grids it read read-only. Nothing writes to sheets.
//
// Why dictionary-driven: instead of trusting a silent fuzzy guess or forcing the
// Operator to hand-map every column, we resolve each logical field to a sheet's
// real header through its aliases (columns.findColumn), so captain "drift" is
// handled and every match is explainable.

import { findColumn } from './columns';
import type { CellFillResult, ColumnMap, PushMissingResult } from './mergeEngine';

// The subset of a dictionary field the preview needs. Mirrors dictionary_fields.
export interface DictField {
  canonical_name: string;
  is_identity: number; // 0 | 1
  is_sensitive: number; // 0 | 1
  default_policy: string; // fill_blank | overwrite | conflict | never
  aliases: string[];
}

export interface CellFillConfig {
  matchSourceHeader: string | null;
  matchTargetHeader: string | null;
  columnMap: ColumnMap[];
  policies: Record<string, string>;
  protectedColumns: string[];
  unmatchedFields: string[]; // logical fields that resolved on neither/one side
}

// Resolve a logical field to a real header on a sheet, trying the canonical name
// first and then every known alias (normalized match).
export function resolveFieldHeader(field: DictField, headers: string[]): string | null {
  return findColumn(headers, [field.canonical_name, ...(field.aliases || [])]);
}

// Build a cell-fill plan configuration purely from the Field Dictionary. The
// match field (e.g. resident_id, APN) is resolved separately on each side so a
// renamed key on one sheet still lines up (mergeEngine keys source + target
// independently).
export function buildCellFillConfig(
  sourceHeaders: string[],
  targetHeaders: string[],
  matchFieldCanonical: string,
  dictFields: DictField[]
): CellFillConfig {
  const matchField = dictFields.find((f) => f.canonical_name === matchFieldCanonical);
  const matchSourceHeader = matchField ? resolveFieldHeader(matchField, sourceHeaders) : sourceHeaders.includes(matchFieldCanonical) ? matchFieldCanonical : null;
  const matchTargetHeader = matchField ? resolveFieldHeader(matchField, targetHeaders) : targetHeaders.includes(matchFieldCanonical) ? matchFieldCanonical : null;

  const columnMap: ColumnMap[] = [];
  const policies: Record<string, string> = {};
  const protectedColumns: string[] = [];
  const unmatchedFields: string[] = [];

  for (const field of dictFields) {
    if (field.canonical_name === matchFieldCanonical) continue;
    const sourceHeader = resolveFieldHeader(field, sourceHeaders);
    const targetHeader = resolveFieldHeader(field, targetHeaders);
    if (!sourceHeader || !targetHeader) {
      // Only a field the source actually carries is worth noting as unmatched.
      if (sourceHeader && !targetHeader) unmatchedFields.push(field.canonical_name);
      continue;
    }
    columnMap.push({ source: sourceHeader, target: targetHeader });
    policies[targetHeader] = field.default_policy;
    if (field.is_identity === 1 || field.default_policy === 'never') {
      protectedColumns.push(targetHeader);
    }
  }
  // resident_id is always protected regardless of how it resolved.
  if (matchTargetHeader && !protectedColumns.includes(matchTargetHeader)) {
    // The match key is never a fill target, but keep it protected for safety.
    protectedColumns.push(matchTargetHeader);
  }

  return { matchSourceHeader, matchTargetHeader, columnMap, policies, protectedColumns, unmatchedFields };
}

// ---- Plain-language impact summaries ----

export interface CellFillImpact {
  headline: string;
  detail: string;
  filled: number;
  conflicts: number;
  overwritten: number;
  columnsToAdd: number;
  sheetsAffected: number;
  errors: number;
}

function pl(n: number, singular: string, plural = singular + 's'): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

// Summarize one or many cell-fill plans (a folder run aggregates many).
export function summarizeCellFill(plans: CellFillResult[]): CellFillImpact {
  let filled = 0;
  let conflicts = 0;
  let overwritten = 0;
  let errors = 0;
  let sheetsAffected = 0;
  const columnsToAdd = new Set<string>();

  for (const p of plans) {
    const changed = p.filled.length + p.overwritten.length;
    if (changed > 0) sheetsAffected++;
    filled += p.filled.length;
    conflicts += p.conflicts.length;
    overwritten += p.overwritten.length;
    errors += p.errors.length;
    for (const c of p.columnsToAdd) columnsToAdd.add(c);
  }

  const parts: string[] = [];
  parts.push(`fill ${pl(filled, 'blank cell')}`);
  if (columnsToAdd.size > 0) parts.push(`add ${pl(columnsToAdd.size, 'new column')}`);
  if (overwritten > 0) parts.push(`replace ${pl(overwritten, 'existing value')}`);
  if (conflicts > 0) parts.push(`flag ${pl(conflicts, 'conflict')} for your review`);

  const across = plans.length > 1 ? ` across ${pl(sheetsAffected, 'sheet')}` : '';
  const headline = `This would ${joinAnd(parts)}${across}.`;
  const detail =
    overwritten > 0
      ? 'Existing values are only replaced where a column is explicitly set to “overwrite”. Everything else fills blanks only; disagreements are flagged, never overwritten.'
      : 'Nothing would be overwritten — only blank cells get filled, and any disagreement is flagged for you to review.';

  return {
    headline,
    detail,
    filled,
    conflicts,
    overwritten,
    columnsToAdd: columnsToAdd.size,
    sheetsAffected,
    errors,
  };
}

export interface PushMissingImpact {
  headline: string;
  detail: string;
  appended: number;
  flagged: number;
  sheetsAffected: number;
  errors: number;
}

export function summarizePushMissing(plans: PushMissingResult[]): PushMissingImpact {
  let appended = 0;
  let flagged = 0;
  let errors = 0;
  let sheetsAffected = 0;

  for (const p of plans) {
    if (p.appended.length > 0) sheetsAffected++;
    appended += p.appended.length;
    flagged += p.flagged.length;
    errors += p.errors.length;
  }

  const across = plans.length > 1 ? ` across ${pl(sheetsAffected, 'captain sheet')}` : '';
  const headline = `This would add ${pl(appended, 'new resident')}${across} (matched to each sheet by its detected zone).`;
  const detail =
    flagged > 0
      ? `${pl(flagged, 'of those rows contains', 'of those rows contain')} sensitive contact info, flagged for your confirmation before sharing. No existing rows are changed — this only appends new ones.`
      : 'No existing rows are changed — this only appends new residents that are missing.';

  return { headline, detail, appended, flagged, sheetsAffected, errors };
}

function joinAnd(parts: string[]): string {
  if (parts.length === 0) return 'make no changes';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

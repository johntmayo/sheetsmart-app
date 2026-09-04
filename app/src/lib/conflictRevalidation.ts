import { cellValuesEqual, type CellValue, type FieldCompareMeta } from './values';

export type ConflictFreshness = 'equivalent' | 'stale' | 'current';

export function classifyConflictFreshness(args: {
  originalMaster: CellValue;
  originalCaptain: CellValue;
  currentMaster: CellValue;
  currentCaptain: CellValue;
  fieldMeta?: FieldCompareMeta;
}): ConflictFreshness {
  const { originalMaster, originalCaptain, currentMaster, currentCaptain, fieldMeta } = args;
  if (cellValuesEqual(currentMaster, currentCaptain, fieldMeta)) return 'equivalent';
  if (
    !cellValuesEqual(currentMaster, originalMaster, fieldMeta) ||
    !cellValuesEqual(currentCaptain, originalCaptain, fieldMeta)
  ) return 'stale';
  return 'current';
}

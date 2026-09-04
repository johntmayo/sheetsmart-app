// Value semantics ported from legacy MergeEngine.gs. Comparing spreadsheet
// cells by *meaning* (not raw JS identity) prevents false conflicts when
// Sheets returns equivalent dates/numbers/booleans in different shapes.

// A raw cell value as returned by the Sheets API (or a target/source read).
export type CellValue = string | number | boolean | Date | null | undefined;

export interface FieldCompareMeta {
  dataType: 'text' | 'number' | 'date' | 'checkbox';
  isTextSafe?: boolean;
}

export type FieldMetaMap = Record<string, FieldCompareMeta>;

// False is data, not a blank. Checkbox blank/unchecked equivalence belongs in
// typed comparison, never in the generic write-policy blank test.
export function isTargetCellBlank(value: CellValue): boolean {
  return value === '' || value === null || value === undefined;
}

// Source-side blank: an unchecked checkbox (false) is real data on the source,
// so it does NOT count as blank here.
export function isSourceCellBlank(value: CellValue): boolean {
  return value === '' || value === null || value === undefined;
}

function pad2(value: number | string): string {
  const t = String(value);
  return t.length === 1 ? '0' + t : t;
}

function parseDisplayDate(text: string): string {
  let m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return validCalendarDate(Number(m[3]), Number(m[1]), Number(m[2]));
  m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return validCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
  return '';
}

function validCalendarDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return '';
  return `date:${year}-${pad2(month)}-${pad2(day)}`;
}

function normalizeBoolean(value: CellValue): string {
  if (value === true) return 'boolean:true';
  if (value === false || isSourceCellBlank(value)) return 'boolean:false';
  if (typeof value !== 'string') return '';
  const text = value.trim();
  const lower = String(text || '').trim().toLowerCase();
  if (lower === 'true') return 'boolean:true';
  if (lower === 'false') return 'boolean:false';
  return '';
}

function normalizeNumericText(text: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(String(text || '').trim())) return '';
  return 'number:' + String(Number(text));
}

function normalizeDate(value: CellValue): string {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN((value as Date).getTime())) {
    const d = value as Date;
    return `date:${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  if (typeof value === 'number' && isFinite(value)) {
    const epoch = Date.UTC(1899, 11, 30);
    const date = new Date(epoch + Math.trunc(value) * 86_400_000);
    return `date:${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }
  return typeof value === 'string' ? parseDisplayDate(value.trim()) : '';
}

export function normalizeForCompare(value: CellValue, meta?: FieldCompareMeta): string {
  const typed = meta && !meta.isTextSafe ? meta.dataType : 'text';
  if (typed === 'checkbox') {
    return normalizeBoolean(value) || `invalid-checkbox:${typeof value}:${String(value)}`;
  }
  if (isTargetCellBlank(value)) return 'blank:';
  if (typed === 'date') {
    return normalizeDate(value) || `invalid-date:${typeof value}:${String(value).trim()}`;
  }
  if (typed === 'number') {
    if (typeof value === 'number' && isFinite(value)) return 'number:' + String(value);
    if (typeof value === 'string') {
      return normalizeNumericText(value) || `invalid-number:${value.trim()}`;
    }
    return `invalid-number:${typeof value}:${String(value)}`;
  }

  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? 'blank:' : 'string:' + text;
  }
  if (typeof value === 'boolean') return 'raw-boolean:' + String(value);
  if (typeof value === 'number') return 'raw-number:' + String(value);
  if (value instanceof Date) return 'raw-date:' + value.toISOString();
  return `${typeof value}:${String(value)}`;
}

export function cellValuesEqual(a: CellValue, b: CellValue, meta?: FieldCompareMeta): boolean {
  return normalizeForCompare(a, meta) === normalizeForCompare(b, meta);
}

export function valueForTypedWrite(value: CellValue, meta?: FieldCompareMeta): CellValue {
  if (meta?.dataType !== 'checkbox' || meta.isTextSafe) return value;
  const key = normalizeBoolean(value);
  if (key === 'boolean:true') return true;
  if (key === 'boolean:false') return false;
  return value;
}

export function isSuspectedTextCoercion(value: CellValue, meta?: FieldCompareMeta): boolean {
  return Boolean(meta?.isTextSafe && typeof value === 'number' && isFinite(value));
}

export function displayCellValue(value: CellValue, meta?: FieldCompareMeta): string {
  if (meta?.dataType === 'date' && !meta.isTextSafe) {
    const normalized = normalizeDate(value);
    if (normalized) return normalized.slice('date:'.length);
  }
  if (meta?.dataType === 'checkbox' && !meta.isTextSafe) {
    const normalized = normalizeBoolean(value);
    if (normalized === 'boolean:true') return 'Checked';
    if (normalized === 'boolean:false') return 'Unchecked';
  }
  if (isTargetCellBlank(value)) return '(blank)';
  return String(value);
}

// Value semantics ported from legacy MergeEngine.gs. Comparing spreadsheet
// cells by *meaning* (not raw JS identity) prevents false conflicts when
// Sheets returns equivalent dates/numbers/booleans in different shapes.

// A raw cell value as returned by the Sheets API (or a target/source read).
export type CellValue = string | number | boolean | Date | null | undefined;

// Target-side blank: an unchecked checkbox returns boolean false, which we
// treat as blank so checkbox columns don't produce spurious conflicts.
export function isTargetCellBlank(value: CellValue): boolean {
  return value === '' || value === null || value === undefined || value === false;
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
  if (m) return `date:${m[3]}-${pad2(m[1])}-${pad2(m[2])}`;
  m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `date:${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  return '';
}

function normalizeBooleanText(text: string): string {
  const lower = String(text || '').trim().toLowerCase();
  if (lower === 'true') return 'boolean:true';
  if (lower === 'false') return 'boolean:false';
  return '';
}

function normalizeNumericText(text: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(String(text || '').trim())) return '';
  return 'number:' + String(Number(text));
}

export function normalizeForCompare(value: CellValue): string {
  if (isTargetCellBlank(value)) return 'blank:';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN((value as Date).getTime())) {
    const d = value as Date;
    return `date:${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  if (typeof value === 'boolean') return 'boolean:' + String(value);
  if (typeof value === 'number' && isFinite(value)) return 'number:' + String(value);

  const text = String(value).trim();
  if (text === '') return 'blank:';

  const b = normalizeBooleanText(text);
  if (b !== '') return b;
  const n = normalizeNumericText(text);
  if (n !== '') return n;
  const d = parseDisplayDate(text);
  if (d) return d;
  return 'string:' + text;
}

export function cellValuesEqual(a: CellValue, b: CellValue): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

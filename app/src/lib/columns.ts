// Fuzzy column matching — the heart of "column drift" (handoff 4.3). Captain
// sheets rename headers constantly, so never hardcode a single header string.
// Matching is kept visible/configurable: callers can report which real header
// resolved to which logical field instead of trusting a silent guess.

// A header cell as read from a sheet's first row.
export type Header = string | null | undefined;

// A matcher run against the lowercased header text as a fallback when no alias
// matches (e.g. `(l) => l.includes('contact') && l.includes('date')`).
export type FallbackMatcher = (lowerHeader: string) => boolean;

export interface ColumnResolution {
  matched: boolean;
  header: string | null;
  index: number;
}

export function normalizeKey(s: unknown): string {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Resolve a logical field to a real header. Tries exact-normalized alias match
// first, then an optional fallback matcher against the lowercased header.
// Returns the matched header string, or null if nothing matched.
export function findColumn(
  headers: Header[],
  aliases: string[] | null | undefined,
  fallbackMatcher?: FallbackMatcher
): string | null {
  const aliasKeys = (aliases || []).map(normalizeKey);
  const byAlias = headers.find((h) => aliasKeys.includes(normalizeKey(h)));
  if (byAlias !== undefined) return byAlias ?? null;
  if (typeof fallbackMatcher === 'function') {
    const byFallback = headers.find(
      (h) => h !== '' && h != null && fallbackMatcher(String(h).toLowerCase())
    );
    if (byFallback !== undefined) return byFallback ?? null;
  }
  return null;
}

// Detailed resolution result, useful for the audit's "matched X to Y" report.
export function resolveColumn(
  headers: Header[],
  aliases: string[] | null | undefined,
  fallbackMatcher?: FallbackMatcher
): ColumnResolution {
  const match = findColumn(headers, aliases, fallbackMatcher);
  return {
    matched: match !== null,
    header: match,
    index: match === null ? -1 : headers.indexOf(match),
  };
}

// 0 -> A, 25 -> Z, 26 -> AA (matches legacy columnLetter_).
export function columnLetter(index: number): string {
  let letter = '';
  let temp = index;
  while (true) {
    letter = String.fromCharCode(65 + (temp % 26)) + letter;
    temp = Math.floor(temp / 26) - 1;
    if (temp < 0) break;
  }
  return letter;
}

// Infer a sheet's assigned zone as the mode (most common non-blank value) of
// its ZoneName column. Ported from legacy detectSheetZone_. Returns '' when no
// ZoneName column exists or there are no non-blank values.
export function detectSheetZone(
  headers: Header[],
  dataRows: CellRow[],
  zoneHeader = 'ZoneName'
): string {
  const zoneCol = headers.indexOf(zoneHeader);
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

// A single row of cell values, as returned by the Sheets API.
type CellRow = Array<string | number | boolean | Date | null | undefined>;

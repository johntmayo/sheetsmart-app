// Fuzzy column matching — the heart of "column drift" (handoff 4.3). Captain
// sheets rename headers constantly, so never hardcode a single header string.
// Matching is kept visible/configurable: callers can report which real header
// resolved to which logical field instead of trusting a silent guess.

import { createHash } from 'node:crypto';

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

export interface DictionaryAliasSpec {
  canonicalName: string;
  aliases: string[];
}

export interface CanonicalHeaderResult {
  headers: string[];
  errors: string[];
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

/**
 * Replace recognized aliases with their dictionary standard name while
 * preserving column order. Ambiguous aliases and duplicate logical columns are
 * blocked rather than guessed.
 */
export function canonicalizeHeaders(headers: readonly unknown[], fields: DictionaryAliasSpec[]): CanonicalHeaderResult {
  const errors: string[] = [];
  const canonicalByKey = new Map<string, Set<string>>();
  for (const field of fields) {
    for (const candidate of [field.canonicalName, ...field.aliases]) {
      const key = normalizeKey(candidate);
      if (!key) continue;
      const names = canonicalByKey.get(key) || new Set<string>();
      names.add(field.canonicalName);
      canonicalByKey.set(key, names);
    }
  }

  const resolved = headers.map((raw) => {
    const header = String(raw == null ? '' : raw).trim();
    if (!header) return '';
    const key = normalizeKey(header);
    const exactCanonical = fields.filter((field) => normalizeKey(field.canonicalName) === key);
    if (exactCanonical.length === 1) return exactCanonical[0].canonicalName;
    const matches = canonicalByKey.get(key);
    if (!matches || matches.size === 0) return header;
    if (matches.size > 1) {
      errors.push(`Column "${header}" matches more than one field: ${[...matches].join(', ')}.`);
      return header;
    }
    return [...matches][0];
  });

  const indexesByCanonical = new Map<string, number[]>();
  resolved.forEach((header, index) => {
    if (!fields.some((field) => field.canonicalName === header)) return;
    indexesByCanonical.set(header, [...(indexesByCanonical.get(header) || []), index]);
  });
  for (const [canonical, indexes] of indexesByCanonical) {
    if (indexes.length > 1) {
      errors.push(`More than one column resolves to "${canonical}" (columns ${indexes.map((index) => index + 1).join(', ')}).`);
    }
  }
  return { headers: resolved, errors };
}

export function fingerprintDictionaryAliases(fields: DictionaryAliasSpec[]): string {
  const lines = fields
    .map(
      (field) =>
        `${field.canonicalName}\t${[...field.aliases].map((alias) => normalizeKey(alias)).sort().join('|')}`
    )
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
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
  if (topCount > 0 && Object.values(counts).filter((count) => count === topCount).length > 1) return '';
  return topZone;
}

/**
 * Folder registry fallback for newly created sheets whose data rows are still
 * blank or whose legacy export contains duplicate ZoneName headers.
 */
export function detectSheetZoneWithName(
  headers: Header[],
  dataRows: CellRow[],
  spreadsheetName: string,
  zoneHeader = 'ZoneName',
  knownZoneNames: readonly string[] = []
): string {
  const name = String(spreadsheetName || '').trim();
  const knownNameMatches = [...new Set(knownZoneNames.map((zone) => zone.trim()).filter(Boolean))].filter(
    (zone) => name === zone || name.startsWith(`${zone} - `)
  );
  const match = name.match(/(?:^|[^a-z0-9])zone\s*(\d+)\b/i);
  const fromName =
    knownNameMatches.length === 1
      ? knownNameMatches[0]
      : match
        ? `Zone ${Number(match[1])}`
        : '';
  const matchingHeaders = headers.filter(
    (header) => String(header == null ? '' : header).trim().toLowerCase() === zoneHeader.toLowerCase()
  );
  if (matchingHeaders.length > 1) {
    const indexes = headers.flatMap((header, index) =>
      String(header == null ? '' : header).trim().toLowerCase() === zoneHeader.toLowerCase() ? [index] : []
    );
    const populatedZones = new Set(
      dataRows
        .flatMap((row) => indexes.map((index) => String(row[index] == null ? '' : row[index]).trim()))
        .filter(Boolean)
    );
    if (populatedZones.size > 1) return '';
    if (populatedZones.size === 1) {
      const populated = [...populatedZones][0];
      return fromName && populated !== fromName ? '' : populated;
    }
    return fromName;
  }
  const fromRows = detectSheetZone(headers, dataRows, zoneHeader);
  if (fromRows) return fromName && fromRows !== fromName ? '' : fromRows;
  return fromName;
}

// A single row of cell values, as returned by the Sheets API.
type CellRow = Array<string | number | boolean | Date | null | undefined>;

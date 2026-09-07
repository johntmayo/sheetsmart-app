import { createHash } from 'node:crypto';

export type AddressRow = Record<string, unknown>;
export type AddressField =
  | 'addressId'
  | 'apn'
  | 'house'
  | 'direction'
  | 'street'
  | 'unit'
  | 'city'
  | 'state'
  | 'zip'
  | 'latitude'
  | 'longitude';
export type AddressHeaders = Record<AddressField, string>;
export type ExactMatchTier = 'address_id' | 'apn' | 'normalized_situs';
export type IntakeRiskGroup =
  | 'exact_identity'
  | 'exact_parcel'
  | 'exact_situs'
  | 'near_coordinate'
  | 'fuzzy_situs'
  | 'new_address'
  | 'blocked';

export interface AddressIntakeOptions {
  externalHeaders?: Partial<AddressHeaders>;
  masterHeaders?: Partial<AddressHeaders>;
  captainHeaders?: Partial<AddressHeaders>;
  /** Address components required on every non-empty external row. */
  requiredFields?: AddressField[];
  /** Maximum placeholder rows in each append-friendly batch. */
  maxBatchSize?: number;
  /** Review threshold only; coordinates never cause an automatic match. */
  nearCoordinateMeters?: number;
  /** Review threshold only, from 0 to 1. */
  fuzzyThreshold?: number;
  /** Prefix used for deterministic IDs assigned to new placeholder rows. */
  placeholderIdPrefix?: string;
}

export interface AddressProvenance {
  dataset: 'master' | 'captain' | 'external';
  row: number;
}

export interface CanonicalAddress {
  addressId: string;
  apn: string;
  house: string;
  direction: string;
  street: string;
  unit: string;
  city: string;
  state: string;
  zip: string;
  latitude?: number;
  longitude?: number;
  normalizedSitus: string;
  provenance: AddressProvenance[];
}

export interface AddressMatch {
  externalRow: number;
  inputAddressId: string;
  addressId: string;
  tier: ExactMatchTier;
  riskGroup: IntakeRiskGroup;
  canonical: CanonicalAddress;
}

export interface ReviewCandidate {
  addressId: string;
  reasons: Array<'near_coordinate' | 'fuzzy_situs'>;
  distanceMeters?: number;
  similarity?: number;
  canonical: CanonicalAddress;
}

export interface AddressReview {
  externalRow: number;
  inputAddressId: string;
  input: CanonicalAddress;
  riskGroups: IntakeRiskGroup[];
  reason: string;
  candidates: ReviewCandidate[];
}

export type AddressBlockCode =
  | 'duplicate_incoming_id'
  | 'missing_required_fields'
  | 'conflicting_identity'
  | 'ambiguous_match';

export interface AddressBlock {
  externalRow: number;
  inputAddressId: string;
  code: AddressBlockCode;
  riskGroup: 'blocked';
  reason: string;
  conflictingAddressIds: string[];
}

export interface AddressPlaceholder {
  address_id: string;
  record_type: 'address_placeholder';
  apn: string;
  house: string;
  direction: string;
  street: string;
  unit: string;
  city: string;
  state: string;
  zip: string;
  latitude: number | '';
  longitude: number | '';
  provenance_dataset: 'external';
  provenance_row: number;
  provenance_input_address_id: string;
  risk_group: 'new_address';
  fingerprint: string;
}

export interface AddressIntakePlan {
  matches: AddressMatch[];
  review: AddressReview[];
  blocked: AddressBlock[];
  placeholders: AddressPlaceholder[];
  /** Same placeholders split into deterministic, bounded append batches. */
  batches: AddressPlaceholder[][];
  fingerprint: string;
  errors: string[];
}

const DEFAULT_HEADERS: AddressHeaders = {
  addressId: 'address_id',
  apn: 'APN',
  house: 'House',
  direction: 'Direction',
  street: 'Street',
  unit: 'Unit',
  city: 'City',
  state: 'State',
  zip: 'ZIP',
  latitude: 'Latitude',
  longitude: 'Longitude',
};

const SUFFIXES: Record<string, string> = {
  STREET: 'ST',
  ST: 'ST',
  AVENUE: 'AVE',
  AVE: 'AVE',
  ROAD: 'RD',
  RD: 'RD',
  DRIVE: 'DR',
  DR: 'DR',
  LANE: 'LN',
  LN: 'LN',
  COURT: 'CT',
  CT: 'CT',
  BOULEVARD: 'BLVD',
  BLVD: 'BLVD',
  HIGHWAY: 'HWY',
  HWY: 'HWY',
  PARKWAY: 'PKWY',
  PKWY: 'PKWY',
  PLACE: 'PL',
  PL: 'PL',
  TERRACE: 'TER',
  TER: 'TER',
  CIRCLE: 'CIR',
  CIR: 'CIR',
  TRAIL: 'TRL',
  TRL: 'TRL',
};

const DIRECTIONS: Record<string, string> = {
  NORTH: 'N',
  N: 'N',
  SOUTH: 'S',
  S: 'S',
  EAST: 'E',
  E: 'E',
  WEST: 'W',
  W: 'W',
  NORTHEAST: 'NE',
  NE: 'NE',
  NORTHWEST: 'NW',
  NW: 'NW',
  SOUTHEAST: 'SE',
  SE: 'SE',
  SOUTHWEST: 'SW',
  SW: 'SW',
};

const NORMALIZED_SUFFIXES = new Set(Object.values(SUFFIXES));

interface ParsedAddress {
  addressId: string;
  apn: string;
  house: string;
  direction: string;
  street: string;
  unit: string;
  city: string;
  state: string;
  zip: string;
  latitude?: number;
  longitude?: number;
  normalizedSitus: string;
}

interface ExistingEntry extends ParsedAddress {
  provenance: AddressProvenance;
}

function headers(overrides?: Partial<AddressHeaders>): AddressHeaders {
  return { ...DEFAULT_HEADERS, ...(overrides || {}) };
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function keyText(value: unknown): string {
  return text(value).toUpperCase().replace(/\s+/g, ' ');
}

function words(value: unknown): string {
  return keyText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeDirection(value: unknown): string {
  const valueWords = words(value);
  return DIRECTIONS[valueWords] || valueWords;
}

function normalizeStreet(value: unknown): string {
  const parts = words(value).split(' ').filter(Boolean);
  if (parts.length > 0) parts[parts.length - 1] = SUFFIXES[parts[parts.length - 1]] || parts[parts.length - 1];
  return parts.join(' ');
}

function normalizeUnit(value: unknown): string {
  return words(value).replace(/^(APT|APARTMENT|UNIT|SUITE|STE|NUMBER|NO) /, '');
}

function normalizeZip(value: unknown): string {
  const raw = text(value);
  const match = raw.match(/\d{5}/);
  return match ? match[0] : words(raw);
}

function coordinate(value: unknown, min: number, max: number): number | undefined {
  if (value === '' || value === null || value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(text(value));
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function parse(row: AddressRow, map: AddressHeaders): ParsedAddress {
  const result: ParsedAddress = {
    addressId: keyText(row[map.addressId]),
    apn: keyText(row[map.apn]),
    house: words(row[map.house]),
    direction: normalizeDirection(row[map.direction]),
    street: normalizeStreet(row[map.street]),
    unit: normalizeUnit(row[map.unit]),
    city: words(row[map.city]),
    state: words(row[map.state]),
    zip: normalizeZip(row[map.zip]),
    latitude: coordinate(row[map.latitude], -90, 90),
    longitude: coordinate(row[map.longitude], -180, 180),
    normalizedSitus: '',
  };
  // A partial address must not become an "exact" situs identity. It can still
  // participate in fuzzy review when callers relax requiredFields.
  if (result.house && result.street && result.city && result.state && result.zip) {
    result.normalizedSitus = normalizeSitus(result);
  }
  return result;
}

/** Normalize the complete situs identity in a stable component order. */
export function normalizeSitus(
  address: Pick<ParsedAddress, 'house' | 'direction' | 'street' | 'unit' | 'city' | 'state' | 'zip'>
): string {
  return [
    words(address.house),
    normalizeDirection(address.direction),
    normalizeStreet(address.street),
    normalizeUnit(address.unit),
    words(address.city),
    words(address.state),
    normalizeZip(address.zip),
  ].join('|');
}

function isEmpty(row: AddressRow): boolean {
  return Object.values(row).every((value) => text(value) === '');
}

function addToIndex(index: Map<string, Set<string>>, key: string, addressId: string): void {
  if (!key || !addressId) return;
  const values = index.get(key) || new Set<string>();
  values.add(addressId);
  index.set(key, values);
}

function canonicalize(entries: ExistingEntry[]): Map<string, CanonicalAddress> {
  const grouped = new Map<string, ExistingEntry[]>();
  for (const entry of entries) {
    if (!entry.addressId) continue;
    const values = grouped.get(entry.addressId) || [];
    values.push(entry);
    grouped.set(entry.addressId, values);
  }

  const canonical = new Map<string, CanonicalAddress>();
  for (const [addressId, values] of grouped) {
    const firstNonBlank = (field: keyof ParsedAddress): string =>
      values.map((value) => String(value[field] || '')).find(Boolean) || '';
    const firstNumber = (field: 'latitude' | 'longitude'): number | undefined =>
      values.map((value) => value[field]).find((value): value is number => value !== undefined);
    const value: CanonicalAddress = {
      addressId,
      apn: firstNonBlank('apn'),
      house: firstNonBlank('house'),
      direction: firstNonBlank('direction'),
      street: firstNonBlank('street'),
      unit: firstNonBlank('unit'),
      city: firstNonBlank('city'),
      state: firstNonBlank('state'),
      zip: firstNonBlank('zip'),
      latitude: firstNumber('latitude'),
      longitude: firstNumber('longitude'),
      normalizedSitus: '',
      provenance: values.map((entry) => entry.provenance),
    };
    if (value.house && value.street && value.city && value.state && value.zip) {
      value.normalizedSitus = normalizeSitus(value);
    }
    canonical.set(addressId, value);
  }
  return canonical;
}

function conflictingExistingEvidence(entries: ExistingEntry[]): Map<string, string[]> {
  const evidence = new Map<string, { apns: Set<string>; situses: Set<string> }>();
  for (const entry of entries) {
    if (!entry.addressId) continue;
    const item = evidence.get(entry.addressId) || { apns: new Set<string>(), situses: new Set<string>() };
    if (entry.apn) item.apns.add(entry.apn);
    if (entry.normalizedSitus) item.situses.add(entry.normalizedSitus);
    evidence.set(entry.addressId, item);
  }
  const conflicts = new Map<string, string[]>();
  for (const [addressId, item] of evidence) {
    const fields: string[] = [];
    if (item.apns.size > 1) fields.push('APN');
    if (item.situses.size > 1) fields.push('normalized situs');
    if (fields.length > 0) conflicts.set(addressId, fields);
  }
  return conflicts;
}

function ids(index: Map<string, Set<string>>, key: string): string[] {
  return [...(index.get(key) || [])].sort();
}

function intersection(nonEmptySets: string[][]): string[] {
  if (nonEmptySets.length === 0) return [];
  return nonEmptySets[0].filter((id) => nonEmptySets.every((set) => set.includes(id))).sort();
}

function union(sets: string[][]): string[] {
  return [...new Set(sets.flat())].sort();
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function distanceMeters(a: ParsedAddress, b: CanonicalAddress): number | undefined {
  if (
    a.latitude === undefined ||
    a.longitude === undefined ||
    b.latitude === undefined ||
    b.longitude === undefined
  ) return undefined;
  const radians = (degrees: number): number => degrees * Math.PI / 180;
  const lat = radians(b.latitude - a.latitude);
  const lon = radians(b.longitude - a.longitude);
  const x =
    Math.sin(lat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(lon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function evidenceConflict(evidence: Array<{ name: string; matches: string[] }>): string[] {
  const nonEmpty = evidence.filter((item) => item.matches.length > 0);
  if (nonEmpty.length < 2) return [];
  const common = intersection(nonEmpty.map((item) => item.matches));
  return common.length === 0 ? union(nonEmpty.map((item) => item.matches)) : [];
}

function riskForTier(tier: ExactMatchTier): IntakeRiskGroup {
  if (tier === 'address_id') return 'exact_identity';
  if (tier === 'apn') return 'exact_parcel';
  return 'exact_situs';
}

function placeholderFor(
  input: ParsedAddress,
  externalRow: number,
  prefix: string
): AddressPlaceholder {
  const identity = {
    apn: input.apn,
    situs: input.normalizedSitus,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    inputAddressId: input.addressId,
  };
  const fingerprint = hash(identity);
  return {
    address_id: `${prefix}${fingerprint.slice(0, 20).toUpperCase()}`,
    record_type: 'address_placeholder',
    apn: input.apn,
    house: input.house,
    direction: input.direction,
    street: input.street,
    unit: input.unit,
    city: input.city,
    state: input.state,
    zip: input.zip,
    latitude: input.latitude ?? '',
    longitude: input.longitude ?? '',
    provenance_dataset: 'external',
    provenance_row: externalRow,
    provenance_input_address_id: input.addressId,
    risk_group: 'new_address',
    fingerprint,
  };
}

/**
 * Purely plans intake of externally supplied addresses. Exact identity tiers
 * may adopt an existing canonical ID; fuzzy/geospatial evidence is review-only.
 * This function performs no network, database, spreadsheet, or filesystem I/O.
 */
export function planAddressIntake(
  externalRows: AddressRow[],
  masterAddresses: AddressRow[],
  captainAddresses: AddressRow[] = [],
  options: AddressIntakeOptions = {}
): AddressIntakePlan {
  const plan: AddressIntakePlan = {
    matches: [],
    review: [],
    blocked: [],
    placeholders: [],
    batches: [],
    fingerprint: '',
    errors: [],
  };
  const required = options.requiredFields || ['house', 'street', 'city', 'state', 'zip'];
  const maxBatchSize = options.maxBatchSize ?? 100;
  // Ordinary neighboring houses are often within 75 metres of one another.
  // Proximity is useful only when two records are close enough to plausibly
  // describe the same building or parcel.
  const nearMeters = options.nearCoordinateMeters ?? 5;
  const fuzzyThreshold = options.fuzzyThreshold ?? 0.72;
  const prefix = options.placeholderIdPrefix ?? 'ADDRESS-PLACEHOLDER-';
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1) {
    plan.errors.push('maxBatchSize must be a positive integer.');
    plan.fingerprint = hash(plan);
    return plan;
  }
  if (nearMeters < 0 || fuzzyThreshold < 0 || fuzzyThreshold > 1) {
    plan.errors.push('Review thresholds must be non-negative, and fuzzyThreshold must be at most 1.');
    plan.fingerprint = hash(plan);
    return plan;
  }

  const masterMap = headers(options.masterHeaders);
  const captainMap = headers(options.captainHeaders);
  const externalMap = headers(options.externalHeaders);
  const existing: ExistingEntry[] = [
    ...masterAddresses.map((row, index) => ({
      ...parse(row, masterMap),
      provenance: { dataset: 'master' as const, row: index + 1 },
    })),
    ...captainAddresses.map((row, index) => ({
      ...parse(row, captainMap),
      provenance: { dataset: 'captain' as const, row: index + 1 },
    })),
  ];
  const canonical = canonicalize(existing);
  const existingConflicts = conflictingExistingEvidence(existing);
  const byId = new Map<string, Set<string>>();
  const byApn = new Map<string, Set<string>>();
  const bySitus = new Map<string, Set<string>>();
  for (const value of canonical.values()) {
    addToIndex(byId, value.addressId, value.addressId);
    addToIndex(byApn, value.apn, value.addressId);
    addToIndex(bySitus, value.normalizedSitus, value.addressId);
  }

  const parsedExternal = externalRows.map((row) => parse(row, externalMap));
  const incomingIdCounts = new Map<string, number>();
  const incomingApnCounts = new Map<string, number>();
  const incomingSitusCounts = new Map<string, number>();
  for (const input of parsedExternal) {
    if (input.addressId) incomingIdCounts.set(input.addressId, (incomingIdCounts.get(input.addressId) || 0) + 1);
    if (input.apn) incomingApnCounts.set(input.apn, (incomingApnCounts.get(input.apn) || 0) + 1);
    if (input.normalizedSitus) {
      incomingSitusCounts.set(
        input.normalizedSitus,
        (incomingSitusCounts.get(input.normalizedSitus) || 0) + 1
      );
    }
  }

  externalRows.forEach((raw, index) => {
    if (isEmpty(raw)) return;
    const externalRow = index + 2;
    const input = parsedExternal[index];
    const block = (
      code: AddressBlockCode,
      reason: string,
      conflictingAddressIds: string[] = []
    ): void => {
      plan.blocked.push({
        externalRow,
        inputAddressId: input.addressId,
        code,
        riskGroup: 'blocked',
        reason,
        conflictingAddressIds,
      });
    };

    if (input.addressId && (incomingIdCounts.get(input.addressId) || 0) > 1) {
      block('duplicate_incoming_id', `Incoming address_id ${input.addressId} appears more than once.`);
      return;
    }
    if (input.apn && (incomingApnCounts.get(input.apn) || 0) > 1) {
      block('ambiguous_match', `Incoming APN ${input.apn} appears more than once.`);
      return;
    }
    if (input.normalizedSitus && (incomingSitusCounts.get(input.normalizedSitus) || 0) > 1) {
      block('ambiguous_match', 'This normalized street address appears more than once in the incoming file.');
      return;
    }
    const missing = required.filter((field) => {
      if (field === 'latitude') return input.latitude === undefined;
      if (field === 'longitude') return input.longitude === undefined;
      return !input[field];
    });
    if (missing.length > 0) {
      block('missing_required_fields', `Missing required address fields: ${missing.join(', ')}.`);
      return;
    }

    const idMatches = ids(byId, input.addressId);
    const apnMatches = ids(byApn, input.apn);
    const situsMatches = ids(bySitus, input.normalizedSitus);
    const evidence = [
      { name: 'address_id', matches: idMatches },
      { name: 'APN', matches: apnMatches },
      { name: 'normalized situs', matches: situsMatches },
    ];
    const conflicts = evidenceConflict(evidence);
    if (conflicts.length > 0) {
      block(
        'conflicting_identity',
        `Identity evidence points to different existing addresses (${evidence
          .filter((item) => item.matches.length)
          .map((item) => `${item.name}: ${item.matches.join(', ')}`)
          .join('; ')}).`,
        conflicts
      );
      return;
    }

    const tierEvidence: Array<{ tier: ExactMatchTier; matches: string[] }> = [
      { tier: 'address_id', matches: idMatches },
      { tier: 'apn', matches: apnMatches },
      { tier: 'normalized_situs', matches: situsMatches },
    ];
    const selected = tierEvidence.find((item) => item.matches.length > 0);
    if (selected) {
      if (selected.matches.length !== 1) {
        block(
          'ambiguous_match',
          `${selected.tier} matches more than one existing address.`,
          selected.matches
        );
        return;
      }
      const addressId = selected.matches[0];
      const sourceConflictFields = existingConflicts.get(addressId);
      if (sourceConflictFields) {
        block(
          'conflicting_identity',
          `Existing master/captain records for ${addressId} disagree on ${sourceConflictFields.join(
            ' and '
          )}; canonical identity cannot be adopted safely.`,
          [addressId]
        );
        return;
      }
      const value = canonical.get(addressId);
      if (!value) throw new Error(`Internal address index error for ${addressId}.`);
      plan.matches.push({
        externalRow,
        inputAddressId: input.addressId,
        addressId,
        tier: selected.tier,
        riskGroup: riskForTier(selected.tier),
        canonical: value,
      });
      return;
    }

    const candidates: ReviewCandidate[] = [];
    const boundedCandidates = [...canonical.values()]
      .filter((value) => coarseCandidate(input, value, nearMeters))
      .sort(
        (left, right) =>
          coarseRelevance(input, right, nearMeters) - coarseRelevance(input, left, nearMeters) ||
          left.addressId.localeCompare(right.addressId)
      );
    for (const value of boundedCandidates) {
      const distance = distanceMeters(input, value);
      const score = fuzzySitusSimilarity(input, value);
      const reasons: ReviewCandidate['reasons'] = [];
      if (distance !== undefined && distance <= nearMeters) reasons.push('near_coordinate');
      if (score >= fuzzyThreshold && input.normalizedSitus !== value.normalizedSitus) reasons.push('fuzzy_situs');
      if (reasons.length > 0) {
        candidates.push({
          addressId: value.addressId,
          reasons,
          ...(distance !== undefined && distance <= nearMeters ? { distanceMeters: distance } : {}),
          ...(score >= fuzzyThreshold && input.normalizedSitus !== value.normalizedSitus
            ? { similarity: score }
            : {}),
          canonical: value,
        });
      }
    }
    candidates.sort((a, b) =>
      reviewCandidateRank(b) - reviewCandidateRank(a) ||
      (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity) ||
      (b.similarity || 0) - (a.similarity || 0) ||
      a.addressId.localeCompare(b.addressId)
    );
    // Review is a decision aid, not a dump of every address on the same
    // street. More than five candidates is not actionable for an operator.
    candidates.splice(5);
    if (candidates.length > 0) {
      const riskGroups = [...new Set(candidates.flatMap((candidate) => candidate.reasons))] as IntakeRiskGroup[];
      plan.review.push({
        externalRow,
        inputAddressId: input.addressId,
        input: {
          ...input,
          addressId: input.addressId,
          provenance: [{ dataset: 'external', row: externalRow }],
        },
        riskGroups,
        reason:
          riskGroups.includes('near_coordinate') && riskGroups.includes('fuzzy_situs')
            ? 'A very nearby record also has a similarly spelled address. Check whether they are the same place.'
            : riskGroups.includes('near_coordinate')
              ? 'An existing record uses nearly the same map location. Check whether they are the same place.'
              : 'An existing record has the same house number and a very similar street name. Check for a spelling difference.',
        candidates,
      });
      return;
    }

    plan.placeholders.push(placeholderFor(input, externalRow, prefix));
  });

  for (let index = 0; index < plan.placeholders.length; index += maxBatchSize) {
    plan.batches.push(plan.placeholders.slice(index, index + maxBatchSize));
  }
  plan.fingerprint = hash({
    inputs: {
      external: parsedExternal,
      existing: [...canonical.values()].sort((a, b) => a.addressId.localeCompare(b.addressId)),
      required,
      maxBatchSize,
      nearMeters,
      fuzzyThreshold,
      prefix,
    },
    matches: plan.matches.map((match) => [match.externalRow, match.addressId, match.tier]),
    review: plan.review.map((item) => [
      item.externalRow,
      item.candidates.map((candidate) => [candidate.addressId, candidate.reasons]),
    ]),
    blocked: plan.blocked.map((item) => [item.externalRow, item.code, item.conflictingAddressIds]),
    placeholders: plan.placeholders.map((item) => item.fingerprint),
  });
  return plan;
}

function coarseCandidate(
  input: ParsedAddress,
  existing: CanonicalAddress,
  nearMeters: number
): boolean {
  if (fuzzySitusComparable(input, existing)) return true;
  if (
    input.latitude !== undefined &&
    input.longitude !== undefined &&
    existing.latitude !== undefined &&
    existing.longitude !== undefined
  ) {
    const latitudeWindow = nearMeters / 111_000;
    const longitudeWindow = latitudeWindow / Math.max(0.2, Math.cos((input.latitude * Math.PI) / 180));
    return (
      Math.abs(input.latitude - existing.latitude) <= latitudeWindow &&
      Math.abs(input.longitude - existing.longitude) <= longitudeWindow
    );
  }
  return false;
}

function coarseRelevance(
  input: ParsedAddress,
  existing: CanonicalAddress,
  nearMeters: number
): number {
  let score = 0;
  if (fuzzySitusComparable(input, existing)) {
    score += 75 + 40 * bigramSimilarity(input.street, existing.street);
  }
  if (
    input.latitude !== undefined &&
    input.longitude !== undefined &&
    existing.latitude !== undefined &&
    existing.longitude !== undefined
  ) {
    const distance = distanceMeters(input, existing);
    if (distance !== undefined) {
      score += 30 * Math.max(0, 1 - distance / Math.max(1, nearMeters));
    }
  }
  return score;
}

/**
 * Fuzzy spelling is meaningful only after the identity-bearing components
 * agree. Comparing the whole address made every house on one street appear
 * 88–97% similar because city/state/ZIP/street text dominated the number.
 */
function fuzzySitusComparable(input: ParsedAddress, existing: CanonicalAddress): boolean {
  return Boolean(
    input.house &&
    compactIdentity(input.house) === compactIdentity(existing.house) &&
    compactIdentity(input.unit) === compactIdentity(existing.unit) &&
    input.direction === existing.direction &&
    input.city === existing.city &&
    input.state === existing.state &&
    input.zip === existing.zip &&
    input.street &&
    existing.street
  );
}

function fuzzySitusSimilarity(input: ParsedAddress, existing: CanonicalAddress): number {
  if (!fuzzySitusComparable(input, existing)) return 0;
  const inputParts = input.street.split(' ').filter(Boolean);
  const existingParts = existing.street.split(' ').filter(Boolean);
  const inputSuffix = NORMALIZED_SUFFIXES.has(inputParts.at(-1) || '') ? inputParts.pop() || '' : '';
  const existingSuffix = NORMALIZED_SUFFIXES.has(existingParts.at(-1) || '') ? existingParts.pop() || '' : '';
  // A suffix typo can still be reviewed, but two recognized and conflicting
  // suffixes (ST versus DR) identify different streets.
  if (inputSuffix && existingSuffix && inputSuffix !== existingSuffix) return 0;
  if (inputSuffix && existingSuffix) return similarity(inputParts.join(' '), existingParts.join(' '));
  if (inputSuffix || existingSuffix) {
    return Math.max(
      similarity(inputParts.join(' '), existingParts.join(' ')),
      similarity(input.street, existing.street)
    );
  }
  return similarity(input.street, existing.street);
}

function compactIdentity(value: string): string {
  // Join formatting separators around letter suffixes (10-A ↔ 10A), but keep
  // numeric separators meaningful (12 1/2 must not become 1212).
  return words(value)
    .replace(/(\d)\s+(?=[A-Z])/g, '$1')
    .replace(/([A-Z])\s+(?=\d)/g, '$1');
}

function reviewCandidateRank(candidate: ReviewCandidate): number {
  const near = candidate.reasons.includes('near_coordinate');
  const fuzzy = candidate.reasons.includes('fuzzy_situs');
  if (near && fuzzy) return 3;
  if (near) return 2;
  return 1;
}

function bigramSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const leftPairs = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index++) {
    const pair = left.slice(index, index + 2);
    leftPairs.set(pair, (leftPairs.get(pair) || 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index++) {
    const pair = right.slice(index, index + 2);
    const available = leftPairs.get(pair) || 0;
    if (available > 0) {
      overlap++;
      leftPairs.set(pair, available - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length - 2);
}

export const planExternalAddressIntake = planAddressIntake;

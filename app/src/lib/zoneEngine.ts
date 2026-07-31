// Pure zone-reconciliation engine — the first half of absorbing the Data Pull
// Extension (ZONE_PIPELINE_SPEC.md §2.1/§3, "Workflow A"). It answers the
// ambient Health question: "Is every resident correctly zoned, and does every
// zoned resident carry the right captain (NC) contact info?"
//
// Every function here is PURE: it takes plain data (a master grid + a GeoJSON
// FeatureCollection of zone polygons) and returns a structured, read-only
// report of what a zone refresh *would* change. It performs NO I/O and writes
// nothing — mirroring auditEngine.ts so it is unit-testable and diffable by the
// parity harness before any live write is ever enabled (Phase C).
//
// The geometry (bbox pre-filter + ray-casting point-in-polygon, with hole and
// multipolygon support) is ported near-verbatim from the working reference code
// `reference-tools/data-pull-extension/background.js` — it is plain,
// browser-independent JavaScript and is the behavioral source of truth.

import { createHash } from 'node:crypto';
import type { CellValue } from './values';
import { normalizeKey } from './columns';

export type Grid = CellValue[][];

// ------- Minimal GeoJSON shapes (only what we read) -------

export type Position = [number, number]; // [lon, lat]
export type PolygonCoords = Position[][]; // [outerRing, ...holeRings]
export type MultiPolygonCoords = PolygonCoords[];

export interface ZoneGeometry {
  type: 'Polygon' | 'MultiPolygon' | string;
  coordinates: unknown;
}

export interface ZoneFeature {
  type?: string;
  geometry?: ZoneGeometry | null;
  properties?: Record<string, unknown> | null;
}

export interface ZoneFeatureCollection {
  type?: string;
  features?: ZoneFeature[];
}

// ------- Geometry (ported from background.js) -------

export type BBox = [number, number, number, number]; // [minX, minY, maxX, maxY]

export function computeBBoxForGeom(geom: ZoneGeometry | null | undefined): BBox {
  const coords: Position[] = [];
  const gather = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    if (typeof arr[0] === 'number') {
      coords.push(arr as unknown as Position);
      return;
    }
    for (const item of arr) gather(item);
  };
  if (geom && geom.coordinates) gather(geom.coordinates);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

export function pointInRing(pt: Position, ring: Position[]): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// A polygon is [outerRing, hole1, hole2, ...]. Inside the outer ring but inside
// any hole ring means "not contained".
export function pointInPolygon(pt: Position, poly: PolygonCoords): boolean {
  if (!poly || poly.length === 0) return false;
  if (!pointInRing(pt, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) {
    if (pointInRing(pt, poly[k])) return false;
  }
  return true;
}

export function pointInMultiPolygon(pt: Position, multi: MultiPolygonCoords): boolean {
  for (const p of multi) if (pointInPolygon(pt, p)) return true;
  return false;
}

export interface IndexedZone {
  bbox: BBox;
  feature: ZoneFeature;
}

export function buildSpatialIndex(fc: ZoneFeatureCollection): IndexedZone[] {
  const index: IndexedZone[] = [];
  for (const f of fc.features || []) {
    if (!f.geometry) continue;
    index.push({ bbox: computeBBoxForGeom(f.geometry), feature: f });
  }
  return index;
}

export function bboxContains(bbox: BBox, pt: Position): boolean {
  const [minX, minY, maxX, maxY] = bbox;
  const [x, y] = pt;
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

function featureContains(feature: ZoneFeature, pt: Position): boolean {
  const g = feature.geometry;
  if (!g) return false;
  if (g.type === 'Polygon') return pointInPolygon(pt, g.coordinates as PolygonCoords);
  if (g.type === 'MultiPolygon') return pointInMultiPolygon(pt, g.coordinates as MultiPolygonCoords);
  return false;
}

// First containing feature wins (matches the reference tool). Returns null when
// the point is in no polygon.
export function findContainingFeature(index: IndexedZone[], pt: Position): ZoneFeature | null {
  for (const e of index) {
    if (!bboxContains(e.bbox, pt)) continue;
    if (featureContains(e.feature, pt)) return e.feature;
  }
  return null;
}

// All containing features — used to detect the (rare) overlap case where a
// point falls inside more than one polygon, so Health can surface it.
export function findContainingFeatures(index: IndexedZone[], pt: Position): ZoneFeature[] {
  const out: ZoneFeature[] = [];
  for (const e of index) {
    if (!bboxContains(e.bbox, pt)) continue;
    if (featureContains(e.feature, pt)) out.push(e.feature);
  }
  return out;
}

// ------- The zone → canonical-field mapping (from background.js OUTPUT_FIELDS) -------

// Derived output columns computed from Mapbox polygons. These are proposed
// outputs — not required inputs. The historical raw "Master Data File" tab has
// only the 48 base columns (no ZoneName / NC fields); the Data Pull App used to
// write a separate "Zones Join …" tab. SheetSmart must enrich the raw master
// itself: lat/lon + polygons → these four fields → approval-gated write later.
export interface ZoneOutputFieldSpec {
  key: 'zone' | 'ncName' | 'ncPhone' | 'ncEmail';
  canonical: string; // canonical master field label
  property: string; // source Mapbox feature property
}

export const ZONE_OUTPUT_FIELDS: ZoneOutputFieldSpec[] = [
  { key: 'zone', canonical: 'ZoneName', property: 'ZoneName' },
  { key: 'ncName', canonical: 'NC Name', property: 'ContactName' },
  { key: 'ncPhone', canonical: 'NC Phone', property: 'ContactPhone' },
  { key: 'ncEmail', canonical: 'NC Email', property: 'ContactEmail' },
];

export const ZONE_OUTPUT_CANONICALS = ZONE_OUTPUT_FIELDS.map((spec) => spec.canonical);

// When enriching a raw master, every matched resident becomes a "fill". Cap the
// detail list so Health stays readable and the stored report stays small; the
// summary counts remain exact.
export const ZONE_DETAIL_ROW_LIMIT = 250;

// ------- Reconciliation -------

// The real headers on the master, already resolved (route resolves these via
// the Field Dictionary, mirroring previewEngine.resolveFieldHeader). A null
// means the field could not be located on the master.
export interface ZoneReconcileConfig {
  latHeader: string | null;
  lonHeader: string | null;
  zoneHeader: string | null;
  ncNameHeader: string | null;
  ncPhoneHeader: string | null;
  ncEmailHeader: string | null;
  identityHeader: string | null; // resident_id
  nameHeader: string | null; // Resident Name (display only)
}

export type ZoneOutcome =
  | 'match' // computed zone equals current, nothing to change
  | 'fill' // current zone is blank; would be filled in
  | 'conflict' // computed zone differs from a non-blank current zone
  | 'unassigned' // valid coordinates but inside no polygon
  | 'missing_coords'; // blank/invalid latitude or longitude

const OUTCOME_DETAIL_PRIORITY: Record<ZoneOutcome, number> = {
  conflict: 0,
  fill: 1,
  match: 2,
  missing_coords: 3,
  unassigned: 4,
};

export interface FieldChange {
  field: string; // canonical field label
  from: string;
  to: string;
}

export interface DerivedFieldPreview {
  field: string;
  current: string;
  computed: string;
  columnExists: boolean;
}

export interface ZoneReconcileRow {
  residentId: string;
  residentName: string;
  masterRow: number; // 1-based sheet row
  outcome: ZoneOutcome;
  currentZone: string;
  computedZone: string;
  multiZone: boolean; // point fell inside more than one polygon
  contactChanges: FieldChange[]; // NC field diffs (blank->value or changed)
  outputValues: DerivedFieldPreview[]; // all four raw/current -> computed derived values
}

export interface ZoneReconcileSummary {
  featuresLoaded: number;
  totalResidentRows: number;
  withCoordinates: number;
  missingCoords: number;
  unassigned: number;
  matched: number;
  wouldFillZone: number; // blank zone -> a value
  wouldChangeZone: number; // conflict: non-blank zone -> a different value
  contactUpdates: number; // rows with at least one NC field change
  multiZone: number; // rows inside more than one polygon
  distinctZonesInMaster: number;
  distinctZonesComputed: number;
  columnsToAdd: number;
}

export interface ResolvedHeaderInfo {
  field: string;
  header: string | null;
  matched: boolean;
}

export interface ZoneWriteProposal {
  residentId: string;
  column: string;
  value: string;
  policy: 'fill_blank';
}

export interface ZoneReconcileReport {
  generatedAt: string;
  summary: ZoneReconcileSummary;
  resolution: ResolvedHeaderInfo[];
  proposedColumns: string[]; // derived output columns absent from the input grid
  enrichmentMode: boolean; // true when at least one derived output column must be added
  detailTruncated: boolean; // true when rows is a prioritized sample of a larger set
  detailTotal: number; // how many rows would have been surfaced without the cap
  configError: string; // non-empty when the reconciliation had to be skipped
  rows: ZoneReconcileRow[]; // per-resident detail (blank/unassigned/conflict/fill surfaced)
  /** Present only when reconcileZones is asked to collect fill_blank write proposals. */
  writeProposals?: ZoneWriteProposal[];
}

export interface ZoneEnrichmentPlan {
  report: ZoneReconcileReport;
  proposals: ZoneWriteProposal[];
  columnsToAdd: string[];
  fingerprint: string;
  cellsToFill: number;
  residentsTouched: number;
}

export interface ReconcileZonesOptions {
  collectWriteProposals?: boolean;
}

export function fingerprintZoneProposals(proposals: ZoneWriteProposal[]): string {
  const lines = proposals
    .map((proposal) => `${proposal.residentId}\t${proposal.column}\t${proposal.value}`)
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Build the approval-gated fill_blank enrichment plan (proposals + fingerprint). */
export function planZoneEnrichment(
  masterGrid: Grid,
  features: ZoneFeatureCollection,
  cfg: ZoneReconcileConfig
): ZoneEnrichmentPlan {
  const report = reconcileZones(masterGrid, features, cfg, { collectWriteProposals: true });
  const proposals = report.writeProposals || [];
  const residentsTouched = new Set(proposals.map((proposal) => proposal.residentId)).size;
  return {
    report,
    proposals,
    columnsToAdd: report.proposedColumns,
    fingerprint: fingerprintZoneProposals(proposals),
    cellsToFill: proposals.length,
    residentsTouched,
  };
}

export interface CaptainMoveCandidate {
  residentId: string;
  residentName: string;
  fromZone: string;
  toZone: string;
  currentZoneOnSheet: string;
  computedZone: string;
  multiZone: boolean;
}

export interface CaptainMovePlan {
  fromZone: string;
  toZone: string;
  candidates: CaptainMoveCandidate[];
  skipped: Array<{ residentId: string; reason: string }>;
  errors: string[];
  fingerprint: string;
}

/**
 * Propose identity-based moves of residents who currently sit on the source
 * captain sheet but whose Mapbox-computed zone matches the destination sheet's
 * zone. Pure: no I/O. Destination/source zone strings come from the caller
 * (detected mode of ZoneName, or an explicit override for empty test sheets).
 */
export function planCaptainSheetMoves(
  fromGrid: Grid,
  masterGrid: Grid,
  features: ZoneFeatureCollection,
  cfg: ZoneReconcileConfig,
  fromZone: string,
  toZone: string
): CaptainMovePlan {
  const plan: CaptainMovePlan = {
    fromZone: fromZone.trim(),
    toZone: toZone.trim(),
    candidates: [],
    skipped: [],
    errors: [],
    fingerprint: '',
  };
  if (!plan.fromZone) {
    plan.errors.push('Source zone could not be determined. Set an explicit from-zone or add ZoneName values on the source copy.');
    return plan;
  }
  if (!plan.toZone) {
    plan.errors.push('Destination zone could not be determined. Set an explicit to-zone or add ZoneName values on the destination copy.');
    return plan;
  }
  if (plan.fromZone === plan.toZone) {
    plan.errors.push('Source and destination zones must be different.');
    return plan;
  }

  const fromHeaders = (fromGrid[0] || []).map((h) => s(h));
  const masterHeaders = (masterGrid[0] || []).map((h) => s(h));
  const fromIdIdx = headerIndex(fromHeaders, cfg.identityHeader || 'resident_id');
  const fromNameIdx = headerIndex(fromHeaders, cfg.nameHeader || 'Resident Name');
  const fromZoneIdx = headerIndex(fromHeaders, 'ZoneName');
  const fromLatIdx = headerIndex(fromHeaders, cfg.latHeader);
  const fromLonIdx = headerIndex(fromHeaders, cfg.lonHeader);
  const masterIdIdx = headerIndex(masterHeaders, cfg.identityHeader || 'resident_id');
  const masterLatIdx = headerIndex(masterHeaders, cfg.latHeader);
  const masterLonIdx = headerIndex(masterHeaders, cfg.lonHeader);
  const masterNameIdx = headerIndex(masterHeaders, cfg.nameHeader || 'Resident Name');

  if (fromIdIdx === -1) {
    plan.errors.push('Source captain sheet has no resident_id column.');
    return plan;
  }
  if (masterLatIdx === -1 || masterLonIdx === -1) {
    if (fromLatIdx === -1 || fromLonIdx === -1) {
      plan.errors.push('Latitude/Longitude columns could not be located on the master or source sheet.');
      return plan;
    }
  }

  const index = buildSpatialIndex(features);
  if (index.length === 0) {
    plan.errors.push('No zone polygons were loaded. Check the Mapbox zone source connection and token.');
    return plan;
  }

  const masterById = new Map<string, CellValue[]>();
  if (masterIdIdx !== -1) {
    for (let i = 1; i < masterGrid.length; i++) {
      const row = masterGrid[i] || [];
      const id = s(row[masterIdIdx]);
      if (!id || masterById.has(id)) continue;
      masterById.set(id, row);
    }
  }

  for (let i = 1; i < fromGrid.length; i++) {
    const row = fromGrid[i] || [];
    const residentId = s(row[fromIdIdx]);
    if (!residentId) continue;

    const currentZoneOnSheet = fromZoneIdx === -1 ? '' : s(row[fromZoneIdx]);
    const masterRow = masterById.get(residentId);
    const latSource = masterRow && masterLatIdx !== -1 ? masterRow[masterLatIdx] : row[fromLatIdx];
    const lonSource = masterRow && masterLonIdx !== -1 ? masterRow[masterLonIdx] : row[fromLonIdx];
    const lat = toNumber(latSource);
    const lon = toNumber(lonSource);
    const residentName =
      (fromNameIdx !== -1 ? s(row[fromNameIdx]) : '') ||
      (masterRow && masterNameIdx !== -1 ? s(masterRow[masterNameIdx]) : '');

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      plan.skipped.push({ residentId, reason: 'Missing or invalid coordinates' });
      continue;
    }

    const matches = findContainingFeatures(index, [lon, lat]);
    if (matches.length === 0) {
      plan.skipped.push({ residentId, reason: 'Point is not inside any zone polygon' });
      continue;
    }
    if (matches.length > 1) {
      plan.skipped.push({ residentId, reason: 'Point falls in more than one zone; left for manual review' });
      continue;
    }

    const computedZone = featureProp(matches[0], 'ZoneName');
    if (!computedZone) {
      plan.skipped.push({ residentId, reason: 'Matched polygon has a blank ZoneName' });
      continue;
    }
    if (computedZone !== plan.toZone) {
      // Belongs on this sheet, another sheet, or nowhere we are moving to.
      continue;
    }

    plan.candidates.push({
      residentId,
      residentName,
      fromZone: plan.fromZone,
      toZone: plan.toZone,
      currentZoneOnSheet,
      computedZone,
      multiZone: false,
    });
  }

  plan.fingerprint = fingerprintCaptainMoves(plan.candidates, plan.fromZone, plan.toZone);
  return plan;
}

export function fingerprintCaptainMoves(
  candidates: Array<{ residentId: string }>,
  fromZone: string,
  toZone: string
): string {
  const lines = candidates.map((candidate) => candidate.residentId).sort();
  return createHash('sha256')
    .update(`${fromZone}\t${toZone}\n${lines.join('\n')}`)
    .digest('hex');
}

function s(value: CellValue): string {
  return String(value == null ? '' : value).trim();
}

function toNumber(value: CellValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function headerIndex(headers: string[], header: string | null): number {
  if (!header) return -1;
  const target = normalizeKey(header);
  for (let i = 0; i < headers.length; i++) {
    if (normalizeKey(headers[i]) === target) return i;
  }
  return -1;
}

function featureProp(feature: ZoneFeature, property: string): string {
  const props = feature.properties || {};
  const v = props[property];
  return v == null ? '' : String(v).trim();
}

function prioritizeDetailRows(rows: ZoneReconcileRow[]): ZoneReconcileRow[] {
  return [...rows].sort((a, b) => {
    const byOutcome = OUTCOME_DETAIL_PRIORITY[a.outcome] - OUTCOME_DETAIL_PRIORITY[b.outcome];
    if (byOutcome !== 0) return byOutcome;
    if (a.multiZone !== b.multiZone) return a.multiZone ? -1 : 1;
    return a.masterRow - b.masterRow;
  });
}

function finalizeDetailRows(rows: ZoneReconcileRow[]): {
  rows: ZoneReconcileRow[];
  detailTruncated: boolean;
  detailTotal: number;
} {
  const detailTotal = rows.length;
  if (detailTotal <= ZONE_DETAIL_ROW_LIMIT) {
    return { rows, detailTruncated: false, detailTotal };
  }
  return {
    rows: prioritizeDetailRows(rows).slice(0, ZONE_DETAIL_ROW_LIMIT),
    detailTruncated: true,
    detailTotal,
  };
}

// Reconcile (or enrich) the master's zone + captain-contact columns against the
// polygon set. READ-ONLY: computes what a refresh would change and categorizes
// every row. Missing ZoneName/NC columns are proposed outputs, not config errors.
export function reconcileZones(
  masterGrid: Grid,
  features: ZoneFeatureCollection,
  cfg: ZoneReconcileConfig,
  options: ReconcileZonesOptions = {}
): ZoneReconcileReport {
  const generatedAt = new Date().toISOString();
  const index = buildSpatialIndex(features);
  const featuresLoaded = index.length;
  const writeProposals: ZoneWriteProposal[] = [];

  const resolution: ResolvedHeaderInfo[] = [
    { field: 'Latitude', header: cfg.latHeader, matched: Boolean(cfg.latHeader) },
    { field: 'Longitude', header: cfg.lonHeader, matched: Boolean(cfg.lonHeader) },
    { field: 'ZoneName', header: cfg.zoneHeader, matched: Boolean(cfg.zoneHeader) },
    { field: 'NC Name', header: cfg.ncNameHeader, matched: Boolean(cfg.ncNameHeader) },
    { field: 'NC Phone', header: cfg.ncPhoneHeader, matched: Boolean(cfg.ncPhoneHeader) },
    { field: 'NC Email', header: cfg.ncEmailHeader, matched: Boolean(cfg.ncEmailHeader) },
    { field: 'resident_id', header: cfg.identityHeader, matched: Boolean(cfg.identityHeader) },
  ];
  const outputHeaders: Record<ZoneOutputFieldSpec['key'], string | null> = {
    zone: cfg.zoneHeader,
    ncName: cfg.ncNameHeader,
    ncPhone: cfg.ncPhoneHeader,
    ncEmail: cfg.ncEmailHeader,
  };
  const proposedColumns = ZONE_OUTPUT_FIELDS.filter((spec) => !outputHeaders[spec.key]).map(
    (spec) => spec.canonical
  );
  const enrichmentMode = proposedColumns.length > 0;

  const emptySummary: ZoneReconcileSummary = {
    featuresLoaded,
    totalResidentRows: 0,
    withCoordinates: 0,
    missingCoords: 0,
    unassigned: 0,
    matched: 0,
    wouldFillZone: 0,
    wouldChangeZone: 0,
    contactUpdates: 0,
    multiZone: 0,
    distinctZonesInMaster: 0,
    distinctZonesComputed: 0,
    columnsToAdd: proposedColumns.length,
  };

  const header0 = (masterGrid[0] || []).map((h) => s(h));
  const latIdx = headerIndex(header0, cfg.latHeader);
  const lonIdx = headerIndex(header0, cfg.lonHeader);
  const zoneIdx = headerIndex(header0, cfg.zoneHeader);
  const idIdx = headerIndex(header0, cfg.identityHeader);
  const nameIdx = headerIndex(header0, cfg.nameHeader);

  if (latIdx === -1 || lonIdx === -1) {
    return {
      generatedAt,
      summary: emptySummary,
      resolution,
      proposedColumns,
      enrichmentMode,
      detailTruncated: false,
      detailTotal: 0,
      configError:
        'Latitude/Longitude columns could not be located on the master. Confirm the Field Dictionary aliases for Latitude and Longitude.',
      rows: [],
    };
  }
  if (featuresLoaded === 0) {
    return {
      generatedAt,
      summary: emptySummary,
      resolution,
      proposedColumns,
      enrichmentMode,
      detailTruncated: false,
      detailTotal: 0,
      configError: 'No zone polygons were loaded. Check the Mapbox zone source connection and token.',
      rows: [],
    };
  }

  const rows: ZoneReconcileRow[] = [];
  const summary: ZoneReconcileSummary = { ...emptySummary };
  const masterZones = new Set<string>();
  const computedZones = new Set<string>();

  for (let i = 1; i < masterGrid.length; i++) {
    const row = masterGrid[i] || [];
    const residentId = idIdx !== -1 ? s(row[idIdx]) : '';
    // Skip fully blank spacer rows (no id and no coordinates and no zone).
    const currentZone = zoneIdx === -1 ? '' : s(row[zoneIdx]);
    const rawLat = row[latIdx];
    const rawLon = row[lonIdx];
    if (residentId === '' && currentZone === '' && s(rawLat) === '' && s(rawLon) === '') {
      continue;
    }

    summary.totalResidentRows++;
    if (currentZone !== '') masterZones.add(currentZone);

    const residentName = nameIdx !== -1 ? s(row[nameIdx]) : '';
    const masterRow = i + 1;

    const lon = toNumber(rawLon);
    const lat = toNumber(rawLat);

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      summary.missingCoords++;
      rows.push({
        residentId,
        residentName,
        masterRow,
        outcome: 'missing_coords',
        currentZone,
        computedZone: '',
        multiZone: false,
        contactChanges: [],
        outputValues: [],
      });
      continue;
    }

    summary.withCoordinates++;
    const matches = findContainingFeatures(index, [lon, lat]);
    const feature = matches[0] || null;
    const multiZone = matches.length > 1;
    if (multiZone) summary.multiZone++;

    if (!feature) {
      summary.unassigned++;
      rows.push({
        residentId,
        residentName,
        masterRow,
        outcome: 'unassigned',
        currentZone,
        computedZone: '',
        multiZone: false,
        contactChanges: [],
        outputValues: [],
      });
      continue;
    }

    const computedZone = featureProp(feature, 'ZoneName');
    if (computedZone !== '') computedZones.add(computedZone);

    const outputValues: DerivedFieldPreview[] = ZONE_OUTPUT_FIELDS.map((spec) => {
      const header = outputHeaders[spec.key];
      const idx = headerIndex(header0, header);
      return {
        field: spec.canonical,
        current: idx === -1 ? '' : s(row[idx]),
        computed: featureProp(feature, spec.property),
        columnExists: idx !== -1,
      };
    });

    // NC contact-field changes (blank->value or changed value). A missing
    // output column is treated as a blank current value and proposed for
    // creation; derived outputs are not required inputs.
    const contactChanges: FieldChange[] = [];
    for (const value of outputValues) {
      if (value.field === 'ZoneName') continue;
      if (value.computed !== '' && value.computed !== value.current) {
        contactChanges.push({ field: value.field, from: value.current, to: value.computed });
      }
    }
    if (contactChanges.length > 0) summary.contactUpdates++;

    // Live enrichment (v1) is fill_blank only: never overwrite a non-blank cell.
    if (options.collectWriteProposals && residentId) {
      for (const value of outputValues) {
        if (value.computed !== '' && value.current === '') {
          writeProposals.push({
            residentId,
            column: value.field,
            value: value.computed,
            policy: 'fill_blank',
          });
        }
      }
    }

    let outcome: ZoneOutcome;
    if (currentZone === '') {
      outcome = 'fill';
      summary.wouldFillZone++;
    } else if (currentZone === computedZone) {
      outcome = 'match';
      summary.matched++;
    } else {
      outcome = 'conflict';
      summary.wouldChangeZone++;
    }

    // A pure "match" with no contact change is the quiet, healthy case — keep it
    // out of the detail rows to keep the surfaced list focused on what needs
    // attention (fills, conflicts, unassigned, missing coords, contact updates).
    if (outcome === 'match' && contactChanges.length === 0 && !multiZone) continue;

    rows.push({
      residentId,
      residentName,
      masterRow,
      outcome,
      currentZone,
      computedZone,
      multiZone,
      contactChanges,
      outputValues,
    });
  }

  summary.distinctZonesInMaster = masterZones.size;
  summary.distinctZonesComputed = computedZones.size;

  const detail = finalizeDetailRows(rows);
  return {
    generatedAt,
    summary,
    resolution,
    proposedColumns,
    enrichmentMode,
    detailTruncated: detail.detailTruncated,
    detailTotal: detail.detailTotal,
    configError: '',
    rows: detail.rows,
    ...(options.collectWriteProposals ? { writeProposals } : {}),
  };
}

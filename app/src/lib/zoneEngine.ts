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

// Each derived master column and the Mapbox feature property it is computed
// from. All four targets are canonical fields already in the master + Field
// Dictionary, so this is reconciliation of derived fields, not a new import.
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

export interface FieldChange {
  field: string; // canonical field label
  from: string;
  to: string;
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
}

export interface ResolvedHeaderInfo {
  field: string;
  header: string | null;
  matched: boolean;
}

export interface ZoneReconcileReport {
  generatedAt: string;
  summary: ZoneReconcileSummary;
  resolution: ResolvedHeaderInfo[];
  configError: string; // non-empty when the reconciliation had to be skipped
  rows: ZoneReconcileRow[]; // per-resident detail (blank/unassigned/conflict/fill surfaced)
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

// Reconcile the master's zone + captain-contact columns against the polygon set.
// READ-ONLY: computes what a refresh would change and categorizes every row.
export function reconcileZones(
  masterGrid: Grid,
  features: ZoneFeatureCollection,
  cfg: ZoneReconcileConfig
): ZoneReconcileReport {
  const generatedAt = new Date().toISOString();
  const index = buildSpatialIndex(features);
  const featuresLoaded = index.length;

  const resolution: ResolvedHeaderInfo[] = [
    { field: 'Latitude', header: cfg.latHeader, matched: Boolean(cfg.latHeader) },
    { field: 'Longitude', header: cfg.lonHeader, matched: Boolean(cfg.lonHeader) },
    { field: 'ZoneName', header: cfg.zoneHeader, matched: Boolean(cfg.zoneHeader) },
    { field: 'NC Name', header: cfg.ncNameHeader, matched: Boolean(cfg.ncNameHeader) },
    { field: 'NC Phone', header: cfg.ncPhoneHeader, matched: Boolean(cfg.ncPhoneHeader) },
    { field: 'NC Email', header: cfg.ncEmailHeader, matched: Boolean(cfg.ncEmailHeader) },
    { field: 'resident_id', header: cfg.identityHeader, matched: Boolean(cfg.identityHeader) },
  ];

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
  };

  const header0 = (masterGrid[0] || []).map((h) => s(h));
  const latIdx = headerIndex(header0, cfg.latHeader);
  const lonIdx = headerIndex(header0, cfg.lonHeader);
  const zoneIdx = headerIndex(header0, cfg.zoneHeader);
  const idIdx = headerIndex(header0, cfg.identityHeader);
  const nameIdx = headerIndex(header0, cfg.nameHeader);

  const ncIdx: Record<string, number> = {
    ncName: headerIndex(header0, cfg.ncNameHeader),
    ncPhone: headerIndex(header0, cfg.ncPhoneHeader),
    ncEmail: headerIndex(header0, cfg.ncEmailHeader),
  };

  if (latIdx === -1 || lonIdx === -1) {
    return {
      generatedAt,
      summary: emptySummary,
      resolution,
      configError:
        'Latitude/Longitude columns could not be located on the master. Confirm the Field Dictionary aliases for Latitude and Longitude.',
      rows: [],
    };
  }
  if (zoneIdx === -1) {
    return {
      generatedAt,
      summary: emptySummary,
      resolution,
      configError: 'ZoneName column could not be located on the master.',
      rows: [],
    };
  }
  if (featuresLoaded === 0) {
    return {
      generatedAt,
      summary: emptySummary,
      resolution,
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
    const currentZone = s(row[zoneIdx]);
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
      });
      continue;
    }

    const computedZone = featureProp(feature, 'ZoneName');
    if (computedZone !== '') computedZones.add(computedZone);

    // NC contact-field changes (blank->value or changed value).
    const contactChanges: FieldChange[] = [];
    for (const spec of ZONE_OUTPUT_FIELDS) {
      if (spec.key === 'zone') continue;
      const idx = ncIdx[spec.key];
      if (idx === -1) continue; // column not on master; skip (route reports it)
      const current = s(row[idx]);
      const computed = featureProp(feature, spec.property);
      if (computed !== '' && computed !== current) {
        contactChanges.push({ field: spec.canonical, from: current, to: computed });
      }
    }
    if (contactChanges.length > 0) summary.contactUpdates++;

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
    });
  }

  summary.distinctZonesInMaster = masterZones.size;
  summary.distinctZonesComputed = computedZones.size;

  return { generatedAt, summary, resolution, configError: '', rows };
}

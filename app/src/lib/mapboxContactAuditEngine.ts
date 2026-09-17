import { createHash } from 'node:crypto';
import { trimHeaders, type Grid } from './mergeEngine';
import type { CellValue } from './values';
import {
  ZONE_OUTPUT_FIELDS,
  buildSpatialIndex,
  featureProp,
  findContainingFeatures,
  type ZoneFeature,
  type ZoneFeatureCollection,
} from './zoneEngine';

export const CONTACT_AUDIT_FIELDS = ['NC Name', 'NC Phone', 'NC Email'] as const;
export const ZONE_NAME_FIELD = 'ZoneName';

export interface ContactAuditSheetRef {
  spreadsheetId: string;
  spreadsheetName: string;
  tabName: string;
  url: string;
  kind: 'master' | 'captain';
}

export interface ContactAuditSheetInput extends ContactAuditSheetRef {
  grid: Grid;
}

export interface ContactAuditChange {
  residentId: string;
  residentName: string;
  column: string;
  action: 'fill' | 'overwrite';
  current: string;
  mapbox: string;
  /** Mapbox zone this row falls inside; used to group drift by zone. */
  zoneName: string;
}

export interface ContactAuditSheetPlan extends ContactAuditSheetRef {
  detectedZone: string;
  fills: number;
  overwrites: number;
  zoneMismatches: number;
  /** Rows whose zone label is being corrected because the zone was renamed. */
  zoneRenames: number;
  /** Renames found on this sheet, e.g. "Zone 136" -> "The Meadows". */
  renames: Array<{ from: string; to: string; rows: number }>;
  missingCoords: number;
  unassigned: number;
  multiZone: number;
  columnsToAdd: string[];
  errors: string[];
  sheetFingerprint: string;
}

export interface ContactAuditZoneDrift {
  zoneName: string;
  mapboxName: string;
  mapboxPhone: string;
  mapboxEmail: string;
  /** What the sheets most commonly say today, so the change is visible. */
  sheetZone: string;
  sheetName: string;
  sheetPhone: string;
  sheetEmail: string;
  /** Cells changing per column, so the UI can show only fields that move. */
  cellsByColumn: Record<string, number>;
  rowsTouched: number;
  fills: number;
  overwrites: number;
}

export interface FolderContactAuditPlan {
  sheets: ContactAuditSheetPlan[];
  zoneDrift: ContactAuditZoneDrift[];
  fills: number;
  overwrites: number;
  zoneMismatches: number;
  zoneRenames: number;
  renames: Array<{ from: string; to: string; rows: number }>;
  missingCoords: number;
  unassigned: number;
  multiZone: number;
  fingerprint: string;
  errors: string[];
}

export interface ReplannedContactAuditSheet {
  plan: ContactAuditSheetPlan;
  changes: ContactAuditChange[];
}

function hashParts(parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function text(value: CellValue): string {
  return String(value == null ? '' : value).trim();
}

function toNumber(value: CellValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function headerIndex(headers: string[], name: string): number {
  return headers.indexOf(name);
}

export function fingerprintMapboxRoster(features: ZoneFeatureCollection): string {
  const parts = (features.features || [])
    .map((feature) =>
      [
        featureProp(feature, 'ZoneName'),
        featureProp(feature, 'ContactName'),
        featureProp(feature, 'ContactPhone'),
        featureProp(feature, 'ContactEmail'),
      ].join('\t')
    )
    .sort();
  return hashParts(parts);
}

export function fingerprintContactAuditSheets(sheets: ContactAuditSheetPlan[]): string {
  const parts = sheets
    .filter(
      (sheet) =>
        sheet.fills + sheet.overwrites > 0 ||
        sheet.columnsToAdd.length > 0 ||
        sheet.zoneMismatches > 0
    )
    .map((sheet) => `${sheet.spreadsheetId}:${sheet.sheetFingerprint}`)
    .sort();
  return hashParts(parts);
}

export function fingerprintSelectedContactAudit(
  sheets: ContactAuditSheetPlan[],
  spreadsheetIds: string[]
): string {
  const selected = new Set(spreadsheetIds);
  return fingerprintContactAuditSheets(sheets.filter((sheet) => selected.has(sheet.spreadsheetId)));
}

function sheetFingerprint(spreadsheetId: string, changes: ContactAuditChange[], columnsToAdd: string[]): string {
  const parts = [
    ...columnsToAdd.map((column) => `col:${column}`),
    ...changes.map((change) => `${change.action}:${change.residentId}:${change.column}:${change.mapbox}`),
  ].sort();
  return hashParts([spreadsheetId, ...parts]);
}

export function buildMasterCoordLookup(masterGrid: Grid): Map<string, { lon: number; lat: number }> {
  const headers = trimHeaders(masterGrid[0]);
  const idCol = headerIndex(headers, 'resident_id');
  const latCol = headerIndex(headers, 'Latitude');
  const lonCol = headerIndex(headers, 'Longitude');
  const lookup = new Map<string, { lon: number; lat: number }>();
  if (idCol === -1 || latCol === -1 || lonCol === -1) return lookup;
  for (let row = 1; row < masterGrid.length; row++) {
    const cells = masterGrid[row] || [];
    const residentId = text(cells[idCol]);
    if (!residentId || lookup.has(residentId)) continue;
    const lon = toNumber(cells[lonCol]);
    const lat = toNumber(cells[latCol]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    lookup.set(residentId, { lon, lat });
  }
  return lookup;
}

function detectZone(headers: string[], grid: Grid, spreadsheetName: string): string {
  const zoneCol = headerIndex(headers, ZONE_NAME_FIELD);
  const counts = new Map<string, number>();
  if (zoneCol !== -1) {
    for (let row = 1; row < grid.length; row++) {
      const zone = text(grid[row]?.[zoneCol]);
      if (!zone) continue;
      counts.set(zone, (counts.get(zone) || 0) + 1);
    }
  }
  if (counts.size === 1) return [...counts.keys()][0];
  if (counts.size > 1) {
    return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
  }
  const match = spreadsheetName.match(/(?:^|[^a-z0-9])zone\s*(\d+)\b/i);
  return match ? `Zone ${Number(match[1])}` : '';
}

export function planContactAuditSheet(
  sheet: ContactAuditSheetInput,
  features: ZoneFeatureCollection,
  masterCoords: Map<string, { lon: number; lat: number }>
): ReplannedContactAuditSheet {
  const headers = trimHeaders(sheet.grid[0]);
  const idCol = headerIndex(headers, 'resident_id');
  const nameCol = headerIndex(headers, 'Resident Name');
  const latCol = headerIndex(headers, 'Latitude');
  const lonCol = headerIndex(headers, 'Longitude');
  const zoneCol = headerIndex(headers, ZONE_NAME_FIELD);
  const fieldCols = Object.fromEntries(
    ZONE_OUTPUT_FIELDS.map((spec) => [spec.canonical, headerIndex(headers, spec.canonical)])
  ) as Record<string, number>;

  const columnsToAdd = ZONE_OUTPUT_FIELDS.map((spec) => spec.canonical).filter(
    (column) => fieldCols[column] === -1
  );
  const errors: string[] = [];
  if (idCol === -1) errors.push('No resident_id column to match on.');

  const index = buildSpatialIndex(features);
  const mapboxZoneNames = new Set(
    (features.features || []).map((feature) => featureProp(feature, 'ZoneName')).filter(Boolean)
  );
  const changes: ContactAuditChange[] = [];
  const seenIds = new Set<string>();
  let zoneMismatches = 0;
  let zoneRenames = 0;
  let missingCoords = 0;
  let unassigned = 0;
  let multiZone = 0;

  // First pass: resolve every row to its Mapbox zone without deciding anything.
  // Whether a disagreeing zone label is a rename or a real relocation can only
  // be judged once the whole sheet is known.
  interface ResolvedRow {
    residentId: string;
    residentName: string;
    cells: CellValue[];
    feature: ZoneFeature;
    computedZone: string;
    currentZone: string;
  }
  const resolved: ResolvedRow[] = [];

  if (errors.length === 0) {
    for (let row = 1; row < sheet.grid.length; row++) {
      const cells = sheet.grid[row] || [];
      const residentId = text(cells[idCol]);
      if (!residentId) continue;
      if (seenIds.has(residentId)) continue;
      seenIds.add(residentId);

      const sheetLon = lonCol === -1 ? NaN : toNumber(cells[lonCol]);
      const sheetLat = latCol === -1 ? NaN : toNumber(cells[latCol]);
      const fallback = masterCoords.get(residentId);
      const lon = Number.isFinite(sheetLon) ? sheetLon : fallback?.lon;
      const lat = Number.isFinite(sheetLat) ? sheetLat : fallback?.lat;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        missingCoords++;
        continue;
      }

      const matches = findContainingFeatures(index, [lon as number, lat as number]);
      if (matches.length === 0) {
        unassigned++;
        continue;
      }
      if (matches.length > 1) {
        multiZone++;
        continue;
      }

      resolved.push({
        residentId,
        residentName: nameCol === -1 ? '' : text(cells[nameCol]),
        cells,
        feature: matches[0],
        computedZone: featureProp(matches[0], 'ZoneName'),
        currentZone: zoneCol === -1 ? '' : text(cells[zoneCol]),
      });
    }
  }

  const renameMap = detectZoneRenames(resolved, mapboxZoneNames);
  const renameCounts = new Map<string, number>();

  // Second pass: emit the writes.
  for (const row of resolved) {
    const { currentZone, computedZone, feature } = row;
    let zoneLabelChange: ContactAuditChange | null = null;

    if (currentZone && computedZone && currentZone !== computedZone) {
      if (renameMap.get(currentZone) !== computedZone) {
        // Only part of this sheet moved, and the old zone still exists in Mapbox,
        // so these people genuinely changed zones. Writing the new zone's captain
        // onto a row still labelled with the old zone would leave the row
        // self-contradictory, so change nothing at all and report it. "Move
        // residents when zone boundaries change" is the playbook for these.
        zoneMismatches++;
        continue;
      }
      // The whole sheet moved to a label that no longer exists in Mapbox: this
      // is a rename, not a relocation. Correct the label and keep going.
      zoneRenames++;
      renameCounts.set(`${currentZone}\t${computedZone}`, (renameCounts.get(`${currentZone}\t${computedZone}`) || 0) + 1);
      zoneLabelChange = {
        residentId: row.residentId,
        residentName: row.residentName,
        column: ZONE_NAME_FIELD,
        action: 'overwrite',
        current: currentZone,
        mapbox: computedZone,
        zoneName: computedZone,
      };
    } else if (!currentZone && computedZone) {
      zoneLabelChange = {
        residentId: row.residentId,
        residentName: row.residentName,
        column: ZONE_NAME_FIELD,
        action: 'fill',
        current: '',
        mapbox: computedZone,
        zoneName: computedZone,
      };
    }
    if (zoneLabelChange) changes.push(zoneLabelChange);

    for (const spec of ZONE_OUTPUT_FIELDS) {
      if (spec.canonical === ZONE_NAME_FIELD) continue;
      const computed = featureProp(feature, spec.property);
      if (!computed) continue;
      const current = fieldCols[spec.canonical] === -1 ? '' : text(row.cells[fieldCols[spec.canonical]]);
      if (current === computed) continue;
      changes.push({
        residentId: row.residentId,
        residentName: row.residentName,
        column: spec.canonical,
        action: current ? 'overwrite' : 'fill',
        current,
        mapbox: computed,
        zoneName: computedZone || 'Unnamed zone',
      });
    }
  }

  const renames = [...renameCounts.entries()]
    .map(([key, rows]) => {
      const [from, to] = key.split('\t');
      return { from, to, rows };
    })
    .sort((left, right) => right.rows - left.rows || left.from.localeCompare(right.from));

  return {
    plan: {
      spreadsheetId: sheet.spreadsheetId,
      spreadsheetName: sheet.spreadsheetName,
      tabName: sheet.tabName,
      url: sheet.url,
      kind: sheet.kind,
      detectedZone: detectZone(headers, sheet.grid, sheet.spreadsheetName),
      fills: changes.filter((change) => change.action === 'fill').length,
      overwrites: changes.filter((change) => change.action === 'overwrite').length,
      zoneMismatches,
      zoneRenames,
      renames,
      missingCoords,
      unassigned,
      multiZone,
      columnsToAdd,
      errors,
      sheetFingerprint: sheetFingerprint(sheet.spreadsheetId, changes, columnsToAdd),
    },
    changes,
  };
}

/**
 * A zone that was renamed in Mapbox looks identical, row by row, to a zone whose
 * residents were all reassigned. The difference is only visible sheet-wide:
 *
 *  - rename: every row carrying the old label resolves to the same new label,
 *    no row still agrees with the old label, and the old label is gone from
 *    Mapbox entirely. Nobody moved, so correcting the label is safe.
 *  - relocation: only some rows disagree, or the old label still exists in
 *    Mapbox. Those people really did change zones and must not be rewritten here.
 *
 * Returns old label -> new label only for the rename case.
 */
function detectZoneRenames(
  resolved: Array<{ currentZone: string; computedZone: string }>,
  mapboxZoneNames: Set<string>
): Map<string, string> {
  const byLabel = new Map<string, { agreeing: number; targets: Map<string, number> }>();
  for (const row of resolved) {
    if (!row.currentZone || !row.computedZone) continue;
    let entry = byLabel.get(row.currentZone);
    if (!entry) {
      entry = { agreeing: 0, targets: new Map() };
      byLabel.set(row.currentZone, entry);
    }
    if (row.computedZone === row.currentZone) entry.agreeing++;
    else entry.targets.set(row.computedZone, (entry.targets.get(row.computedZone) || 0) + 1);
  }

  const renames = new Map<string, string>();
  for (const [label, entry] of byLabel) {
    if (entry.agreeing > 0) continue;
    if (entry.targets.size !== 1) continue;
    if (mapboxZoneNames.has(label)) continue;
    renames.set(label, [...entry.targets.keys()][0]);
  }
  return renames;
}

export function planFolderMapboxContactAudit(
  masterGrid: Grid,
  sheets: ContactAuditSheetInput[],
  features: ZoneFeatureCollection
): FolderContactAuditPlan {
  const masterCoords = buildMasterCoordLookup(masterGrid);
  // Mapbox's own roster, so drift rows can show the authoritative value for a
  // field even when that field already matched and produced no change.
  const rosterByZone = new Map<string, { name: string; phone: string; email: string }>();
  for (const feature of features.features || []) {
    const zoneName = featureProp(feature, 'ZoneName') || 'Unnamed zone';
    if (rosterByZone.has(zoneName)) continue;
    rosterByZone.set(zoneName, {
      name: featureProp(feature, 'ContactName'),
      phone: featureProp(feature, 'ContactPhone'),
      email: featureProp(feature, 'ContactEmail'),
    });
  }

  interface ZoneBucket {
    residents: Set<string>;
    fills: number;
    overwrites: number;
    /** Most common current sheet value per column, so before/after is visible. */
    currentByColumn: Map<string, Map<string, number>>;
  }
  const zoneBuckets = new Map<string, ZoneBucket>();
  const plannedSheets: ContactAuditSheetPlan[] = [];
  const errors: string[] = [];
  let fills = 0;
  let overwrites = 0;
  let zoneMismatches = 0;
  let zoneRenames = 0;
  let missingCoords = 0;
  let unassigned = 0;
  let multiZone = 0;
  const renameTotals = new Map<string, number>();

  for (const sheet of sheets) {
    const { plan, changes } = planContactAuditSheet(sheet, features, masterCoords);
    plannedSheets.push(plan);
    errors.push(...plan.errors.map((error) => `${sheet.spreadsheetName}: ${error}`));
    fills += plan.fills;
    overwrites += plan.overwrites;
    zoneMismatches += plan.zoneMismatches;
    zoneRenames += plan.zoneRenames;
    missingCoords += plan.missingCoords;
    unassigned += plan.unassigned;
    multiZone += plan.multiZone;
    for (const rename of plan.renames) {
      const key = `${rename.from}\t${rename.to}`;
      renameTotals.set(key, (renameTotals.get(key) || 0) + rename.rows);
    }

    for (const change of changes) {
      let bucket = zoneBuckets.get(change.zoneName);
      if (!bucket) {
        bucket = { residents: new Set(), fills: 0, overwrites: 0, currentByColumn: new Map() };
        zoneBuckets.set(change.zoneName, bucket);
      }
      bucket.residents.add(change.residentId);
      if (change.action === 'fill') bucket.fills++;
      else bucket.overwrites++;
      let tally = bucket.currentByColumn.get(change.column);
      if (!tally) {
        tally = new Map();
        bucket.currentByColumn.set(change.column, tally);
      }
      tally.set(change.current, (tally.get(change.current) || 0) + 1);
    }
  }

  function commonest(bucket: ZoneBucket, column: string): string {
    const tally = bucket.currentByColumn.get(column);
    if (!tally || tally.size === 0) return '';
    return [...tally.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
    )[0][0];
  }

  plannedSheets.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.spreadsheetId.localeCompare(right.spreadsheetId) ||
      left.spreadsheetName.localeCompare(right.spreadsheetName)
  );

  return {
    sheets: plannedSheets,
    zoneDrift: [...zoneBuckets.entries()]
      .map(([zoneName, bucket]) => ({
        zoneName,
        mapboxName: rosterByZone.get(zoneName)?.name ?? '',
        mapboxPhone: rosterByZone.get(zoneName)?.phone ?? '',
        mapboxEmail: rosterByZone.get(zoneName)?.email ?? '',
        sheetZone: commonest(bucket, ZONE_NAME_FIELD),
        sheetName: commonest(bucket, 'NC Name'),
        sheetPhone: commonest(bucket, 'NC Phone'),
        sheetEmail: commonest(bucket, 'NC Email'),
        cellsByColumn: Object.fromEntries(
          [...bucket.currentByColumn.entries()].map(([column, tally]) => [
            column,
            [...tally.values()].reduce((sum, count) => sum + count, 0),
          ])
        ),
        rowsTouched: bucket.residents.size,
        fills: bucket.fills,
        overwrites: bucket.overwrites,
      }))
      .sort((left, right) => right.rowsTouched - left.rowsTouched || left.zoneName.localeCompare(right.zoneName)),
    fills,
    overwrites,
    zoneMismatches,
    zoneRenames,
    renames: [...renameTotals.entries()]
      .map(([key, rows]) => {
        const [from, to] = key.split('\t');
        return { from, to, rows };
      })
      .sort((left, right) => right.rows - left.rows || left.from.localeCompare(right.from)),
    missingCoords,
    unassigned,
    multiZone,
    fingerprint: fingerprintContactAuditSheets(plannedSheets),
    errors,
  };
}

export function summarizeContactAudit(
  plan: FolderContactAuditPlan,
  options: { sheetsScanned: number; readErrors: number; scope?: 'captains' | 'master' }
) {
  const writeTotal = plan.fills + plan.overwrites;
  const sheetsWithWrites = plan.sheets.filter((sheet) => sheet.fills + sheet.overwrites > 0 || sheet.columnsToAdd.length > 0)
    .length;
  const isMaster = options.scope === 'master';
  let headline: string;
  if (writeTotal === 0) {
    headline =
      plan.zoneMismatches > 0
        ? 'Captain contact fields already match Mapbox. Some rows have a different zone name — use the boundary-change playbook for those.'
        : 'Captain names, phones, and emails already match Mapbox.';
  } else if (isMaster) {
    const residents = Math.max(1, Math.round(plan.fills / 4));
    headline =
      `The master has about ${residents.toLocaleString()} residents inside a Mapbox zone whose zone and captain columns ` +
      `were never filled in. Filling them writes ${writeTotal.toLocaleString()} cell(s).`;
  } else {
    headline = `Mapbox would update ${writeTotal.toLocaleString()} captain-contact or blank zone cell(s) across ${sheetsWithWrites.toLocaleString()} captain sheet(s).`;
  }
  const detailParts = isMaster
    ? [
        'This is a one-time backfill, not routine drift: these columns are blank on the master today.',
        'Mapbox is the source of truth for zone name, captain name, phone, and email.',
      ]
    : [
        'Mapbox is the source of truth for captain name, phone, and email, and overwrites what the sheet says.',
        'Blank zone names are filled; a row whose zone name disagrees with Mapbox is reported only and is left completely untouched.',
      ];
  if (plan.zoneRenames > 0) {
    detailParts.push(
      `${plan.renames.map((rename) => `"${rename.from}" was renamed to "${rename.to}" (${rename.rows.toLocaleString()} rows)`).join('; ')}. ` +
        'Nobody moved, so the zone label is corrected in place.'
    );
  }
  if (plan.zoneMismatches > 0) {
    detailParts.push(
      `${plan.zoneMismatches.toLocaleString()} row(s) sit inside a different Mapbox zone than the sheet says, and the rest of their sheet did not move, ` +
        'so those people really did change zones. They are skipped entirely here — use "Move residents when zone boundaries change" for them.'
    );
  }
  return {
    headline,
    detail: detailParts.join(' '),
    fills: plan.fills,
    overwrites: plan.overwrites,
    zoneMismatches: plan.zoneMismatches,
    zoneRenames: plan.zoneRenames,
    renames: plan.renames,
    missingCoords: plan.missingCoords,
    unassigned: plan.unassigned,
    multiZone: plan.multiZone,
    sheetsAffected: sheetsWithWrites,
    sheetsScanned: options.sheetsScanned,
    readErrors: options.readErrors,
    zonesWithDrift: plan.zoneDrift.length,
  };
}

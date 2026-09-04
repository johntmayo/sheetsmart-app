import { createHash } from 'node:crypto';
import type { Grid } from './mergeEngine';
import {
  buildSpatialIndex,
  findContainingFeatures,
  ZONE_OUTPUT_FIELDS,
  type CaptainSheetInput,
  type ZoneFeature,
  type ZoneFeatureCollection,
  type ZoneReconcileConfig,
} from './zoneEngine';
import type { CellValue } from './values';

export interface MissingZoneResident {
  residentId: string;
  residentName: string;
  addressId: string;
  row: CellValue[];
}

export interface MissingZoneAddress {
  addressId: string;
  displayAddress: string;
  residents: MissingZoneResident[];
}

export interface MissingZoneSheet {
  zone: string;
  fileName: string;
  destinationFields: Record<string, string>;
  addresses: MissingZoneAddress[];
  residents: MissingZoneResident[];
}

export interface MissingZoneSheetPlan {
  zones: MissingZoneSheet[];
  blocked: Array<{ addressId: string; residentIds: string[]; reason: string }>;
  errors: string[];
  fingerprint: string;
}

export function planMissingZoneSheets(
  masterGrid: Grid,
  captainSheets: CaptainSheetInput[],
  features: ZoneFeatureCollection,
  cfg: ZoneReconcileConfig
): MissingZoneSheetPlan {
  const plan: MissingZoneSheetPlan = {
    zones: [],
    blocked: [],
    errors: [],
    fingerprint: fingerprintMissingZoneSheets([]),
  };
  const headers = (masterGrid[0] || []).map(text);
  const residentCol = headerIndex(headers, cfg.identityHeader || 'resident_id');
  const addressCol = headerIndex(headers, 'address_id');
  const nameCol = headerIndex(headers, cfg.nameHeader || 'Resident Name');
  const latCol = headerIndex(headers, cfg.latHeader);
  const lonCol = headerIndex(headers, cfg.lonHeader);
  const addressDisplayCol = headerIndex(headers, 'Address');
  const houseCol = headerIndex(headers, 'House');
  const streetCol = headerIndex(headers, 'Street');
  if (residentCol === -1 || addressCol === -1 || latCol === -1 || lonCol === -1) {
    plan.errors.push('Master must contain resident_id, address_id, Latitude, and Longitude.');
    return plan;
  }

  const existingZones = new Set(captainSheets.map((sheet) => sheet.zone.trim()).filter(Boolean));
  const index = buildSpatialIndex(features);
  if (index.length === 0) {
    plan.errors.push('No Mapbox zone polygons were loaded.');
    return plan;
  }

  const byAddress = new Map<
    string,
    Array<{ residentId: string; residentName: string; lat: number; lon: number; displayAddress: string; row: CellValue[] }>
  >();
  for (let rowIndex = 1; rowIndex < masterGrid.length; rowIndex++) {
    const row = masterGrid[rowIndex] || [];
    const residentId = text(row[residentCol]);
    const addressId = text(row[addressCol]);
    if (!residentId || !addressId) continue;
    const latText = text(row[latCol]);
    const lonText = text(row[lonCol]);
    const rows = byAddress.get(addressId) || [];
    rows.push({
      residentId,
      residentName: nameCol === -1 ? '' : text(row[nameCol]),
      lat: latText === '' ? Number.NaN : Number(latText),
      lon: lonText === '' ? Number.NaN : Number(lonText),
      displayAddress:
        addressDisplayCol !== -1
          ? text(row[addressDisplayCol])
          : [houseCol === -1 ? '' : text(row[houseCol]), streetCol === -1 ? '' : text(row[streetCol])]
              .filter(Boolean)
              .join(' '),
      row: headers.map((_header, col) => row[col] ?? ''),
    });
    byAddress.set(addressId, rows);
  }

  const grouped = new Map<string, { feature: ZoneFeature; addresses: MissingZoneAddress[] }>();
  for (const [addressId, rows] of byAddress) {
    const residentIds = rows.map((row) => row.residentId);
    if (rows.some((row) => !Number.isFinite(row.lat) || !Number.isFinite(row.lon))) {
      plan.blocked.push({ addressId, residentIds, reason: 'One or more residents are missing valid map coordinates.' });
      continue;
    }
    const matches = rows.map((row) => findContainingFeatures(index, [row.lon, row.lat]));
    if (matches.some((rowMatches) => rowMatches.length === 0)) {
      plan.blocked.push({ addressId, residentIds, reason: 'This address is not inside any Mapbox zone.' });
      continue;
    }
    if (matches.some((rowMatches) => rowMatches.length > 1)) {
      plan.blocked.push({ addressId, residentIds, reason: 'This address is inside more than one Mapbox zone.' });
      continue;
    }
    const zones = new Set(matches.map((rowMatches) => featureValue(rowMatches[0], 'ZoneName')));
    if (zones.size !== 1 || zones.has('')) {
      plan.blocked.push({ addressId, residentIds, reason: 'Residents at this address resolve to different Mapbox zones.' });
      continue;
    }
    const zone = [...zones][0];
    if (existingZones.has(zone)) continue;
    const group = grouped.get(zone) || { feature: matches[0][0], addresses: [] };
    group.addresses.push({
      addressId,
      displayAddress: rows.find((row) => row.displayAddress)?.displayAddress || '',
      residents: rows.map((row) => ({
        residentId: row.residentId,
        residentName: row.residentName,
        addressId,
        row: row.row,
      })),
    });
    grouped.set(zone, group);
  }

  for (const [zone, group] of grouped) {
    const destinationFields = zoneFields(group.feature, zone);
    const ncNames = (destinationFields['NC Name'] || '')
      .split(';')
      .map((name) => name.trim())
      .filter(Boolean)
      .join(', ');
    const addresses = group.addresses.sort((a, b) => a.displayAddress.localeCompare(b.displayAddress));
    plan.zones.push({
      zone,
      fileName: `${zone} - ${ncNames || 'No NC Name'}`.slice(0, 180),
      destinationFields,
      addresses,
      residents: addresses.flatMap((address) => address.residents),
    });
  }
  plan.zones.sort((a, b) => a.zone.localeCompare(b.zone, undefined, { numeric: true }));
  plan.fingerprint = fingerprintMissingZoneSheets(plan.zones);
  return plan;
}

export function fingerprintMissingZoneSheets(zones: MissingZoneSheet[]): string {
  const lines = zones
    .flatMap((zone) =>
      zone.residents.map(
        (resident) =>
          `${zone.zone}\t${zone.fileName}\t${resident.addressId}\t${resident.residentId}\t${resident.row
            .map((value) => text(value))
            .join('\u0001')}`
      )
    )
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function zoneFields(feature: ZoneFeature, zone: string): Record<string, string> {
  const fields: Record<string, string> = { ZoneName: zone };
  for (const spec of ZONE_OUTPUT_FIELDS) {
    if (spec.canonical === 'ZoneName') continue;
    const value = featureValue(feature, spec.property);
    if (value) fields[spec.canonical] = value;
  }
  return fields;
}

function featureValue(feature: ZoneFeature, property: string): string {
  const value = feature.properties?.[property];
  return value == null ? '' : String(value).trim();
}

function headerIndex(headers: string[], header: string | null): number {
  return header ? headers.indexOf(header) : -1;
}

function text(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

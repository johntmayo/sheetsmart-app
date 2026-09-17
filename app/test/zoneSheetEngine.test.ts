import test from 'node:test';
import assert from 'node:assert';
import { planMissingZoneSheets } from '../src/lib/zoneSheetEngine';
import type { Grid } from '../src/lib/mergeEngine';
import type { ZoneFeatureCollection, ZoneReconcileConfig } from '../src/lib/zoneEngine';

const CONFIG: ZoneReconcileConfig = {
  latHeader: 'Latitude',
  lonHeader: 'Longitude',
  zoneHeader: 'ZoneName',
  ncNameHeader: 'NC Name',
  ncPhoneHeader: 'NC Phone',
  ncEmailHeader: 'NC Email',
  identityHeader: 'resident_id',
  nameHeader: 'Resident Name',
};

const FEATURES: ZoneFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        ZoneName: 'Zone 148',
        ContactName: 'New Captain',
        ContactPhone: '555-0148',
        ContactEmail: 'captain@example.com',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
      },
    },
  ],
};

test('planMissingZoneSheets proposes one populated sheet per unmapped Mapbox zone', () => {
  const master: Grid = [
    ['address_id', 'resident_id', 'Resident Name', 'House', 'Street', 'Latitude', 'Longitude'],
    ['A1', 'R1', 'Person One', '10', 'Oak St', 5, 5],
    ['A1', 'R2', 'Person Two', '10', 'Oak St', 5, 5],
  ];
  const plan = planMissingZoneSheets(master, [], FEATURES, CONFIG);

  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.zones.length, 1);
  assert.strictEqual(plan.zones[0].zone, 'Zone 148');
  assert.strictEqual(plan.zones[0].fileName, 'Zone 148 - New Captain');
  assert.strictEqual(plan.zones[0].addresses.length, 1);
  assert.strictEqual(plan.zones[0].residents.length, 2);
  assert.strictEqual(plan.zones[0].destinationFields['NC Email'], 'captain@example.com');
});

test('planMissingZoneSheets ignores zones that already have a captain sheet', () => {
  const master: Grid = [
    ['address_id', 'resident_id', 'Resident Name', 'Latitude', 'Longitude'],
    ['A1', 'R1', 'Person One', 5, 5],
  ];
  const plan = planMissingZoneSheets(
    master,
    [{ spreadsheetId: 'S1', spreadsheetName: 'Zone 148', tabName: 'Sheet1', zone: 'Zone 148', grid: [] }],
    FEATURES,
    CONFIG
  );

  assert.strictEqual(plan.zones.length, 0);
});

test('planMissingZoneSheets reports blank coordinates instead of treating them as zero', () => {
  const master: Grid = [
    ['address_id', 'resident_id', 'Resident Name', 'Latitude', 'Longitude'],
    ['A1', 'R1', 'Person One', '', ''],
  ];
  const plan = planMissingZoneSheets(master, [], FEATURES, CONFIG);
  assert.strictEqual(plan.zones.length, 0);
  assert.match(plan.blocked[0].reason, /missing valid map coordinates/);
});

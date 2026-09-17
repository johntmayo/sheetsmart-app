import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintSelectedContactAudit,
  planFolderMapboxContactAudit,
  type ContactAuditSheetInput,
} from '../src/lib/mapboxContactAuditEngine';
import type { Grid } from '../src/lib/mergeEngine';
import type { ZoneFeatureCollection } from '../src/lib/zoneEngine';

const SQUARE: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];

function features(): ZoneFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [SQUARE] },
        properties: {
          ZoneName: 'Zone A',
          ContactName: 'Ada Captain',
          ContactPhone: '555-0001',
          ContactEmail: 'ada@example.org',
        },
      },
    ],
  };
}

function sheet(
  id: string,
  name: string,
  grid: Grid,
  kind: ContactAuditSheetInput['kind'] = 'captain'
): ContactAuditSheetInput {
  return {
    spreadsheetId: id,
    spreadsheetName: name,
    tabName: 'Sheet1',
    url: '',
    kind,
    grid,
  };
}

test('planFolderMapboxContactAudit: overwrites stale captain contacts and fills blanks', () => {
  const master: Grid = [
    ['resident_id', 'Resident Name', 'Latitude', 'Longitude', 'ZoneName', 'NC Name', 'NC Phone', 'NC Email'],
    ['R1', 'Ada', 5, 5, 'Zone A', 'Old Captain', '555-9999', ''],
  ];
  const plan = planFolderMapboxContactAudit(master, [sheet('master', 'Master', master, 'master')], features());
  assert.equal(plan.overwrites, 2);
  assert.equal(plan.fills, 1);
  assert.equal(plan.zoneMismatches, 0);
  assert.equal(plan.zoneDrift[0]?.zoneName, 'Zone A');
  assert.equal(plan.zoneDrift[0]?.mapboxName, 'Ada Captain');
});

test('planFolderMapboxContactAudit: a resident who really changed zone is left untouched', () => {
  // Only R2 disagrees, and its old label "Zone A" still exists in Mapbox, so a
  // boundary was redrawn around that one household. Writing Zone B's captain onto
  // a row still labelled Zone A would leave the row self-contradictory.
  const twoZones: ZoneFeatureCollection = {
    type: 'FeatureCollection',
    features: [
      ...features().features,
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [20, 20],
              [30, 20],
              [30, 30],
              [20, 30],
              [20, 20],
            ],
          ],
        },
        properties: { ZoneName: 'Zone B', ContactName: 'Bo', ContactPhone: '555-2', ContactEmail: 'bo@x' },
      },
    ],
  };
  const master: Grid = [
    ['resident_id', 'Resident Name', 'Latitude', 'Longitude'],
    ['R1', 'Ada', 5, 5],
    ['R2', 'Bea', 25, 25],
  ];
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'ZoneName', 'NC Name', 'NC Phone', 'NC Email'],
    ['R1', 'Ada', 'Zone A', 'Ada Captain', '555-0001', 'ada@example.org'],
    ['R2', 'Bea', 'Zone A', 'Ada Captain', '555-0001', 'ada@example.org'],
  ];
  const plan = planFolderMapboxContactAudit(master, [sheet('c1', 'Zone A Captain', captain)], twoZones);
  assert.equal(plan.zoneMismatches, 1);
  assert.equal(plan.zoneRenames, 0);
  assert.equal(plan.overwrites, 0);
  assert.equal(plan.fills, 0);
  assert.equal(plan.zoneDrift.length, 0);
});

test('planFolderMapboxContactAudit: a renamed zone corrects the label instead of reporting a move', () => {
  // Every row says "Zone 136", every row resolves to "Zone A", and "Zone 136" is
  // absent from Mapbox. Nobody moved: the zone was renamed.
  const master: Grid = [
    ['resident_id', 'Resident Name', 'Latitude', 'Longitude'],
    ['R1', 'Ada', 5, 5],
    ['R2', 'Bea', 6, 6],
  ];
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'ZoneName', 'NC Name', 'NC Phone', 'NC Email'],
    ['R1', 'Ada', 'Zone 136', 'Ada Captain', '555-0001', 'ada@example.org'],
    ['R2', 'Bea', 'Zone 136', 'Ada Captain', '555-0001', 'ada@example.org'],
  ];
  const plan = planFolderMapboxContactAudit(master, [sheet('c1', 'Zone 136 Captain', captain)], features());
  assert.equal(plan.zoneMismatches, 0);
  assert.equal(plan.zoneRenames, 2);
  assert.deepEqual(plan.renames, [{ from: 'Zone 136', to: 'Zone A', rows: 2 }]);
  // Only the label changes; the contacts already match.
  assert.equal(plan.overwrites, 2);
  assert.equal(plan.fills, 0);
  assert.deepEqual(plan.sheets[0].renames, [{ from: 'Zone 136', to: 'Zone A', rows: 2 }]);
});

test('planFolderMapboxContactAudit: a sheet-wide disagreement is NOT a rename while the old zone still exists', () => {
  // All rows disagree, but "Zone A" is a real Mapbox zone, so this is a genuine
  // reassignment of the whole sheet and must not be silently relabelled.
  const renamedTarget: ZoneFeatureCollection = {
    type: 'FeatureCollection',
    features: [
      ...features().features,
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [20, 20],
              [30, 20],
              [30, 30],
              [20, 30],
              [20, 20],
            ],
          ],
        },
        properties: { ZoneName: 'Zone B', ContactName: 'Bo', ContactPhone: '555-2', ContactEmail: 'bo@x' },
      },
    ],
  };
  const master: Grid = [
    ['resident_id', 'Resident Name', 'Latitude', 'Longitude'],
    ['R1', 'Ada', 5, 5],
  ];
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'ZoneName', 'NC Name', 'NC Phone', 'NC Email'],
    ['R1', 'Ada', 'Zone B', 'Bo', '555-2', 'bo@x'],
  ];
  const plan = planFolderMapboxContactAudit(master, [sheet('c1', 'Zone B Captain', captain)], renamedTarget);
  assert.equal(plan.zoneRenames, 0);
  assert.equal(plan.zoneMismatches, 1);
  assert.equal(plan.fills + plan.overwrites, 0);
});

test('planFolderMapboxContactAudit: a matching zone still gets its contacts corrected', () => {
  const master: Grid = [
    ['resident_id', 'Resident Name', 'Latitude', 'Longitude'],
    ['R1', 'Ada', 5, 5],
    ['R2', 'Bo', 6, 6],
  ];
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'ZoneName', 'NC Name', 'NC Phone', 'NC Email'],
    ['R1', 'Ada', 'Zone A', 'Ada Captain', 'wrong', 'ada@example.org'],
    ['R2', 'Bo', 'Zone A', 'Ada Captain', 'wrong', 'ada@example.org'],
  ];
  const plan = planFolderMapboxContactAudit(master, [sheet('c1', 'Zone A Captain', captain)], features());
  assert.equal(plan.zoneMismatches, 0);
  assert.equal(plan.overwrites, 2);
  assert.equal(plan.fills, 0);
  // Drift must isolate the one field that actually moves, not the whole sheet.
  const drift = plan.zoneDrift[0];
  assert.equal(drift.zoneName, 'Zone A');
  assert.deepEqual(drift.cellsByColumn, { 'NC Phone': 2 });
  assert.equal(drift.sheetPhone, 'wrong');
  assert.equal(drift.mapboxPhone, '555-0001');
  assert.equal(drift.rowsTouched, 2);
});

test('planFolderMapboxContactAudit: uses master coordinates when a captain sheet has none', () => {
  const master: Grid = [
    ['resident_id', 'Resident Name', 'Latitude', 'Longitude', 'ZoneName', 'NC Name', 'NC Phone', 'NC Email'],
    ['R1', 'Ada', 5, 5, 'Zone A', 'Ada Captain', '555-0001', 'ada@example.org'],
  ];
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'NC Name', 'NC Phone'],
    ['R1', 'Ada', 'Stale Name', '555-1111'],
  ];
  const plan = planFolderMapboxContactAudit(master, [sheet('c1', 'Zone A Captain', captain)], features());
  assert.equal(plan.overwrites, 2);
  assert.ok(plan.sheets[0].columnsToAdd.includes('NC Email'));
  assert.ok(plan.sheets[0].columnsToAdd.includes('ZoneName'));
});

test('planFolderMapboxContactAudit: skips overlapping polygons instead of guessing', () => {
  const overlapping: ZoneFeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [SQUARE] },
        properties: { ZoneName: 'A', ContactName: 'Ada', ContactPhone: '1', ContactEmail: 'a@x' },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [5, 5],
              [15, 5],
              [15, 15],
              [5, 15],
              [5, 5],
            ],
          ],
        },
        properties: { ZoneName: 'B', ContactName: 'Ben', ContactPhone: '2', ContactEmail: 'b@x' },
      },
    ],
  };
  const master: Grid = [
    ['resident_id', 'Latitude', 'Longitude', 'NC Name'],
    ['R1', 7, 7, 'Old'],
  ];
  const plan = planFolderMapboxContactAudit(master, [sheet('master', 'Master', master, 'master')], overlapping);
  assert.equal(plan.multiZone, 1);
  assert.equal(plan.fills + plan.overwrites, 0);
});

test('fingerprintSelectedContactAudit: changes when selected sheets change', () => {
  const master: Grid = [
    ['resident_id', 'Latitude', 'Longitude', 'NC Name'],
    ['R1', 5, 5, 'Old'],
  ];
  const other: Grid = [
    ['resident_id', 'Latitude', 'Longitude', 'NC Name'],
    ['R2', 6, 6, 'Older'],
  ];
  const plan = planFolderMapboxContactAudit(
    master,
    [sheet('a', 'A', master, 'master'), sheet('b', 'B', other)],
    features()
  );
  assert.notEqual(
    fingerprintSelectedContactAudit(plan.sheets, ['a']),
    fingerprintSelectedContactAudit(plan.sheets, ['a', 'b'])
  );
});

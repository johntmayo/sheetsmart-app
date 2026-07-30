import test from 'node:test';
import assert from 'node:assert';
import {
  pointInRing,
  pointInPolygon,
  pointInMultiPolygon,
  computeBBoxForGeom,
  buildSpatialIndex,
  findContainingFeature,
  findContainingFeatures,
  reconcileZones,
  type ZoneFeatureCollection,
  type ZoneReconcileConfig,
  type Grid,
} from '../src/lib/zoneEngine';

// A unit square from (0,0) to (10,10).
const SQUARE: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];

// A square with a hole in the middle (a "donut"): outer 0..10, hole 4..6.
const DONUT: [number, number][][] = [
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ],
  [
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
    [4, 4],
  ],
];

test('pointInRing: inside vs outside a simple square', () => {
  assert.strictEqual(pointInRing([5, 5], SQUARE), true);
  assert.strictEqual(pointInRing([15, 5], SQUARE), false);
  assert.strictEqual(pointInRing([-1, 5], SQUARE), false);
});

test('pointInPolygon: a hole excludes points inside the hole', () => {
  assert.strictEqual(pointInPolygon([1, 1], DONUT), true); // in ring, outside hole
  assert.strictEqual(pointInPolygon([5, 5], DONUT), false); // inside the hole
});

test('pointInMultiPolygon: matches any member polygon', () => {
  const far: [number, number][] = [
    [100, 100],
    [110, 100],
    [110, 110],
    [100, 110],
    [100, 100],
  ];
  const multi = [[SQUARE], [far]];
  assert.strictEqual(pointInMultiPolygon([5, 5], multi), true);
  assert.strictEqual(pointInMultiPolygon([105, 105], multi), true);
  assert.strictEqual(pointInMultiPolygon([50, 50], multi), false);
});

test('computeBBoxForGeom: bounds a polygon correctly', () => {
  assert.deepStrictEqual(computeBBoxForGeom({ type: 'Polygon', coordinates: [SQUARE] }), [0, 0, 10, 10]);
});

function fc(): ZoneFeatureCollection {
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
        properties: {
          ZoneName: 'Zone B',
          ContactName: 'Ben Captain',
          ContactPhone: '555-0002',
          ContactEmail: 'ben@example.org',
        },
      },
    ],
  };
}

test('findContainingFeature: first match wins; null when in no polygon', () => {
  const index = buildSpatialIndex(fc());
  assert.strictEqual(findContainingFeature(index, [5, 5])?.properties?.ZoneName, 'Zone A');
  assert.strictEqual(findContainingFeature(index, [25, 25])?.properties?.ZoneName, 'Zone B');
  assert.strictEqual(findContainingFeature(index, [50, 50]), null);
});

test('findContainingFeatures: detects overlap (point in >1 polygon)', () => {
  const overlapping: ZoneFeatureCollection = {
    features: [
      { geometry: { type: 'Polygon', coordinates: [SQUARE] }, properties: { ZoneName: 'A' } },
      {
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
        properties: { ZoneName: 'B' },
      },
    ],
  };
  const index = buildSpatialIndex(overlapping);
  assert.strictEqual(findContainingFeatures(index, [7, 7]).length, 2); // in both
  assert.strictEqual(findContainingFeatures(index, [1, 1]).length, 1); // only A
});

const CFG: ZoneReconcileConfig = {
  latHeader: 'Latitude',
  lonHeader: 'Longitude',
  zoneHeader: 'ZoneName',
  ncNameHeader: 'NC Name',
  ncPhoneHeader: 'NC Phone',
  ncEmailHeader: 'NC Email',
  identityHeader: 'resident_id',
  nameHeader: 'Resident Name',
};

const HEADER = [
  'resident_id',
  'Resident Name',
  'Latitude',
  'Longitude',
  'ZoneName',
  'NC Name',
  'NC Phone',
  'NC Email',
];

test('reconcileZones: categorizes fill, match, conflict, unassigned, missing coords', () => {
  const grid: Grid = [
    HEADER,
    // In Zone A, currently blank zone -> fill.
    ['r1', 'Rosa', 5, 5, '', '', '', ''],
    // In Zone A, already Zone A -> match (and contact already correct) -> not surfaced.
    ['r2', 'Sam', 6, 6, 'Zone A', 'Ada Captain', '555-0001', 'ada@example.org'],
    // In Zone B but currently labeled Zone A -> conflict (would change zone).
    ['r3', 'Tom', 25, 25, 'Zone A', '', '', ''],
    // Valid coords, in no polygon -> unassigned.
    ['r4', 'Uma', 90, 90, '', '', '', ''],
    // Blank coordinates -> missing_coords.
    ['r5', 'Vic', '', '', 'Zone A', '', '', ''],
  ];

  const report = reconcileZones(grid, fc(), CFG);
  assert.strictEqual(report.configError, '');
  const sm = report.summary;
  assert.strictEqual(sm.featuresLoaded, 2);
  assert.strictEqual(sm.totalResidentRows, 5);
  assert.strictEqual(sm.withCoordinates, 4);
  assert.strictEqual(sm.missingCoords, 1);
  assert.strictEqual(sm.unassigned, 1);
  assert.strictEqual(sm.wouldFillZone, 1);
  assert.strictEqual(sm.wouldChangeZone, 1);
  assert.strictEqual(sm.matched, 1);

  const byId = Object.fromEntries(report.rows.map((r) => [r.residentId, r]));
  assert.strictEqual(byId['r1'].outcome, 'fill');
  assert.strictEqual(byId['r1'].computedZone, 'Zone A');
  assert.strictEqual(byId['r3'].outcome, 'conflict');
  assert.strictEqual(byId['r3'].currentZone, 'Zone A');
  assert.strictEqual(byId['r3'].computedZone, 'Zone B');
  assert.strictEqual(byId['r4'].outcome, 'unassigned');
  assert.strictEqual(byId['r5'].outcome, 'missing_coords');
  // The clean, already-correct row is not surfaced in the detail list.
  assert.strictEqual(byId['r2'], undefined);
});

test('reconcileZones: surfaces captain-contact (NC) changes as fill/updates', () => {
  const grid: Grid = [
    HEADER,
    // Correct zone but stale/blank contact info -> match zone, but contact updates.
    ['r1', 'Rosa', 5, 5, 'Zone A', '', 'OLD-PHONE', ''],
  ];
  const report = reconcileZones(grid, fc(), CFG);
  assert.strictEqual(report.summary.contactUpdates, 1);
  const row = report.rows.find((r) => r.residentId === 'r1');
  assert.ok(row, 'row with contact changes should be surfaced even when zone matches');
  const fields = (row!.contactChanges || []).map((c) => c.field).sort();
  assert.deepStrictEqual(fields, ['NC Email', 'NC Name', 'NC Phone']);
});

test('reconcileZones: missing lat/lon columns yields a clear configError, no rows', () => {
  const grid: Grid = [['resident_id', 'ZoneName'], ['r1', 'Zone A']];
  const report = reconcileZones(grid, fc(), CFG);
  assert.notStrictEqual(report.configError, '');
  assert.strictEqual(report.rows.length, 0);
});

test('reconcileZones: empty polygon set yields a clear configError', () => {
  const grid: Grid = [HEADER, ['r1', 'Rosa', 5, 5, '', '', '', '']];
  const report = reconcileZones(grid, { features: [] }, CFG);
  assert.match(report.configError, /zone polygons/i);
});

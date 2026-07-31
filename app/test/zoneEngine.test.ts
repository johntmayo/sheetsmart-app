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
  planZoneEnrichment,
  planCaptainSheetMoves,
  ZONE_DETAIL_ROW_LIMIT,
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

test('reconcileZones: raw master treats missing derived columns as proposed outputs', () => {
  const rawConfig: ZoneReconcileConfig = {
    ...CFG,
    zoneHeader: null,
    ncNameHeader: null,
    ncPhoneHeader: null,
    ncEmailHeader: null,
  };
  // Mimic the historical 48-column raw master: lots of base fields, none of the
  // four derived ZoneName / NC outputs.
  const rawHeaders = [
    'resident_id',
    'Resident Name',
    'Address',
    'APN',
    'Latitude',
    'Longitude',
    'Phone',
    'Email',
    ...Array.from({ length: 40 }, (_, i) => `Extra Field ${i + 1}`),
  ];
  assert.strictEqual(rawHeaders.length, 48);
  assert.ok(!rawHeaders.includes('ZoneName'));
  assert.ok(!rawHeaders.includes('NC Name'));

  const rawGrid: Grid = [
    rawHeaders,
    ['r1', 'Rosa', '1 Main', 'APN-1', 5, 5, '555-0100', 'rosa@example.org', ...Array(40).fill('')],
    ['r2', 'Sam', '2 Main', 'APN-2', 25, 25, '', '', ...Array(40).fill('')],
    ['r3', 'Uma', '3 Main', 'APN-3', 90, 90, '', '', ...Array(40).fill('')],
  ];

  const report = reconcileZones(rawGrid, fc(), rawConfig);

  assert.strictEqual(report.configError, '');
  assert.strictEqual(report.enrichmentMode, true);
  assert.deepStrictEqual(report.proposedColumns, ['ZoneName', 'NC Name', 'NC Phone', 'NC Email']);
  assert.strictEqual(report.summary.columnsToAdd, 4);
  assert.strictEqual(report.summary.wouldFillZone, 2);
  assert.strictEqual(report.summary.contactUpdates, 2);
  assert.strictEqual(report.summary.unassigned, 1);
  assert.strictEqual(report.summary.wouldChangeZone, 0);
  assert.strictEqual(report.detailTruncated, false);

  const byId = Object.fromEntries(report.rows.map((r) => [r.residentId, r]));
  assert.strictEqual(byId['r1'].outcome, 'fill');
  assert.strictEqual(byId['r2'].outcome, 'fill');
  assert.strictEqual(byId['r3'].outcome, 'unassigned');
  assert.deepStrictEqual(
    byId['r1'].outputValues.map((value) => ({
      field: value.field,
      current: value.current,
      computed: value.computed,
      columnExists: value.columnExists,
    })),
    [
      { field: 'ZoneName', current: '', computed: 'Zone A', columnExists: false },
      { field: 'NC Name', current: '', computed: 'Ada Captain', columnExists: false },
      { field: 'NC Phone', current: '', computed: '555-0001', columnExists: false },
      { field: 'NC Email', current: '', computed: 'ada@example.org', columnExists: false },
    ]
  );
  assert.strictEqual(byId['r2'].computedZone, 'Zone B');
  assert.strictEqual(byId['r2'].outputValues.find((v) => v.field === 'NC Name')?.computed, 'Ben Captain');
});

test('planZoneEnrichment: builds fill_blank proposals and a stable fingerprint', () => {
  const rawConfig: ZoneReconcileConfig = {
    ...CFG,
    zoneHeader: null,
    ncNameHeader: null,
    ncPhoneHeader: null,
    ncEmailHeader: null,
  };
  const rawGrid: Grid = [
    ['resident_id', 'Resident Name', 'Latitude', 'Longitude'],
    ['r1', 'Rosa', 5, 5],
    ['r2', 'Sam', 25, 25],
  ];
  const plan = planZoneEnrichment(rawGrid, fc(), rawConfig);
  assert.strictEqual(plan.columnsToAdd.length, 4);
  assert.strictEqual(plan.cellsToFill, 8); // 2 residents × 4 fields
  assert.strictEqual(plan.residentsTouched, 2);
  assert.ok(plan.fingerprint.length === 64);
  assert.ok(plan.proposals.every((p) => p.policy === 'fill_blank'));
  assert.deepStrictEqual(
    plan.proposals.filter((p) => p.residentId === 'r1').map((p) => p.column).sort(),
    ['NC Email', 'NC Name', 'NC Phone', 'ZoneName']
  );

  const again = planZoneEnrichment(rawGrid, fc(), rawConfig);
  assert.strictEqual(again.fingerprint, plan.fingerprint);
});

test('reconcileZones: caps oversized detail lists without changing summary counts', () => {
  const rawConfig: ZoneReconcileConfig = {
    ...CFG,
    zoneHeader: null,
    ncNameHeader: null,
    ncPhoneHeader: null,
    ncEmailHeader: null,
  };
  const grid: Grid = [['resident_id', 'Resident Name', 'Latitude', 'Longitude']];
  for (let i = 0; i < ZONE_DETAIL_ROW_LIMIT + 25; i++) {
    // Keep every point inside Zone A so each becomes a fill/enrichment row.
    grid.push([`r${i}`, `Person ${i}`, 5, 5]);
  }

  const report = reconcileZones(grid, fc(), rawConfig);
  assert.strictEqual(report.enrichmentMode, true);
  assert.strictEqual(report.summary.wouldFillZone, ZONE_DETAIL_ROW_LIMIT + 25);
  assert.strictEqual(report.summary.contactUpdates, ZONE_DETAIL_ROW_LIMIT + 25);
  assert.strictEqual(report.detailTruncated, true);
  assert.strictEqual(report.detailTotal, ZONE_DETAIL_ROW_LIMIT + 25);
  assert.strictEqual(report.rows.length, ZONE_DETAIL_ROW_LIMIT);
  assert.ok(report.rows.every((row) => row.outcome === 'fill'));
  assert.ok(report.rows.every((row) => row.outputValues.length === 4));
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

test('planCaptainSheetMoves: proposes only residents whose computed zone is the destination', () => {
  const fromGrid: Grid = [
    ['resident_id', 'Resident Name', 'ZoneName'],
    ['stay', 'Stays Here', 'Zone A'],
    ['move', 'Should Move', 'Zone A'],
    ['no-coords', 'Missing Coords', 'Zone A'],
  ];
  const masterGrid: Grid = [
    ['resident_id', 'Resident Name', 'Latitude', 'Longitude', 'ZoneName'],
    ['stay', 'Stays Here', 5, 5, 'Zone A'],
    ['move', 'Should Move', 25, 25, 'Zone A'],
    ['no-coords', 'Missing Coords', '', '', 'Zone A'],
  ];
  const plan = planCaptainSheetMoves(fromGrid, masterGrid, fc(), CFG, 'Zone A', 'Zone B');
  assert.strictEqual(plan.errors.length, 0);
  assert.deepStrictEqual(
    plan.candidates.map((row) => ({ id: row.residentId, to: row.computedZone })),
    [{ id: 'move', to: 'Zone B' }]
  );
  assert.ok(plan.skipped.some((row) => row.residentId === 'no-coords'));
  assert.ok(plan.fingerprint.length === 64);
});

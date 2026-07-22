import test from 'node:test';
import assert from 'node:assert';
import {
  runAudit,
  buildMasterModel,
  detectSheetZone,
  countTrueInColumn,
  type Grid,
  type SheetInput,
} from '../src/lib/auditEngine';

// A small but representative master mirroring the real schema's key columns.
const MASTER: Grid = [
  ['resident_id', 'ZoneName', 'Resident Name', 'House', 'Street', 'APN', 'Damage', 'Address', 'Address - For Sale'],
  ['R1', 'Zone A', 'Ann', '10', 'Oak', 'APN1', 'Major', '10 Oak', true],
  ['R2', 'Zone A', 'Bob', '12', 'Oak', 'APN2', '', '12 Oak', false],
  ['R3', 'Zone B', 'Cy', '20', 'Elm', 'APN3', 'Minor', '20 Elm', true],
];

test('buildMasterModel builds roster and residents by zone, filtering blank headers', () => {
  const model = buildMasterModel(MASTER);
  assert.strictEqual(model.rowMembershipSkipReason, '');
  assert.deepStrictEqual(Object.keys(model.roster).sort(), ['Zone A', 'Zone B']);
  assert.deepStrictEqual(Object.keys(model.roster['Zone A']).sort(), ['R1', 'R2']);
  assert.strictEqual(model.residents['R1'].masterRow, 2); // header + 1
  assert.strictEqual(model.residents['R3'].zoneName, 'Zone B');
});

test('buildMasterModel skips row membership when required columns are missing', () => {
  const model = buildMasterModel([['Resident Name', 'House'], ['Ann', '10']]);
  assert.match(model.rowMembershipSkipReason, /resident_id, ZoneName/);
});

test('detectSheetZone returns the mode of ZoneName, robust to a few stale rows', () => {
  const headers = ['resident_id', 'ZoneName'];
  const rows: Grid = [
    ['R1', 'Zone A'],
    ['R2', 'Zone A'],
    ['R3', 'Zone B'], // stale minority
  ];
  assert.strictEqual(detectSheetZone(headers, rows), 'Zone A');
  assert.strictEqual(detectSheetZone(['resident_id'], rows), ''); // no ZoneName column
});

test('countTrueInColumn counts strict === true only (checkbox semantics)', () => {
  const headers = ['Address - For Sale'];
  const rows: Grid = [[true], [false], [''], ['TRUE'], [1]];
  assert.strictEqual(countTrueInColumn(headers, rows, 'Address - For Sale'), 1);
  assert.strictEqual(countTrueInColumn(headers, rows, 'Nope'), 'N/A');
});

test('runAudit classifies column drift and counts APN/Damage non-blank', () => {
  const sheets: SheetInput[] = [
    {
      name: 'Zone A Captain',
      url: 'http://a',
      // Missing "Damage"; adds an extra "Notes" column; APN blank on one row.
      data: [
        ['resident_id', 'ZoneName', 'Resident Name', 'House', 'Street', 'APN', 'Address', 'Notes'],
        ['R1', 'Zone A', 'Ann', '10', 'Oak', 'APN1', '10 Oak', 'hi'],
        ['R2', 'Zone A', 'Bob', '12', 'Oak', '', '12 Oak', ''],
      ],
    },
  ];
  const report = runAudit(MASTER, sheets);
  const s = report.sheets[0];
  assert.strictEqual(s.status, 'Missing + Extra');
  assert.ok(s.missingColumns.includes('Damage'));
  assert.deepStrictEqual(s.extraColumns, ['Notes']);
  assert.strictEqual(s.apnValues, 1); // one non-blank APN
  assert.strictEqual(s.damageValues, 'N/A'); // no Damage column
  assert.strictEqual(s.addressesMissingApn, 1); // "12 Oak" has blank APN
  assert.strictEqual(s.zone, 'Zone A');
});

test('runAudit computes missing and extra rows by detected zone', () => {
  const sheets: SheetInput[] = [
    {
      name: 'Zone A Captain',
      url: 'http://a',
      data: [
        ['resident_id', 'ZoneName', 'Resident Name', 'House', 'Street', 'APN', 'Damage', 'Address', 'Address - For Sale'],
        ['R1', 'Zone A', 'Ann', '10', 'Oak', 'APN1', 'Major', '10 Oak', true],
        // R2 (Zone A) is missing from this sheet -> missing row.
        ['R3', 'Zone A', 'Cy', '20', 'Elm', 'APN3', 'Minor', '20 Elm', true], // master says Zone B -> wrong zone
        ['X9', 'Zone A', 'Zed', '99', 'Ash', 'APN9', '', '99 Ash', false], // not in master
      ],
    },
  ];
  const report = runAudit(MASTER, sheets);
  const s = report.sheets[0];
  assert.strictEqual(s.missingRows, 1);
  assert.strictEqual(s.extraWrongZone, 1);
  assert.strictEqual(s.extraNotInMaster, 1);

  assert.strictEqual(report.summary.totalMissingRows, 1);
  assert.strictEqual(report.summary.totalExtraWrongZone, 1);
  assert.strictEqual(report.summary.totalExtraNotInMaster, 1);

  const missing = report.missingRows[0];
  assert.strictEqual(missing.residentId, 'R2');
  assert.strictEqual(missing.residentName, 'Bob'); // R2 is Bob in the master
  assert.strictEqual(missing.masterRow, 3); // header + 2
});

test('runAudit finds duplicate resident_ids within and across sheets', () => {
  const sheets: SheetInput[] = [
    {
      name: 'Sheet 1',
      data: [
        ['resident_id', 'ZoneName'],
        ['R1', 'Zone A'],
        ['R1', 'Zone A'], // within-sheet dup
      ],
    },
    {
      name: 'Sheet 2',
      data: [
        ['resident_id', 'ZoneName'],
        ['R2', 'Zone B'],
      ],
    },
    {
      name: 'Sheet 3',
      data: [
        ['resident_id', 'ZoneName'],
        ['R2', 'Zone B'], // across-sheet dup with Sheet 2
      ],
    },
  ];
  const report = runAudit(MASTER, sheets);
  assert.strictEqual(report.summary.duplicateResidentIds, 2); // R1 and R2
  const r1 = report.duplicateResidentIds.filter((d) => d.residentId === 'R1');
  const r2 = report.duplicateResidentIds.filter((d) => d.residentId === 'R2');
  assert.ok(r1.every((d) => d.scope === 'Within Sheet'));
  assert.ok(r2.every((d) => d.scope === 'Across Sheets'));
});

test('runAudit records ERROR and Empty sheets without throwing', () => {
  const sheets: SheetInput[] = [
    { name: 'Broken', error: 'Permission denied' },
    { name: 'Empty', data: [] },
  ];
  const report = runAudit(MASTER, sheets);
  assert.strictEqual(report.summary.sheetsWithErrors, 1);
  assert.strictEqual(report.summary.sheetsEmpty, 1);
  assert.strictEqual(report.sheets[0].status, 'ERROR');
  assert.strictEqual(report.sheets[0].error, 'Permission denied');
  assert.strictEqual(report.sheets[1].status, 'Empty');
});

test('runAudit flags APN inconsistencies at the same address', () => {
  const sheets: SheetInput[] = [
    {
      name: 'Zone A Captain',
      data: [
        ['resident_id', 'ZoneName', 'House', 'Street', 'APN'],
        ['R1', 'Zone A', '10', 'Oak', 'APN1'],
        ['R2', 'Zone A', '10', 'Oak', ''], // same address, missing APN -> mixed completeness
        ['R4', 'Zone A', '30', 'Pine', 'APN-A'],
        ['R5', 'Zone A', '30', 'Pine', 'APN-B'], // same address, two APN values
      ],
    },
  ];
  const report = runAudit(MASTER, sheets);
  assert.strictEqual(report.apnInconsistencies.length, 2);
  const oak = report.apnInconsistencies.find((a) => a.address.toLowerCase() === '10 oak');
  assert.match(oak!.reason, /Some rows missing APN/);
  const pine = report.apnInconsistencies.find((a) => a.address.toLowerCase() === '30 pine');
  assert.match(pine!.reason, /Multiple APN values/);
});

test('runAudit reports rows missing situs address fields', () => {
  const sheets: SheetInput[] = [
    {
      name: 'Zone A Captain',
      data: [
        ['resident_id', 'ZoneName', 'House', 'Street', '_SitusHouseNo', '_SitusStreet'],
        ['R1', 'Zone A', '10', 'Oak', '10', 'Oak St'],
        ['R2', 'Zone A', '12', 'Oak', '', 'Oak St'], // missing _SitusHouseNo
      ],
    },
  ];
  const report = runAudit(MASTER, sheets);
  assert.strictEqual(report.summary.totalMissingSitus, 1);
  assert.strictEqual(report.missingSitusRows[0].residentId, 'R2');
  assert.match(report.missingSitusRows[0].missingFields, /_SitusHouseNo/);
});

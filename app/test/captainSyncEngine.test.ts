import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintPushFieldsSheets,
  fingerprintPushMissingSheets,
  fingerprintSelectedPushMissing,
  planFolderPushMissing,
} from '../src/lib/captainSyncEngine';
import type { Grid } from '../src/lib/mergeEngine';

const master: Grid = [
  ['resident_id', 'Resident Name', 'ZoneName'],
  ['r1', 'Alice', 'North'],
  ['r2', 'Bob', 'North'],
];

test('planFolderPushMissing finds residents missing from the matching captain sheet', () => {
  const captain = {
    spreadsheetId: 'sheet-1',
    spreadsheetName: 'North Captain',
    tabName: '',
    url: '',
    grid: [
      ['resident_id', 'Resident Name', 'ZoneName'],
      ['r1', 'Alice', 'North'],
    ] as Grid,
  };
  const [plan] = planFolderPushMissing(master, [captain], {
    sensitiveColumns: [],
    distributedColumns: ['resident_id', 'Resident Name', 'ZoneName'],
  });
  assert.equal(plan.detectedZone, 'North');
  assert.deepEqual(plan.appended.map((row) => row.residentId), ['r2']);
});

test('folder push-missing fingerprint changes when selected sheets change', () => {
  const mixedMaster: Grid = [
    ['resident_id', 'Resident Name', 'ZoneName'],
    ['r1', 'Alice', 'North'],
    ['r2', 'Bob', 'North'],
    ['r3', 'Carol', 'South'],
  ];
  const sheets = planFolderPushMissing(mixedMaster, [
    {
      spreadsheetId: 'sheet-1',
      spreadsheetName: 'North Captain',
      tabName: '',
      url: '',
      grid: [
        ['resident_id', 'Resident Name', 'ZoneName'],
        ['r1', 'Alice', 'North'],
      ] as Grid,
    },
    {
      spreadsheetId: 'sheet-2',
      spreadsheetName: 'South Captain',
      tabName: '',
      url: '',
      grid: [
        ['resident_id', 'Resident Name', 'ZoneName'],
        ['r9', 'Zed', 'South'],
      ] as Grid,
    },
  ], {
    sensitiveColumns: [],
    distributedColumns: ['resident_id', 'Resident Name', 'ZoneName'],
  });
  const all = fingerprintPushMissingSheets(sheets);
  const one = fingerprintSelectedPushMissing(sheets, ['sheet-1']);
  assert.notEqual(all, one);
});

test('folder push-fields fingerprint is stable for unchanged plans', () => {
  const sheets = [
    {
      spreadsheetId: 'sheet-1',
      spreadsheetName: 'North Captain',
      tabName: '',
      url: '',
      filled: 3,
      conflicts: 0,
      overwritten: 0,
      columnsToAdd: [],
      errors: [],
      sheetFingerprint: 'abc123',
    },
  ];
  assert.equal(fingerprintPushFieldsSheets(sheets), fingerprintPushFieldsSheets([...sheets]));
});

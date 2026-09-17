import test from 'node:test';
import assert from 'node:assert';
import {
  applyMapboxAssignmentNeverPolicies,
  fingerprintSelectedPullFolder,
  planFolderPullToMaster,
  pullSheetFingerprint,
} from '../src/lib/captainPullEngine';
import { planPullToMaster } from '../src/lib/pullEngine';
import type { Grid } from '../src/lib/mergeEngine';

const MASTER: Grid = [
  ['resident_id', 'Resident Name', 'Phone', 'Damage', 'ZoneName', 'NC Name'],
  ['R1', 'Ada Lovelace', '', 'Minor', 'Zone A', 'Captain A'],
  ['R2', 'Alan Turing', '555-0002', '', 'Zone B', 'Captain B'],
];

const POLICIES = { Phone: 'fill_blank', Damage: 'fill_blank', Notes: 'conflict' };

test('planFolderPullToMaster: merges fills from two captain sheets', () => {
  const sheetA: Grid = [
    ['resident_id', 'Resident Name', 'Phone', 'Damage'],
    ['R1', 'Ada Lovelace', '555-0001', ''],
  ];
  const sheetB: Grid = [
    ['resident_id', 'Resident Name', 'Phone', 'Damage'],
    ['R2', 'Alan Turing', '', 'None'],
  ];
  const plan = planFolderPullToMaster(MASTER, [
    {
      spreadsheetId: 'sheet-a',
      spreadsheetName: 'Captain A',
      tabName: 'Sheet1',
      url: '',
      grid: sheetA,
    },
    {
      spreadsheetId: 'sheet-b',
      spreadsheetName: 'Captain B',
      tabName: 'Sheet1',
      url: '',
      grid: sheetB,
    },
  ], { policies: POLICIES });

  assert.deepStrictEqual(
    plan.fills.map((fill) => `${fill.residentId}.${fill.column}`).sort(),
    ['R1.Phone', 'R2.Damage']
  );
  assert.strictEqual(plan.overwrites.length, 0);
  assert.strictEqual(plan.sheets.length, 2);
});

test('planFolderPullToMaster: cross-sheet disagreement becomes a conflict, not a write', () => {
  const sheetA: Grid = [
    ['resident_id', 'Phone'],
    ['R1', '555-0001'],
  ];
  const sheetB: Grid = [
    ['resident_id', 'Phone'],
    ['R1', '555-0002'],
  ];
  const plan = planFolderPullToMaster(MASTER, [
    {
      spreadsheetId: 'sheet-a',
      spreadsheetName: 'Captain A',
      tabName: 'Sheet1',
      url: '',
      grid: sheetA,
    },
    {
      spreadsheetId: 'sheet-b',
      spreadsheetName: 'Captain B',
      tabName: 'Sheet1',
      url: '',
      grid: sheetB,
    },
  ], { policies: { Phone: 'fill_blank' } });

  assert.strictEqual(plan.fills.length, 0);
  assert.strictEqual(plan.overwrites.length, 0);
  assert.strictEqual(plan.conflicts.length, 1);
  assert.strictEqual(plan.conflicts[0].residentId, 'R1');
  assert.strictEqual(plan.conflicts[0].column, 'Phone');
  assert.ok(plan.conflictRecords.some((record) => record.crossSheetDisagreement));
});

test('fingerprintSelectedPullFolder: changes when selection changes', () => {
  const sheets = [
    {
      spreadsheetId: 'sheet-a',
      spreadsheetName: 'Captain A',
      tabName: 'Sheet1',
      url: '',
      fills: 1,
      overwrites: 0,
      conflicts: 0,
      unmatched: 0,
      errors: [],
      sheetFingerprint: 'fp-a',
    },
    {
      spreadsheetId: 'sheet-b',
      spreadsheetName: 'Captain B',
      tabName: 'Sheet1',
      url: '',
      fills: 2,
      overwrites: 0,
      conflicts: 0,
      unmatched: 0,
      errors: [],
      sheetFingerprint: 'fp-b',
    },
  ];
  const one = fingerprintSelectedPullFolder(sheets, ['sheet-a']);
  const two = fingerprintSelectedPullFolder(sheets, ['sheet-a', 'sheet-b']);
  assert.notStrictEqual(one, two);
});

test('applyMapboxAssignmentNeverPolicies: zone/captain columns are not written', () => {
  const captain: Grid = [
    ['resident_id', 'ZoneName', 'NC Name', 'Phone'],
    ['R1', 'Zone Z', 'New Captain', '555-0001'],
  ];
  const policies = applyMapboxAssignmentNeverPolicies(
    { Phone: 'fill_blank', ZoneName: 'overwrite', 'NC Name': 'overwrite' },
    ['resident_id', 'ZoneName', 'NC Name', 'Phone']
  );
  const plan = planPullToMaster(MASTER, captain, { policies });
  assert.strictEqual(plan.fills.length, 1);
  assert.strictEqual(plan.fills[0].column, 'Phone');
  assert.ok(plan.skipped.some((skip) => skip.column === 'ZoneName'));
  assert.ok(plan.skipped.some((skip) => skip.column === 'NC Name'));
});

test('pullSheetFingerprint: changes when a sheet plan changes', () => {
  const master: Grid = [
    ['resident_id', 'Phone'],
    ['R1', '555-old'],
  ];
  const captain: Grid = [
    ['resident_id', 'Phone'],
    ['R1', '555-new'],
  ];
  const planA = planPullToMaster(master, captain, { policies: { Phone: 'conflict' } });
  const planB = planPullToMaster(master, captain, { policies: { Phone: 'overwrite' } });
  const fpA = pullSheetFingerprint('sheet-a', planA);
  const fpB = pullSheetFingerprint('sheet-a', planB);
  assert.notStrictEqual(fpA, fpB);
});

test('planFolderPullToMaster: agreeing values from two sheets become one write', () => {
  const sheetA: Grid = [
    ['resident_id', 'Phone'],
    ['R1', '555-0001'],
  ];
  const sheetB: Grid = [
    ['resident_id', 'Phone'],
    ['R1', '555-0001'],
  ];
  const plan = planFolderPullToMaster(MASTER, [
    {
      spreadsheetId: 'sheet-b',
      spreadsheetName: 'Captain B',
      tabName: 'Sheet1',
      url: '',
      grid: sheetB,
    },
    {
      spreadsheetId: 'sheet-a',
      spreadsheetName: 'Captain A',
      tabName: 'Sheet1',
      url: '',
      grid: sheetA,
    },
  ], { policies: { Phone: 'fill_blank' } });

  assert.strictEqual(plan.fills.length, 1);
  assert.strictEqual(plan.fills[0].captainValue, '555-0001');
});

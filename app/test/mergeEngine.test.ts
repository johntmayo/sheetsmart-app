import test from 'node:test';
import assert from 'node:assert';
import {
  buildSourceLookup,
  planCellFill,
  planPushMissingResidents,
  type ColumnMap,
} from '../src/lib/mergeEngine';

test('buildSourceLookup keys by match column and keeps the first duplicate', () => {
  const data = [
    ['APN', 'Sale Price'],
    ['123', 500000],
    ['456', 600000],
    ['123', 999999], // duplicate APN, ignored
  ];
  const { lookup, matchIdx } = buildSourceLookup(data, 'APN');
  assert.strictEqual(matchIdx, 0);
  assert.strictEqual(lookup['123']['Sale Price'], 500000);
  assert.strictEqual(Object.keys(lookup).length, 2);
});

test('planCellFill fills blanks, adds missing columns, and logs conflicts', () => {
  const source = [
    ['APN', 'Sale Price', 'Buyer'],
    ['123', 500000, 'Alice'],
    ['456', 600000, 'Bob'],
  ];
  const { lookup } = buildSourceLookup(source, 'APN');

  const target = [
    ['APN', 'Sale Price', 'Buyer'], // Buyer exists but blank; Sale Price has a conflicting value
    ['123', 111111, ''],
    ['456', '', ''],
  ];
  const map: ColumnMap[] = [
    { source: 'Sale Price', target: 'Sale Price' },
    { source: 'Buyer', target: 'Buyer' },
  ];
  const plan = planCellFill(target, lookup, 'APN', map, { defaultPolicy: 'fill_blank' });

  // Row 2 Sale Price differs (111111 vs 500000) -> conflict, no write.
  assert.strictEqual(plan.conflicts.length, 1);
  assert.strictEqual(plan.conflicts[0].column, 'Sale Price');
  // Buyer blank on both rows -> two fills; Sale Price blank on row 3 -> one fill.
  assert.strictEqual(plan.filled.length, 3);
  assert.strictEqual(plan.writes.length, 3);
  assert.strictEqual(plan.columnsToAdd.length, 0);
});

test('planCellFill virtually adds a mapped target column that does not exist', () => {
  const source = [
    ['APN', 'New Field'],
    ['123', 'hello'],
  ];
  const { lookup } = buildSourceLookup(source, 'APN');
  const target = [
    ['APN'],
    ['123'],
  ];
  const map: ColumnMap[] = [{ source: 'New Field', target: 'New Field' }];
  const plan = planCellFill(target, lookup, 'APN', map, { defaultPolicy: 'fill_blank' });
  assert.deepStrictEqual(plan.columnsToAdd, ['New Field']);
  assert.strictEqual(plan.filled.length, 1);
  assert.strictEqual(plan.filled[0].newValue, 'hello');
});

test('planPushMissingResidents appends only absent residents for the detected zone', () => {
  const master = [
    ['resident_id', 'ZoneName', 'Resident Name', 'Phone'],
    ['R1', 'Zone A', 'Ann', '555-1'],
    ['R2', 'Zone A', 'Bob', '555-2'],
    ['R3', 'Zone B', 'Cy', '555-3'], // different zone, excluded
  ];
  const target = [
    ['resident_id', 'ZoneName', 'Resident Name', 'Phone'],
    ['R1', 'Zone A', 'Ann', ''], // already present
  ];
  const plan = planPushMissingResidents(target, master, { sensitiveColumns: ['Phone'] });
  assert.strictEqual(plan.detectedZone, 'Zone A');
  assert.strictEqual(plan.appended.length, 1);
  assert.strictEqual(plan.appended[0].residentId, 'R2');
  // Phone is sensitive and R2 has a value -> flagged (informational, still appended).
  assert.strictEqual(plan.flagged.length, 1);
  assert.strictEqual(plan.flagged[0].residentId, 'R2');
  assert.strictEqual(plan.newRows.length, 1);
});

test('planPushMissingResidents errors clearly when target lacks required columns', () => {
  const master = [['resident_id', 'ZoneName'], ['R1', 'Zone A']];
  const target = [['resident_id'], ['R1']]; // no ZoneName
  const plan = planPushMissingResidents(target, master);
  assert.strictEqual(plan.errors.length, 1);
  assert.match(plan.errors[0].message, /ZoneName/);
});

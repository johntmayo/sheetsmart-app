import test from 'node:test';
import assert from 'node:assert';
import { filterGridByTombstones } from '../src/lib/tombstones';

test('active resident and address tombstones remove records before reconciliation', () => {
  const grid = [
    ['resident_id', 'address_id', 'Resident Name'],
    ['resident-1', 'address-1', 'Deleted person'],
    ['resident-2', 'address-2', 'Deleted address resident'],
    ['resident-3', 'address-3', 'Current resident'],
  ];
  const filtered = filterGridByTombstones(grid, [
    { kind: 'resident', id: 'resident-1' },
    { kind: 'address', id: 'address-2' },
  ]);
  assert.deepStrictEqual(filtered, [
    grid[0],
    ['resident-3', 'address-3', 'Current resident'],
  ]);
});

test('tombstone filtering supports resolved alias headers', () => {
  const grid = [
    ['Person ID', 'Household ID'],
    ['resident-1', 'address-1'],
  ];
  assert.deepStrictEqual(
    filterGridByTombstones(grid, [{ kind: 'resident', id: 'resident-1' }], {
      residentHeader: 'Person ID',
      addressHeader: 'Household ID',
    }),
    [grid[0]]
  );
});

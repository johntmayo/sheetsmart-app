import test from 'node:test';
import assert from 'node:assert';
import { planGuardedAppends, planGuardedCellWrites } from '../src/lib/liveWriteEngine';

test('cell writes are re-located by resident_id and guarded against current values', () => {
  const target = [
    ['resident_id', 'Phone', 'Email'],
    ['R-2', 'already here', ''],
    ['R-1', '', 'same@example.org'],
  ];

  const plan = planGuardedCellWrites(target, [
    { residentId: 'R-1', column: 'Phone', value: '626-555-0101', policy: 'fill_blank' },
    { residentId: 'R-2', column: 'Phone', value: 'new value', policy: 'fill_blank' },
    { residentId: 'R-1', column: 'Email', value: 'same@example.org', policy: 'fill_blank' },
  ]);

  assert.deepStrictEqual(
    plan.writes.map((write) => ({ residentId: write.residentId, row: write.row, col: write.col })),
    [{ residentId: 'R-1', row: 3, col: 2 }]
  );
  assert.strictEqual(plan.conflicts.length, 1);
  assert.strictEqual(plan.conflicts[0].residentId, 'R-2');
  assert.strictEqual(plan.skipped[0].reason, 'Target already equals source');
});

test('cell writes reject protected identity changes and ambiguous duplicate identities', () => {
  const target = [
    ['resident_id', 'Phone'],
    ['R-1', ''],
    ['R-1', ''],
  ];

  const plan = planGuardedCellWrites(target, [
    { residentId: 'R-1', column: 'Phone', value: '626-555-0101', policy: 'fill_blank' },
    { residentId: 'R-1', column: 'resident_id', value: 'R-9', policy: 'overwrite' },
  ]);

  assert.strictEqual(plan.writes.length, 0);
  assert.strictEqual(plan.skipped.length, 2);
  assert.match(plan.skipped[0].reason, /Duplicate resident_id/);
});

test('append planning adds only identities absent from the current target', () => {
  const target = [
    ['resident_id', 'Resident Name', 'Phone'],
    ['R-1', 'Existing Person', ''],
  ];
  const candidates = [
    ['R-1', 'Duplicate Person', '626-555-0001'],
    ['R-2', 'New Person', '626-555-0002'],
    ['R-2', 'Duplicate Candidate', '626-555-0003'],
    ['', 'Missing Identity', '626-555-0004'],
  ];

  const plan = planGuardedAppends(target, candidates);

  assert.deepStrictEqual(plan.appends, [
    { residentId: 'R-2', row: ['R-2', 'New Person', '626-555-0002'] },
  ]);
  assert.deepStrictEqual(
    plan.skipped.map((row) => row.residentId),
    ['R-1', 'R-2', '']
  );
});

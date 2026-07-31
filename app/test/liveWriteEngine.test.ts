import test from 'node:test';
import assert from 'node:assert';
import {
  ensureHeaderColumns,
  planAppendRevert,
  planCellRevert,
  planGuardedAppends,
  planGuardedCellWrites,
  planGuardedDeletes,
  planGuardedMoves,
  planRowRestores,
  remapRowByHeaders,
} from '../src/lib/liveWriteEngine';

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

test('append revert deletes unchanged rows by identity in bottom-up order', () => {
  const target = [
    ['resident_id', 'Resident Name', 'Phone'],
    ['R-1', 'Existing Person', ''],
    ['R-2', 'First Append', '626-555-0002'],
    ['R-3', 'Second Append', ''],
  ];
  const plan = planAppendRevert(target, [
    { snapshotId: 10, residentId: 'R-2', row: ['R-2', 'First Append', '626-555-0002'] },
    { snapshotId: 11, residentId: 'R-3', row: ['R-3', 'Second Append', ''] },
  ]);

  assert.deepStrictEqual(
    plan.deletions.map((row) => ({ id: row.residentId, rowIndex: row.rowIndex })),
    [
      { id: 'R-3', rowIndex: 3 },
      { id: 'R-2', rowIndex: 2 },
    ]
  );
  assert.strictEqual(plan.conflicts.length, 0);
});

test('append revert preserves a row that changed after the live run', () => {
  const target = [
    ['resident_id', 'Resident Name', 'Phone'],
    ['R-2', 'Captain Edited Name', '626-555-0002'],
  ];
  const plan = planAppendRevert(target, [
    { snapshotId: 10, residentId: 'R-2', row: ['R-2', 'Original Name', '626-555-0002'] },
  ]);

  assert.strictEqual(plan.deletions.length, 0);
  assert.strictEqual(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].reason, /changed after this run/);
});

test('ensureHeaderColumns appends missing derived columns at the right', () => {
  const grid = [
    ['resident_id', 'Latitude', 'Longitude'],
    ['R-1', 5, 5],
  ];
  const result = ensureHeaderColumns(grid, ['ZoneName', 'NC Name', 'Latitude']);
  assert.deepStrictEqual(result.added, ['ZoneName', 'NC Name']);
  assert.deepStrictEqual(result.headers, ['resident_id', 'Latitude', 'Longitude', 'ZoneName', 'NC Name']);
  assert.deepStrictEqual(grid[0], ['resident_id', 'Latitude', 'Longitude', 'ZoneName', 'NC Name']);
});

test('cell revert restores unchanged cells and preserves edited ones', () => {
  const target = [
    ['resident_id', 'ZoneName', 'NC Name'],
    ['R-1', 'Zone A', 'Ada'],
    ['R-2', 'Zone B', 'Edited Later'],
    ['R-3', '', ''],
  ];
  const plan = planCellRevert(target, [
    {
      snapshotId: 1,
      residentId: 'R-1',
      column: 'ZoneName',
      rangeA1: 'Sheet1!B2',
      before: '',
      after: 'Zone A',
    },
    {
      snapshotId: 2,
      residentId: 'R-2',
      column: 'NC Name',
      rangeA1: 'Sheet1!C3',
      before: '',
      after: 'Ben',
    },
    {
      snapshotId: 3,
      residentId: 'R-3',
      column: 'ZoneName',
      rangeA1: 'Sheet1!B4',
      before: '',
      after: 'Zone C',
    },
  ]);

  assert.strictEqual(plan.restores.length, 1);
  assert.strictEqual(plan.restores[0].residentId, 'R-1');
  assert.strictEqual(plan.restores[0].before, '');
  assert.strictEqual(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].reason, /changed after this run/);
  assert.strictEqual(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /already matches its pre-run value/);
});

test('remapRowByHeaders joins by header name and leaves missing columns blank', () => {
  const remapped = remapRowByHeaders(
    ['resident_id', 'Phone', 'Extra'],
    ['R-1', '626-555-0101', 'keep-me'],
    ['resident_id', 'Resident Name', 'Phone']
  );
  assert.deepStrictEqual(remapped, ['R-1', '', '626-555-0101']);
});

test('guarded deletes locate unique identities and sort bottom-up', () => {
  const target = [
    ['resident_id', 'ZoneName'],
    ['R-1', 'Zone A'],
    ['R-2', 'Zone A'],
    ['R-3', 'Zone A'],
  ];
  const plan = planGuardedDeletes(target, ['R-2', 'R-3', 'R-missing']);
  assert.deepStrictEqual(
    plan.deletions.map((row) => ({ id: row.residentId, rowIndex: row.rowIndex })),
    [
      { id: 'R-3', rowIndex: 3 },
      { id: 'R-2', rowIndex: 2 },
    ]
  );
  assert.strictEqual(plan.skipped.length, 1);
  assert.strictEqual(plan.skipped[0].residentId, 'R-missing');
});

test('guarded moves append to destination with destination ZoneName and skip collisions', () => {
  const from = [
    ['resident_id', 'Resident Name', 'ZoneName', 'Phone'],
    ['R-keep', 'Stay', 'Zone A', ''],
    ['R-move', 'Mover', 'Zone A', '626-555-9999'],
  ];
  const to = [
    ['resident_id', 'ZoneName', 'Phone', 'Notes'],
    ['R-existing', 'Zone B', '', 'already here'],
  ];
  const plan = planGuardedMoves(from, to, ['R-move', 'R-existing', 'R-absent'], 'Zone B');
  assert.strictEqual(plan.moves.length, 1);
  assert.deepStrictEqual(plan.moves[0], {
    residentId: 'R-move',
    appendRow: ['R-move', 'Zone B', '626-555-9999', ''],
    sourceRow: ['R-move', 'Mover', 'Zone A', '626-555-9999'],
    sourceRowIndex: 2,
  });
  assert.deepStrictEqual(
    plan.skipped.map((row) => row.residentId),
    ['R-existing', 'R-absent']
  );
});

test('row restores re-append absent identities and conflict when values differ', () => {
  const target = [
    ['resident_id', 'Resident Name', 'ZoneName'],
    ['R-present', 'Same', 'Zone A'],
    ['R-edited', 'Changed', 'Zone A'],
  ];
  const plan = planRowRestores(target, [
    { snapshotId: 1, residentId: 'R-gone', row: ['R-gone', 'Restored', 'Zone A'] },
    { snapshotId: 2, residentId: 'R-present', row: ['R-present', 'Same', 'Zone A'] },
    { snapshotId: 3, residentId: 'R-edited', row: ['R-edited', 'Original', 'Zone A'] },
  ]);
  assert.strictEqual(plan.appends.length, 1);
  assert.strictEqual(plan.appends[0].residentId, 'R-gone');
  assert.strictEqual(plan.skipped.length, 1);
  assert.strictEqual(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0].reason, /different values/);
});

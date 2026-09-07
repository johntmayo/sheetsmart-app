import test from 'node:test';
import assert from 'node:assert';
import type { Grid } from '../src/lib/mergeEngine';
import {
  filterTombstonedRecords,
  fingerprintArchivedPayload,
  fingerprintDeletionRows,
  isAddressTombstoned,
  isResidentTombstoned,
  planAddressDeletion,
  planCurrentZoneRestoration,
  planPersonDeletion,
  shouldFilterTombstonedRecord,
  type DeletionSheet,
} from '../src/lib/deletionEngine';

function sheet(
  spreadsheetId: string,
  zone: string,
  grid: Grid,
  tabName = 'Residents'
): DeletionSheet {
  return { spreadsheetId, spreadsheetName: spreadsheetId, tabName, zone, grid };
}

const HEADERS = ['address_id', 'resident_id', 'Resident Name', 'Street', 'record_kind'];

test('person deletion creates an explicit deterministic placeholder for the last real person', () => {
  const source = sheet('S1', 'North', [
    HEADERS,
    ['A1', 'R1', 'Ada Lovelace', 'Oak St', 'person'],
  ]);

  const first = planPersonDeletion([source], 'R1', {
    placeholderMarkerColumn: 'record_kind',
  });
  const second = planPersonDeletion([source], 'R1', {
    placeholderMarkerColumn: 'record_kind',
  });

  assert.deepStrictEqual(first.blocked, []);
  assert.strictEqual(first.deletions.length, 1);
  assert.strictEqual(first.archives.length, 1);
  assert.deepStrictEqual(first.archives[0].row, source.grid[1]);
  assert.strictEqual(first.placeholders.length, 1);
  assert.strictEqual(first.placeholders[0].kind, 'address_placeholder');
  assert.strictEqual(first.placeholders[0].addressId, 'A1');
  assert.match(String(first.placeholders[0].row[1]), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.strictEqual(first.placeholders[0].row[4], '__SHEETSMART_ADDRESS_PLACEHOLDER__');
  assert.strictEqual(first.placeholders[0].marker, '__SHEETSMART_ADDRESS_PLACEHOLDER__');
  assert.deepStrictEqual(first.placeholders, second.placeholders);
  assert.deepStrictEqual(first.tombstones, [{ kind: 'resident', id: 'R1' }]);
});

test('an unnamed UUID row is a placeholder until a person name is supplied', () => {
  const residentId = '91b6c1a3-d607-494f-94a2-3773f57285a1';
  const unnamed = sheet('S1', 'North', [
    HEADERS,
    ['A1', residentId, '', 'Oak St', ''],
  ]);
  const placeholderPlan = planPersonDeletion([unnamed], residentId);
  assert.strictEqual(placeholderPlan.deletions.length, 0);
  assert.ok(placeholderPlan.blocked.some((item) => item.code === 'not_found'));

  const named = sheet('S1', 'North', [
    HEADERS,
    ['A1', residentId, 'Ada Lovelace', 'Oak St', ''],
  ]);
  const personPlan = planPersonDeletion([named], residentId);
  assert.strictEqual(personPlan.deletions.length, 1);
  assert.strictEqual(personPlan.placeholders.length, 1);

  const unnamedLegacyId = sheet('S1', 'North', [
    HEADERS,
    ['A1', 'R-LEGACY', '', 'Oak St', ''],
  ]);
  assert.strictEqual(planPersonDeletion([unnamedLegacyId], 'R-LEGACY').deletions.length, 1);
});

test('archive payload fingerprints ignore the reversible deletion marker', () => {
  assert.strictEqual(
    fingerprintArchivedPayload({ resident_id: 'R1', Name: 'Ada', 'Deleted Record': '' }),
    fingerprintArchivedPayload({ resident_id: 'R1', Name: 'Ada', 'Deleted Record': 'op-1' })
  );
});

test('person deletion blocks when another row at the address has no resident identity', () => {
  const source = sheet('S1', 'North', [
    HEADERS,
    ['A1', 'R1', 'Ada Lovelace', 'Oak St', 'person'],
    ['A1', '', 'Unknown resident', 'Oak St', 'person'],
  ]);
  const plan = planPersonDeletion([source], 'R1');
  assert.ok(plan.blocked.some((item) => item.code === 'missing_identity'));
  assert.strictEqual(plan.deletions.length, 0);
  assert.strictEqual(plan.placeholders.length, 0);
});

test('person deletion keeps an inhabited address and returns matches from every sheet', () => {
  const master = sheet('MASTER', 'North', [
    HEADERS,
    ['A1', 'R1', 'Ada Lovelace', 'Oak St', 'person'],
    ['A1', 'R2', 'Charles Babbage', 'Oak St', 'person'],
  ]);
  const captain = sheet('CAPTAIN', 'North', [
    HEADERS,
    ['A1', 'R1', 'Ada Lovelace', 'Oak St', 'person'],
    ['A1', 'R2', 'Charles Babbage', 'Oak St', 'person'],
  ]);

  const plan = planPersonDeletion([master, captain], 'R1');

  assert.deepStrictEqual(plan.blocked, []);
  assert.deepStrictEqual(
    plan.deletions.map((entry) => entry.spreadsheetId),
    ['CAPTAIN', 'MASTER']
  );
  assert.strictEqual(plan.placeholders.length, 0);
});

test('whole-address deletion archives every row and is all-or-nothing', () => {
  const source = sheet('S1', 'North', [
    HEADERS,
    ['A1', 'R1', 'Ada Lovelace', 'Oak St', 'person'],
    ['A1', 'R2', 'Charles Babbage', 'Oak St', 'person'],
    ['A2', 'R3', 'Grace Hopper', 'Elm St', 'person'],
  ]);

  const plan = planAddressDeletion([source], 'A1');
  assert.deepStrictEqual(plan.blocked, []);
  assert.deepStrictEqual(plan.archives.map((entry) => entry.residentId), ['R1', 'R2']);
  assert.strictEqual(plan.placeholders.length, 0);
  assert.deepStrictEqual(plan.tombstones, [
    { kind: 'address', id: 'A1' },
    { kind: 'resident', id: 'R1' },
    { kind: 'resident', id: 'R2' },
  ]);

  const ambiguous = sheet('S2', 'South', [
    HEADERS,
    ['A9', 'R2', 'Charles Babbage', 'Other St', 'person'],
  ]);
  const blocked = planAddressDeletion([source, ambiguous], 'A1');
  assert.ok(blocked.blocked.some((entry) => entry.code === 'ambiguous_identity'));
  assert.deepStrictEqual(blocked.deletions, []);
  assert.deepStrictEqual(blocked.archives, []);
  assert.deepStrictEqual(blocked.tombstones, []);
});

test('duplicate and ambiguous resident identities block person deletion', () => {
  const duplicated = sheet('S1', 'North', [
    HEADERS,
    ['A1', 'R1', 'Ada', 'Oak St', 'person'],
    ['A1', 'R1', 'Ada duplicate', 'Oak St', 'person'],
  ]);
  const duplicatePlan = planPersonDeletion([duplicated], 'R1');
  assert.ok(duplicatePlan.blocked.some((entry) => entry.code === 'duplicate_identity'));
  assert.deepStrictEqual(duplicatePlan.deletions, []);

  const moved = sheet('S2', 'South', [
    HEADERS,
    ['A2', 'R1', 'Ada', 'Elm St', 'person'],
  ]);
  const ambiguousPlan = planPersonDeletion(
    [
      sheet('S1', 'North', [HEADERS, ['A1', 'R1', 'Ada', 'Oak St', 'person']]),
      moved,
    ],
    'R1'
  );
  assert.ok(ambiguousPlan.blocked.some((entry) => entry.code === 'ambiguous_identity'));
  assert.deepStrictEqual(ambiguousPlan.deletions, []);
});

test('deletion fingerprints are stable, order-independent, and row-change-sensitive', () => {
  const source = sheet('S1', 'North', [
    HEADERS,
    ['A1', 'R1', 'Ada', 'Oak St', 'person'],
    ['A1', 'R2', 'Charles', 'Oak St', 'person'],
  ]);
  const base = planAddressDeletion([source], 'A1');
  const same = planAddressDeletion([source], 'A1');
  assert.strictEqual(base.fingerprint, same.fingerprint);
  assert.strictEqual(
    fingerprintDeletionRows([...base.archives].reverse()),
    fingerprintDeletionRows(base.archives)
  );

  const changedGrid = source.grid.map((row) => [...row]);
  changedGrid[1][2] = 'Ada Byron';
  const changed = planAddressDeletion([{ ...source, grid: changedGrid }], 'A1');
  assert.notStrictEqual(base.fingerprint, changed.fingerprint);
  assert.notStrictEqual(base.archives[0].fingerprint, changed.archives[0].fingerprint);
});

test('restoration consumes archives and remaps them for the current-zone sheet', () => {
  const oldSheet = sheet('OLD', 'Old Zone', [
    HEADERS,
    ['A1', 'R1', 'Ada', 'Oak St', 'person'],
  ]);
  const deletion = planPersonDeletion([oldSheet], 'R1');
  const current = sheet('CURRENT', 'Current Zone', [
    ['resident_id', 'address_id', 'Street', 'Resident Name', 'New Column'],
  ]);

  const restore = planCurrentZoneRestoration(deletion.archives, current);
  assert.deepStrictEqual(restore.blocked, []);
  assert.strictEqual(restore.appends.length, 1);
  assert.deepStrictEqual(restore.appends[0].row, ['R1', 'A1', 'Oak St', 'Ada', '']);
  assert.strictEqual(restore.appends[0].sourceArchiveFingerprint, deletion.archives[0].fingerprint);

  const duplicateTarget = {
    ...current,
    grid: [
      current.grid[0],
      ['R1', 'A1', 'Oak St', 'Ada', ''],
    ],
  };
  const blocked = planCurrentZoneRestoration(deletion.archives, duplicateTarget);
  assert.ok(blocked.blocked.some((entry) => entry.code === 'duplicate_identity'));
  assert.deepStrictEqual(blocked.appends, []);
});

test('tombstone helpers prevent resident and whole-address re-appends', () => {
  const tombstones = [
    { kind: 'resident' as const, id: 'R1' },
    { kind: 'address' as const, id: 'A9' },
  ];
  assert.strictEqual(isResidentTombstoned('R1', tombstones), true);
  assert.strictEqual(isAddressTombstoned('A9', tombstones), true);
  assert.strictEqual(
    shouldFilterTombstonedRecord({ residentId: 'R2', addressId: 'A9' }, tombstones),
    true
  );
  assert.deepStrictEqual(
    filterTombstonedRecords(
      [
        { residentId: 'R1', addressId: 'A1' },
        { residentId: 'R2', addressId: 'A9' },
        { residentId: 'R3', addressId: 'A3' },
      ],
      tombstones
    ),
    [{ residentId: 'R3', addressId: 'A3' }]
  );
});

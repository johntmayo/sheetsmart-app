import test from 'node:test';
import assert from 'node:assert';
import { planPullToMaster, planPullNewResidents, fingerprintPullChanges } from '../src/lib/pullEngine';
import type { Grid } from '../src/lib/mergeEngine';

const MASTER: Grid = [
  ['resident_id', 'Resident Name', 'Phone', 'Damage', 'Notes'],
  ['R1', 'Ada Lovelace', '', 'Minor', 'master note'],
  ['R2', 'Alan Turing', '555-0002', '', ''],
];

const CAPTAIN: Grid = [
  ['resident_id', 'Resident Name', 'Phone', 'Damage', 'Notes'],
  ['R1', 'Ada Lovelace', '555-0001', 'Total loss', 'captain note'],
  ['R2', 'Alan Turing', '555-0002', 'None', ''],
];

const POLICIES = { Phone: 'fill_blank', Damage: 'fill_blank', Notes: 'conflict' };

test('planPullToMaster: fills blanks and logs disagreements as conflicts', () => {
  const plan = planPullToMaster(MASTER, CAPTAIN, { policies: POLICIES });

  assert.deepStrictEqual(plan.errors, []);
  assert.deepStrictEqual(plan.columnsCompared, ['Resident Name', 'Phone', 'Damage', 'Notes']);

  const filled = plan.fills.map((f) => `${f.residentId}.${f.column}`).sort();
  assert.deepStrictEqual(filled, ['R1.Phone', 'R2.Damage']);
  assert.strictEqual(plan.fills.find((f) => f.residentId === 'R1')?.masterRow, 2);
  assert.strictEqual(plan.fills.find((f) => f.residentId === 'R1')?.masterCol, 3);

  const conflicts = plan.conflicts.map((c) => `${c.residentId}.${c.column}`).sort();
  assert.deepStrictEqual(conflicts, ['R1.Damage', 'R1.Notes']);
  assert.strictEqual(plan.overwrites.length, 0);
});

test('planPullToMaster: overwrite policy replaces a non-blank master value', () => {
  const plan = planPullToMaster(MASTER, CAPTAIN, {
    policies: { ...POLICIES, Damage: 'overwrite' },
  });

  const overwritten = plan.overwrites.map((o) => `${o.residentId}.${o.column}`);
  assert.deepStrictEqual(overwritten, ['R1.Damage']);
  assert.strictEqual(plan.overwrites[0].masterValue, 'Minor');
  assert.strictEqual(plan.overwrites[0].captainValue, 'Total loss');
  // R2's blank Damage is still a fill, not an overwrite.
  assert.ok(plan.fills.some((f) => f.residentId === 'R2' && f.column === 'Damage'));
});

test('planPullToMaster: never writes resident_id and honors a never policy', () => {
  const captain: Grid = [
    ['resident_id', 'Phone'],
    ['R1', '555-0001'],
  ];
  const master: Grid = [
    ['resident_id', 'Phone'],
    ['R1', ''],
  ];

  const plan = planPullToMaster(master, captain, { policies: { Phone: 'never' } });
  assert.strictEqual(plan.fills.length, 0);
  assert.strictEqual(plan.overwrites.length, 0);
  assert.deepStrictEqual(
    plan.skipped.map((s) => s.column),
    ['Phone']
  );
  assert.ok(!plan.columnsCompared.includes('resident_id'));
});

test('planPullToMaster: a blank captain value never erases a master value', () => {
  const captain: Grid = [
    ['resident_id', 'Phone'],
    ['R2', ''],
  ];
  const plan = planPullToMaster(MASTER, captain, { policies: { Phone: 'overwrite' } });
  assert.strictEqual(plan.fills.length, 0);
  assert.strictEqual(plan.overwrites.length, 0);
  assert.strictEqual(plan.conflicts.length, 0);
});

test('planPullToMaster: residents missing from the master are reported, never appended', () => {
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'Phone'],
    ['R9', 'New Person', '555-9999'],
  ];
  const plan = planPullToMaster(MASTER, captain, { policies: { Phone: 'fill_blank' } });

  assert.strictEqual(plan.fills.length, 0);
  assert.deepStrictEqual(plan.unmatchedResidents, [
    { residentId: 'R9', residentName: 'New Person', captainRow: 2 },
  ]);
});

test('planPullToMaster: duplicate ids are skipped on both sides', () => {
  const master: Grid = [
    ['resident_id', 'Phone'],
    ['R1', ''],
    ['R1', ''],
  ];
  const captain: Grid = [
    ['resident_id', 'Phone'],
    ['R1', '555-0001'],
    ['R1', '555-0002'],
  ];

  const plan = planPullToMaster(master, captain, { policies: { Phone: 'fill_blank' } });
  assert.strictEqual(plan.fills.length, 0);
  assert.strictEqual(plan.skipped.length, 2);
  assert.ok(plan.skipped.every((s) => s.reason.includes('more than once')));
});

test('planPullToMaster: restricting columns limits what is compared', () => {
  const plan = planPullToMaster(MASTER, CAPTAIN, { policies: POLICIES, columns: ['Phone'] });
  assert.deepStrictEqual(plan.columnsCompared, ['Phone']);
  assert.strictEqual(plan.conflicts.length, 0);
  assert.deepStrictEqual(
    plan.fills.map((f) => f.column),
    ['Phone']
  );
});

test('planPullToMaster: unlisted columns default to conflict, never a silent write', () => {
  const plan = planPullToMaster(MASTER, CAPTAIN, {});
  assert.strictEqual(plan.fills.length, 0);
  assert.strictEqual(plan.overwrites.length, 0);
  assert.deepStrictEqual(
    plan.conflicts.map((c) => `${c.residentId}.${c.column}`).sort(),
    ['R1.Damage', 'R1.Notes', 'R1.Phone', 'R2.Damage']
  );
});

test('planPullToMaster: missing identity column is a hard error', () => {
  const plan = planPullToMaster([['Phone'], ['x']], CAPTAIN, {});
  assert.strictEqual(plan.fills.length, 0);
  assert.ok(plan.errors[0].includes('resident_id'));
});

// ---- Captain-created residents ----

// Two people share APN 100 on the master, which is normal: several residents
// live at one address.
const NEW_MASTER: Grid = [
  ['resident_id', 'Resident Name', 'APN', 'House', 'Street', 'Email'],
  ['M1', 'Ada Lovelace', '100', '10', 'Oak St', 'ada@example.com'],
  ['M2', 'Charles Babbage', '100', '10', 'Oak St', 'charles@example.com'],
  ['M3', 'Grace Hopper', '200', '20', 'Elm St', ''],
];

test('planPullNewResidents: proposes a genuinely new person and maps to master headers', () => {
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'APN', 'House', 'Street', 'Email', 'Captain Notes'],
    ['M1', 'Ada Lovelace', '100', '10', 'Oak St', 'ada@example.com', 'known'],
    ['C9', 'Alan Turing', '300', '30', 'Pine St', 'alan@example.com', 'new person'],
  ];

  const plan = planPullNewResidents(NEW_MASTER, captain);
  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.candidates.length, 1);

  const candidate = plan.candidates[0];
  assert.strictEqual(candidate.residentId, 'C9');
  assert.strictEqual(candidate.risk, 'none');
  assert.strictEqual(candidate.captainRow, 3);
  assert.strictEqual(candidate.property, '30 Pine St · APN 300');
  // Ordered to the master's headers, and the captain-only column is dropped.
  assert.deepStrictEqual(candidate.row, ['C9', 'Alan Turing', '300', '30', 'Pine St', 'alan@example.com']);
  assert.deepStrictEqual(plan.columnsOnlyOnCaptain, ['Captain Notes']);
});

test('planPullNewResidents: a shared APN alone is never a duplicate signal', () => {
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'APN', 'House', 'Street', 'Email'],
    // A third resident at the same address as M1 and M2 — normal.
    ['C10', 'Betty Holberton', '100', '10', 'Oak St', 'betty@example.com'],
  ];

  const plan = planPullNewResidents(NEW_MASTER, captain);
  assert.strictEqual(plan.candidates.length, 1);
  assert.strictEqual(plan.candidates[0].risk, 'none');
  assert.strictEqual(plan.candidates[0].riskReason, '');
});

test('planPullNewResidents: same name at the same parcel is a likely duplicate', () => {
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'APN', 'House', 'Street', 'Email'],
    // Same person as M1, re-keyed, with the street spelled differently.
    ['C11', 'Ada Lovelace', '100', '10', 'Oak Street', ''],
  ];

  const plan = planPullNewResidents(NEW_MASTER, captain);
  assert.strictEqual(plan.candidates[0].risk, 'likely');
  assert.strictEqual(plan.candidates[0].matchedResidentId, 'M1');
  assert.match(plan.candidates[0].riskReason, /same parcel/i);
});

test('planPullNewResidents: a re-used email is a likely duplicate even at a new address', () => {
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'APN', 'House', 'Street', 'Email'],
    ['C12', 'G. Hopper', '999', '99', 'Cedar St', 'CHARLES@example.com'],
  ];

  const plan = planPullNewResidents(NEW_MASTER, captain);
  assert.strictEqual(plan.candidates[0].risk, 'likely');
  assert.strictEqual(plan.candidates[0].matchedResidentId, 'M2');
  assert.match(plan.candidates[0].riskReason, /email/i);
});

test('planPullNewResidents: same name at a different parcel is only a possible duplicate', () => {
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'APN', 'House', 'Street', 'Email'],
    ['C13', 'Grace Hopper', '400', '40', 'Birch St', ''],
  ];

  const plan = planPullNewResidents(NEW_MASTER, captain);
  assert.strictEqual(plan.candidates[0].risk, 'possible');
  assert.strictEqual(plan.candidates[0].matchedResidentId, 'M3');
  assert.match(plan.candidates[0].riskReason, /different parcel/i);
});

test('planPullNewResidents: flags a person appearing twice within the same batch', () => {
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'APN', 'House', 'Street', 'Email'],
    ['C14', 'Rex Mayreis', '500', '50', 'Fir St', ''],
    ['C15', 'Rex Mayreis', '500', '50', 'Fir St', ''],
  ];

  const plan = planPullNewResidents(NEW_MASTER, captain);
  assert.strictEqual(plan.candidates.length, 2);
  assert.strictEqual(plan.candidates[0].risk, 'none');
  assert.strictEqual(plan.candidates[1].risk, 'likely');
  assert.strictEqual(plan.candidates[1].matchedResidentId, 'C14');
  assert.match(plan.candidates[1].riskReason, /same batch/i);
});

test('planPullNewResidents: rows without a resident_id are reported, never appended', () => {
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'APN'],
    ['', 'No Identity', '600'],
    ['', '', ''],
  ];

  const plan = planPullNewResidents(NEW_MASTER, captain);
  assert.strictEqual(plan.candidates.length, 0);
  assert.strictEqual(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /no resident_id/i);
});

test('planPullNewResidents: a missing required column is reported on the candidate', () => {
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'APN'],
    ['C16', '', '700'],
  ];

  const plan = planPullNewResidents(NEW_MASTER, captain);
  assert.deepStrictEqual(plan.candidates[0].missingRequired, ['Resident Name']);
});

test('planPullNewResidents: fingerprint changes when a candidate row changes', () => {
  const captain: Grid = [
    ['resident_id', 'Resident Name', 'APN', 'House', 'Street', 'Email'],
    ['C17', 'Alan Turing', '300', '30', 'Pine St', ''],
  ];
  const base = planPullNewResidents(NEW_MASTER, captain);

  const edited = captain.map((row) => [...row]);
  edited[1][1] = 'Alan M Turing';
  const changed = planPullNewResidents(NEW_MASTER, edited);
  assert.notStrictEqual(base.fingerprint, changed.fingerprint);
});

test('fingerprintPullChanges: stable for the plan, sensitive to captain edits', () => {
  const base = planPullToMaster(MASTER, CAPTAIN, { policies: POLICIES });
  const same = planPullToMaster(MASTER, CAPTAIN, { policies: POLICIES });
  assert.strictEqual(base.fingerprint, same.fingerprint);

  const editedCaptain = CAPTAIN.map((row) => [...row]);
  editedCaptain[1][2] = '555-CHANGED';
  const changed = planPullToMaster(MASTER, editedCaptain, { policies: POLICIES });
  assert.notStrictEqual(base.fingerprint, changed.fingerprint);
  assert.strictEqual(fingerprintPullChanges([]), fingerprintPullChanges([]));
});

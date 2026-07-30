import test from 'node:test';
import assert from 'node:assert';
import { decideAppendCell, decideWrite, normalizePolicy } from '../src/lib/writeGuard';

test('normalizePolicy maps synonyms to canonical labels', () => {
  assert.strictEqual(normalizePolicy('Fill Blank'), 'fill_blank');
  assert.strictEqual(normalizePolicy('fill-blanks'), 'fill_blank');
  assert.strictEqual(normalizePolicy('Replace'), 'overwrite');
  assert.strictEqual(normalizePolicy('log only'), 'conflict');
  assert.strictEqual(normalizePolicy('skip'), 'never');
  assert.strictEqual(normalizePolicy('gibberish'), '');
});

test('a blank source never overwrites a target value (rule 3)', () => {
  for (const src of ['', null, undefined]) {
    const d = decideWrite({ column: 'X', target: 'keep me', source: src, policy: 'overwrite' });
    assert.strictEqual(d.willWrite, false);
    assert.strictEqual(d.action, 'skip');
  }
});

test('fill_blank fills only blank targets, else logs a conflict', () => {
  const fill = decideWrite({ column: 'X', target: '', source: 'new', policy: 'fill_blank' });
  assert.strictEqual(fill.action, 'fill');
  assert.strictEqual(fill.willWrite, true);

  const conflict = decideWrite({ column: 'X', target: 'old', source: 'new', policy: 'fill_blank' });
  assert.strictEqual(conflict.action, 'conflict');
  assert.strictEqual(conflict.willWrite, false);
});

test('only overwrite policy replaces a non-blank value (rule 7)', () => {
  const ow = decideWrite({ column: 'X', target: 'old', source: 'new', policy: 'overwrite' });
  assert.strictEqual(ow.action, 'overwrite');
  assert.strictEqual(ow.willWrite, true);

  // overwrite into a blank target is reported as a fill, and still writes.
  const fill = decideWrite({ column: 'X', target: '', source: 'new', policy: 'overwrite' });
  assert.strictEqual(fill.action, 'fill');
  assert.strictEqual(fill.willWrite, true);
});

test('conflict policy never writes, even into a blank target', () => {
  const d = decideWrite({ column: 'X', target: '', source: 'new', policy: 'conflict' });
  assert.strictEqual(d.action, 'conflict');
  assert.strictEqual(d.willWrite, false);
});

test('resident_id is always protected regardless of policy (rule 5)', () => {
  const d = decideWrite({ column: 'resident_id', target: '', source: 'R-999', policy: 'overwrite' });
  assert.strictEqual(d.willWrite, false);
  assert.strictEqual(d.effectivePolicy, 'never');
});

test('a new row may be created with resident_id, but a blank identity is rejected', () => {
  const identity = decideAppendCell({ column: 'resident_id', source: 'R-999' });
  assert.strictEqual(identity.action, 'fill');
  assert.strictEqual(identity.willWrite, true);

  const blankIdentity = decideAppendCell({ column: 'resident_id', source: '' });
  assert.strictEqual(blankIdentity.action, 'skip');
  assert.strictEqual(blankIdentity.willWrite, false);
});

test('unlisted columns default to conflict-only', () => {
  const d = decideWrite({ column: 'X', target: 'old', source: 'new' }); // no policy
  assert.strictEqual(d.effectivePolicy, 'conflict');
  assert.strictEqual(d.willWrite, false);
});

test('equal values are a no-op (checkbox false vs blank)', () => {
  assert.strictEqual(decideWrite({ column: 'X', target: 5, source: '5', policy: 'overwrite' }).action, 'equal');
  assert.strictEqual(decideWrite({ column: 'X', target: false, source: '', policy: 'overwrite' }).action, 'skip'); // blank source
  assert.strictEqual(decideWrite({ column: 'X', target: '1/2/2024', source: '2024-01-02', policy: 'overwrite' }).action, 'equal');
});

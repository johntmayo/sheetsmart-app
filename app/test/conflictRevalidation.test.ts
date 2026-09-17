import test from 'node:test';
import assert from 'node:assert';
import { classifyConflictFreshness } from '../src/lib/conflictRevalidation';

test('historical equivalent typed values auto-resolve without deleting history', () => {
  assert.strictEqual(
    classifyConflictFreshness({
      originalMaster: 'false',
      originalCaptain: 'false',
      currentMaster: false,
      currentCaptain: 'FALSE',
      fieldMeta: { dataType: 'checkbox' },
    }),
    'equivalent'
  );
});

test('changed historical conflicts are held stale', () => {
  assert.strictEqual(
    classifyConflictFreshness({
      originalMaster: 'old master',
      originalCaptain: 'old captain',
      currentMaster: 'edited master',
      currentCaptain: 'old captain',
      fieldMeta: { dataType: 'text' },
    }),
    'stale'
  );
});

test('genuine current date disagreement stays open', () => {
  assert.strictEqual(
    classifyConflictFreshness({
      originalMaster: 46213,
      originalCaptain: '7/8/2026',
      currentMaster: 46213,
      currentCaptain: '7/8/2026',
      fieldMeta: { dataType: 'date' },
    }),
    'current'
  );
});

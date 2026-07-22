import test from 'node:test';
import assert from 'node:assert';
import { normalizeKey, findColumn, resolveColumn, detectSheetZone, columnLetter } from '../src/lib/columns';

test('normalizeKey lowercases and strips non-alphanumerics', () => {
  assert.strictEqual(normalizeKey('House #'), 'house');
  assert.strictEqual(normalizeKey('_SitusHouseNo'), 'situshouseno');
  assert.strictEqual(normalizeKey('resident_id'), 'residentid');
  assert.strictEqual(normalizeKey('  APN  '), 'apn');
});

test('findColumn resolves known aliases to the real header', () => {
  const headers = ['Resident Name', 'residentid', 'Last Outreach Attempt Date'];
  assert.strictEqual(findColumn(headers, ['resident_id', 'residentid']), 'residentid');
});

test('findColumn falls back to a matcher when no alias matches', () => {
  const headers = ['House #', 'Street', 'Last Contact Date'];
  const match = findColumn(headers, ['resident_id'], (l) => l.includes('contact') && l.includes('date'));
  assert.strictEqual(match, 'Last Contact Date');
});

test('findColumn returns null when nothing matches (reported, not guessed)', () => {
  const headers = ['A', 'B', 'C'];
  assert.strictEqual(findColumn(headers, ['resident_id'], (l) => l.includes('zzz')), null);
});

test('resolveColumn reports match details for the audit', () => {
  const headers = ['APN', 'Damage'];
  const r = resolveColumn(headers, ['apn']);
  assert.deepStrictEqual(r, { matched: true, header: 'APN', index: 0 });
  const miss = resolveColumn(headers, ['does_not_exist']);
  assert.strictEqual(miss.matched, false);
  assert.strictEqual(miss.index, -1);
});

test('detectSheetZone returns the mode of ZoneName, robust to stray rows', () => {
  const headers = ['resident_id', 'ZoneName'];
  const rows = [
    ['1', 'Zone A'],
    ['2', 'Zone A'],
    ['3', 'Zone B'], // one stray row from a prior assignment
    ['4', 'Zone A'],
    ['5', ''],
  ];
  assert.strictEqual(detectSheetZone(headers, rows), 'Zone A');
});

test('detectSheetZone returns empty when no ZoneName column exists', () => {
  assert.strictEqual(detectSheetZone(['a', 'b'], [[1, 2]]), '');
});

test('columnLetter matches spreadsheet lettering', () => {
  assert.strictEqual(columnLetter(0), 'A');
  assert.strictEqual(columnLetter(25), 'Z');
  assert.strictEqual(columnLetter(26), 'AA');
  assert.strictEqual(columnLetter(51), 'AZ');
});

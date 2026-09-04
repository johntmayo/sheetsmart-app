import test from 'node:test';
import assert from 'node:assert';
import {
  cellValuesEqual,
  displayCellValue,
  isSuspectedTextCoercion,
  isTargetCellBlank,
  normalizeForCompare,
  valueForTypedWrite,
  type FieldCompareMeta,
} from '../src/lib/values';

const date: FieldCompareMeta = { dataType: 'date' };
const checkbox: FieldCompareMeta = { dataType: 'checkbox' };
const text: FieldCompareMeta = { dataType: 'text' };
const textSafe: FieldCompareMeta = { dataType: 'text', isTextSafe: true };

test('declared dates compare Google serials to calendar text in UTC', () => {
  assert.strictEqual(cellValuesEqual(46211, '7/8/2026', date), true);
  assert.strictEqual(cellValuesEqual(46213, '7/8/2026', date), false);
  assert.strictEqual(displayCellValue(46211, date), '2026-07-08');
});

test('date conversion never applies outside declared date fields', () => {
  assert.strictEqual(cellValuesEqual(46211, '7/8/2026', text), false);
  assert.strictEqual(normalizeForCompare('1/2', textSafe), 'string:1/2');
});

test('checkbox booleans, text booleans, and blank use binary semantics', () => {
  assert.strictEqual(cellValuesEqual(false, 'false', checkbox), true);
  assert.strictEqual(cellValuesEqual('', false, checkbox), true);
  assert.strictEqual(cellValuesEqual(undefined, 'FALSE', checkbox), true);
  assert.strictEqual(cellValuesEqual('', true, checkbox), false);
  assert.strictEqual(valueForTypedWrite('TRUE', checkbox), true);
  assert.strictEqual(valueForTypedWrite('false', checkbox), false);
});

test('false is never globally blank and ordinary boolean-looking text stays text', () => {
  assert.strictEqual(isTargetCellBlank(false), false);
  assert.strictEqual(normalizeForCompare('false', text), 'string:false');
  assert.strictEqual(normalizeForCompare(true, text), 'raw-boolean:true');
  assert.strictEqual(cellValuesEqual(false, 'false', text), false);
  assert.strictEqual(valueForTypedWrite('false', text), 'false');
});

test('text-safe identifiers preserve text and flag numeric raw values', () => {
  assert.strictEqual(cellValuesEqual('02134', '02134', textSafe), true);
  assert.strictEqual(cellValuesEqual('02134', 2134, textSafe), false);
  assert.strictEqual(cellValuesEqual('1/2', '1/2', textSafe), true);
  assert.strictEqual(isSuspectedTextCoercion(46211, textSafe), true);
  assert.strictEqual(isSuspectedTextCoercion('46211', textSafe), false);
});

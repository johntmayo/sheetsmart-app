import test from 'node:test';
import assert from 'node:assert';
import {
  BOOLEAN_COLUMNS,
  RETIRED_SALES_COLUMNS,
  cleanupInputFingerprint,
  planFolderCleanup,
  type CleanupCell,
  type CleanupSheet,
} from '../src/lib/folderCleanupEngine';

const cell = (value: unknown, extra: Partial<CleanupCell> = {}): CleanupCell => ({
  userEnteredValue: value as CleanupCell['userEnteredValue'],
  effectiveValue: value as CleanupCell['effectiveValue'],
  formattedValue: value == null ? '' : String(value),
  ...extra,
});

function sheet(
  role: 'master' | 'captain',
  headers: string[],
  rows: unknown[][],
  extra: Partial<CleanupSheet> = {}
): CleanupSheet {
  return {
    spreadsheetId: role,
    spreadsheetName: role,
    tabName: 'Data',
    sheetId: role === 'master' ? 1 : 2,
    rowCount: rows.length + 1,
    columnCount: headers.length,
    cells: [headers.map((value) => cell(value)), ...rows.map((row) => row.map((value) => cell(value)))],
    ...extra,
  };
}

const baseHeaders = [
  'address_id',
  '_SitusHouseNo',
  '_SitusStreet',
  '_SitusUnit',
  'House',
  'Street',
  ...BOOLEAN_COLUMNS,
];

test('plans exact legacy deletion, captain-only sales deletion, booleans, units, and text format', () => {
  const master = sheet('master', baseHeaders, [
    ['a1', '10', 'Oak', '2B', '10', 'Oak', true, false, '', 'true', 'false', false, true],
  ]);
  const captain = sheet('captain', [...baseHeaders, ...RETIRED_SALES_COLUMNS], [
    ['a1', '10', 'Oak', 'wrong', '10', 'Oak', 'true', '', 'false', true, false, false, false, 1, 2, 3, 4, 5, 6, 7],
  ]);
  const plan = planFolderCleanup(master, [captain]);

  assert.strictEqual(plan.canApply, true);
  assert.deepStrictEqual(plan.sheets[0].deleteColumns.map((item) => item.header).sort(), ['House', 'Street']);
  assert.deepStrictEqual(
    plan.sheets[1].deleteColumns.map((item) => item.header).sort(),
    ['House', 'Street', ...RETIRED_SALES_COLUMNS].sort()
  );
  assert.strictEqual(plan.sheets[1].unitChanges[0].afterValue, '2B');
  assert.ok(plan.sheets[1].booleanChanges.every((change) => typeof change.afterValue === 'boolean'));
  assert.notStrictEqual(plan.sheets[0].formatUnitColumn, null);
});

test('blocks House and Street deletion until every populated row has canonical address parts', () => {
  const master = sheet('master', baseHeaders, [
    ['a1', '', 'Oak', '', '10', 'Oak', false, false, false, false, false, false, false],
  ]);
  const plan = planFolderCleanup(master, []);
  assert.strictEqual(plan.canApply, false);
  assert.ok(plan.sheets[0].blocks.some((block) => block.code === 'blank_canonical_address' && block.row === 2));
});

test('blocks formula, date-coerced, numeric, and ambiguous master unit authority', () => {
  const master = sheet('master', baseHeaders, [
    ['a1', '10', 'Oak', '2B', '10', 'Oak', false, false, false, false, false, false, false],
    ['a1', '10', 'Oak', '3C', '10', 'Oak', false, false, false, false, false, false, false],
    ['a2', '11', 'Oak', 44927, '11', 'Oak', false, false, false, false, false, false, false],
    ['a3', '12', 'Oak', { formulaValue: '="4D"' }, '12', 'Oak', false, false, false, false, false, false, false],
  ]);
  master.cells[3][3].numberFormat = { type: 'DATE', pattern: 'm/d/yyyy' };
  const captain = sheet('captain', baseHeaders, [
    ['a1', '10', 'Oak', 'x', '10', 'Oak', false, false, false, false, false, false, false],
    ['a2', '11', 'Oak', 'x', '11', 'Oak', false, false, false, false, false, false, false],
    ['a3', '12', 'Oak', 'x', '12', 'Oak', false, false, false, false, false, false, false],
  ]);
  const plan = planFolderCleanup(master, [captain]);
  assert.strictEqual(plan.canApply, false);
  assert.ok(plan.sheets.flatMap((item) => item.blocks).some((block) => /different/.test(block.message)));
  assert.ok(plan.sheets.flatMap((item) => item.blocks).some((block) => /date\/time/.test(block.message)));
  assert.ok(plan.sheets.flatMap((item) => item.blocks).some((block) => /formula/i.test(block.message)));
});

test('materializes a numeric master unit as its displayed text before applying TEXT format', () => {
  const master = sheet('master', baseHeaders, [
    ['a1', '10', 'Oak', 2, '10', 'Oak', false, false, false, false, false, false, false],
  ]);
  master.cells[1][3].formattedValue = '02';
  master.cells[1][3].numberFormat = { type: 'NUMBER', pattern: '00' };

  const plan = planFolderCleanup(master, []);

  assert.strictEqual(plan.sheets[0].unitChanges[0].afterValue, '02');
});

test('cleanup fingerprint detects eligibility changes in unrelated columns', () => {
  const value = sheet('master', [...baseHeaders, 'Unrelated'], [
    ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ]);
  const before = cleanupInputFingerprint(value);
  value.cells[1][baseHeaders.length].userEnteredValue = 'now populated';

  assert.notStrictEqual(cleanupInputFingerprint(value), before);
});

test('boolean formulas and unknown text block while BOOLEAN validation is removed only from approved fields', () => {
  const master = sheet('master', baseHeaders, [
    ['a1', '10', 'Oak', '', '10', 'Oak', 'maybe', { formulaValue: '=TRUE' }, false, false, false, false, false],
  ]);
  const plan = planFolderCleanup(master, []);
  assert.strictEqual(plan.canApply, false);
  assert.strictEqual(plan.sheets[0].blocks.filter((block) => block.code === 'invalid_boolean').length, 2);

  const clean = sheet('master', baseHeaders, [
    ['a1', '10', 'Oak', '', '10', 'Oak', true, false, false, false, false, false, false],
  ]);
  clean.cells[1][6].dataValidation = { condition: { type: 'BOOLEAN' } };
  const cleanPlan = planFolderCleanup(clean, []);
  assert.strictEqual(cleanPlan.sheets[0].booleanChanges[0].removeBooleanValidation, true);
});

test('blocks column deletion when a structural dependency intersects it', () => {
  const master = sheet('master', baseHeaders, [
    ['a1', '10', 'Oak', '', '10', 'Oak', false, false, false, false, false, false, false],
  ], {
    dependencies: [{ kind: 'formula', detail: 'formula references House', startColumn: 4, endColumn: 5 }],
  });
  const plan = planFolderCleanup(master, []);
  assert.strictEqual(plan.canApply, false);
  assert.ok(plan.sheets[0].blocks.some((block) => block.code === 'structural_dependency'));
});

test('only exact canonical headers are deleted', () => {
  const headers = baseHeaders.map((header) => header === 'House' ? 'house' : header === 'Street' ? 'Street Name' : header);
  const master = sheet('master', headers, [
    ['a1', '10', 'Oak', '', '10', 'Oak', false, false, false, false, false, false, false],
  ]);
  const plan = planFolderCleanup(master, []);
  assert.deepStrictEqual(plan.sheets[0].deleteColumns, []);
});

test('fingerprint changes when relevant master metadata changes even if planned counts do not', () => {
  const first = sheet('master', baseHeaders, [
    ['a1', '10', 'Oak', '2', '10', 'Oak', false, false, false, false, false, false, false],
  ]);
  const second = sheet('master', baseHeaders, [
    ['a1', '10', 'Oak', '3', '10', 'Oak', false, false, false, false, false, false, false],
  ]);
  assert.notStrictEqual(planFolderCleanup(first, []).fingerprint, planFolderCleanup(second, []).fingerprint);
});

test('missing unit columns and unsafe blank-master clearing block the whole workflow', () => {
  const withoutUnitHeaders = baseHeaders.filter((header) => header !== '_SitusUnit');
  const withoutUnit = sheet('master', withoutUnitHeaders, [
    ['a1', '10', 'Oak', '10', 'Oak', false, false, false, false, false, false, false],
  ]);
  assert.ok(planFolderCleanup(withoutUnit, []).sheets[0].blocks.some((block) => block.code === 'missing_unit'));

  const master = sheet('master', baseHeaders, [
    ['a1', '10', 'Oak', '', '10', 'Oak', false, false, false, false, false, false, false],
  ]);
  const captain = sheet('captain', baseHeaders, [
    ['a1', '10', 'Oak', '2B', '10', 'Oak', false, false, false, false, false, false, false],
  ]);
  assert.ok(
    planFolderCleanup(master, [captain]).sheets[1].blocks.some((block) => block.code === 'blank_unit_authority')
  );
});

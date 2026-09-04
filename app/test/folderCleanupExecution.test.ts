import test from 'node:test';
import assert from 'node:assert';
import { applyRequests, undoRequests, undoSafetyProblem, type CleanupSnapshot } from '../src/cleanupTasks';
import type { CleanupSheet, CleanupSheetPlan } from '../src/lib/folderCleanupEngine';

function plan(): CleanupSheetPlan {
  return {
    spreadsheetId: 'sheet',
    spreadsheetName: 'Captain 1',
    tabName: 'Data',
    sheetId: 77,
    role: 'captain',
    headersBefore: ['address_id', '_SitusUnit', 'House', 'Street', 'Wants_Updates'],
    headersAfter: ['address_id', '_SitusUnit', 'Wants_Updates'],
    deleteColumns: [{ header: 'Street', index: 3 }, { header: 'House', index: 2 }],
    booleanChanges: [{
      row: 2,
      column: 'Wants_Updates',
      colIndex: 4,
      before: {
        userEnteredValue: 'true',
        dataValidation: { condition: { type: 'BOOLEAN' } },
      },
      afterValue: true,
      removeBooleanValidation: true,
    }],
    unitChanges: [{
      row: 2,
      column: '_SitusUnit',
      colIndex: 1,
      before: { userEnteredValue: 2 },
      afterValue: '2',
    }],
    formatUnitColumn: 1,
    blocks: [],
    canApply: true,
    inputFingerprint: 'input',
    fingerprint: 'fingerprint',
  };
}

test('one cleanup request set writes retained cells, formats units, then deletes columns bottom-up', () => {
  const requests = applyRequests(plan(), 500);
  assert.strictEqual(requests.length, 5);
  assert.deepStrictEqual(requests[0].updateCells?.rows?.[0]?.values?.[0]?.userEnteredValue, { stringValue: '2' });
  assert.deepStrictEqual(requests[1].updateCells?.rows?.[0]?.values?.[0]?.userEnteredValue, { boolValue: true });
  assert.strictEqual(requests[1].updateCells?.fields, 'userEnteredValue,dataValidation');
  assert.deepStrictEqual(requests[2].repeatCell?.cell?.userEnteredFormat?.numberFormat, {
    type: 'TEXT',
    pattern: '@',
  });
  assert.deepStrictEqual(
    requests.slice(3).map((request) => request.deleteDimension?.range?.startIndex),
    [3, 2]
  );
});

test('boolean writes preserve unrelated validation unless the approved rule is BOOLEAN', () => {
  const value = plan();
  value.booleanChanges[0].removeBooleanValidation = false;
  const request = applyRequests(value, 10).find((item) =>
    item.updateCells?.rows?.[0]?.values?.[0]?.userEnteredValue?.boolValue === true
  );
  assert.strictEqual(request?.updateCells?.fields, 'userEnteredValue');
  assert.strictEqual(request?.updateCells?.rows?.[0]?.values?.[0]?.dataValidation, undefined);
});

test('Undo reinserts deleted columns with values, format, validation, and restores retained columns', () => {
  const snapshot: CleanupSnapshot = {
    version: 1,
    folderId: 'folder',
    role: 'captain',
    rowCount: 2,
    columnCount: 5,
    headersBefore: ['address_id', '_SitusUnit', 'House', 'Street', 'Wants_Updates'],
    headersAfter: ['address_id', '_SitusUnit', 'Wants_Updates'],
    deleted: [{
      header: 'House',
      index: 2,
      cells: [
        { userEnteredValue: 'House', userEnteredFormat: { textFormat: { bold: true } } },
        {
          userEnteredValue: '10',
          userEnteredFormat: { numberFormat: { type: 'TEXT', pattern: '@' } },
          dataValidation: { condition: { type: 'TEXT_NOT_EQ', values: [{ userEnteredValue: 'x' }] } },
        },
      ],
      dimensionProperties: { pixelSize: 140, hiddenByUser: false },
    }],
    booleans: [{
      row: 2,
      colIndex: 4,
      before: { userEnteredValue: 'true', dataValidation: { condition: { type: 'BOOLEAN' } } },
      afterValue: true,
    }],
    unit: {
      colIndex: 1,
      before: [
        { userEnteredValue: '_SitusUnit', userEnteredFormat: { numberFormat: { type: 'AUTOMATIC' } } },
        { userEnteredValue: 2, userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0' } } },
      ],
      changes: [{ row: 2, afterValue: '2' }],
    },
  };
  const requests = undoRequests(snapshot, 77);
  assert.strictEqual(requests[0].insertDimension?.range?.startIndex, 2);
  assert.strictEqual(requests[1].updateDimensionProperties?.properties?.pixelSize, 140);
  assert.strictEqual(requests[2].updateCells?.fields, 'userEnteredValue,userEnteredFormat,dataValidation,note');
  assert.deepStrictEqual(
    requests[2].updateCells?.rows?.[1]?.values?.[0]?.dataValidation,
    snapshot.deleted[0].cells[1].dataValidation
  );
  assert.strictEqual(requests.at(-1)?.updateCells?.range?.startColumnIndex, 1);
});

test('Undo blocks a sheet changed after cleanup and accepts the exact post-state', () => {
  const snapshot: CleanupSnapshot = {
    version: 1,
    folderId: 'folder',
    role: 'captain',
    rowCount: 2,
    columnCount: 3,
    headersBefore: ['address_id', '_SitusUnit', 'Wants_Updates'],
    headersAfter: ['address_id', '_SitusUnit', 'Wants_Updates'],
    deleted: [],
    booleans: [{ row: 2, colIndex: 2, before: { userEnteredValue: 'true' }, afterValue: true }],
    unit: {
      colIndex: 1,
      before: [{ userEnteredValue: '_SitusUnit' }, { userEnteredValue: 2 }],
      changes: [{ row: 2, afterValue: '2' }],
    },
  };
  const current: CleanupSheet = {
    spreadsheetId: 'sheet',
    spreadsheetName: 'Captain',
    tabName: 'Data',
    sheetId: 77,
    rowCount: 2,
    columnCount: 3,
    cells: [
      [
        { userEnteredValue: 'address_id' },
        { userEnteredValue: '_SitusUnit', numberFormat: { type: 'TEXT' } },
        { userEnteredValue: 'Wants_Updates' },
      ],
      [
        { userEnteredValue: 'a1' },
        { userEnteredValue: '2', numberFormat: { type: 'TEXT' } },
        { userEnteredValue: true },
      ],
    ],
  };
  assert.strictEqual(undoSafetyProblem(current, snapshot), null);
  current.cells[1][2].userEnteredValue = false;
  assert.match(undoSafetyProblem(current, snapshot) || '', /boolean cell changed/);
});

test('Undo blocks edits to unit cells that cleanup did not otherwise change', () => {
  const snapshot: CleanupSnapshot = {
    version: 1,
    folderId: 'folder',
    role: 'captain',
    rowCount: 3,
    columnCount: 2,
    headersBefore: ['address_id', '_SitusUnit'],
    headersAfter: ['address_id', '_SitusUnit'],
    deleted: [],
    booleans: [],
    unit: {
      colIndex: 1,
      before: [
        { userEnteredValue: '_SitusUnit' },
        { userEnteredValue: '2A' },
        { userEnteredValue: '3B' },
      ],
      changes: [],
      expectedAfter: ['_SitusUnit', '2A', '3B'],
    },
  };
  const current: CleanupSheet = {
    spreadsheetId: 'sheet',
    spreadsheetName: 'Captain',
    tabName: 'Data',
    sheetId: 77,
    rowCount: 3,
    columnCount: 2,
    cells: [
      [{ userEnteredValue: 'address_id' }, { userEnteredValue: '_SitusUnit', numberFormat: { type: 'TEXT' } }],
      [{ userEnteredValue: 'a1' }, { userEnteredValue: '2A', numberFormat: { type: 'TEXT' } }],
      [{ userEnteredValue: 'a2' }, { userEnteredValue: 'edited', numberFormat: { type: 'TEXT' } }],
    ],
  };

  assert.match(undoSafetyProblem(current, snapshot) || '', /unit cell changed.*row 3/);
});

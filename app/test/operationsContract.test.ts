import test from 'node:test';
import assert from 'node:assert';
import {
  ACTIVITY_EVENTS_HEADERS,
  DELETED_RECORDS_HEADERS,
  OPERATIONS_SCHEMA_VERSION,
  aggregateActivityEvents,
  groupDeletedRecordsByOperation,
  parseActivityEvents,
  parseDeletedRecords,
  summarizeActivityAggregation,
} from '../src/lib/operationsContract';

const deletedRow = (overrides: Partial<Record<string, unknown>> = {}): unknown[] => {
  const values: Record<string, unknown> = {
    operation_id: 'op-1',
    schema_version: OPERATIONS_SCHEMA_VERSION,
    action: 'delete_person',
    actor: 'Michael',
    zone: 'Zone 12',
    timestamp: '2026-09-04T07:00:00Z',
    resident_id: 'resident-1',
    address_id: 'address-1',
    resident_name: 'Alex Rivera',
    address_label: '10 Oak Street',
    source_sheet_id: 'sheet-1',
    source_sheet_tab: 'Residents',
    full_row_json: '{"resident_id":"resident-1","Notes":"private archive data"}',
    ...overrides,
  };
  return DELETED_RECORDS_HEADERS.map((header) => values[header]);
};

const activityRow = (overrides: Partial<Record<string, unknown>> = {}): unknown[] => {
  const values: Record<string, unknown> = {
    event_id: 'event-1',
    schema_version: OPERATIONS_SCHEMA_VERSION,
    actor: 'Michael',
    zone: 'Zone 12',
    event_type: 'outreach_logged',
    resident_id: 'resident-1',
    address_id: 'address-1',
    resident_name: 'Alex Rivera',
    address_label: '10 Oak Street',
    quantity: 1,
    timestamp: '2026-09-04T07:00:00Z',
    ...overrides,
  };
  return ACTIVITY_EVENTS_HEADERS.map((header) => values[header]);
};

test('Deleted Records parses an exact versioned archive row and its JSON', () => {
  const result = parseDeletedRecords([DELETED_RECORDS_HEADERS, deletedRow()]);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.records.length, 1);
  assert.strictEqual(result.records[0].operationId, 'op-1');
  assert.deepStrictEqual(result.records[0].fullRow, {
    resident_id: 'resident-1',
    Notes: 'private archive data',
  });
});

test('Deleted Records rejects dashboard-authored restore actions', () => {
  const result = parseDeletedRecords([
    DELETED_RECORDS_HEADERS,
    deletedRow({ action: 'restore' }),
  ]);
  assert.strictEqual(result.records.length, 0);
  assert.ok(result.errors.some((item) => item.field === 'action'));
});

test('strict headers reject reordered or extra workbook columns', () => {
  const result = parseDeletedRecords([
    [...DELETED_RECORDS_HEADERS].reverse(),
    deletedRow(),
  ]);
  assert.strictEqual(result.records.length, 0);
  assert.strictEqual(result.errors[0].row, 1);
  assert.strictEqual(result.errors[0].code, 'invalid_headers');
});

test('malformed versions and archive JSON are row-level errors', () => {
  const result = parseDeletedRecords([
    DELETED_RECORDS_HEADERS,
    deletedRow({ schema_version: '2.0', full_row_json: '{broken' }),
    deletedRow({ operation_id: 'op-2', resident_id: 'resident-2' }),
  ]);
  assert.strictEqual(result.records.length, 1);
  assert.strictEqual(result.records[0].operationId, 'op-2');
  assert.ok(result.errors.some((item) => item.row === 2 && item.code === 'unsupported_version'));
  assert.ok(result.errors.some((item) => item.row === 2 && item.code === 'invalid_json'));
});

test('duplicate archive identities keep the first row deterministically', () => {
  const result = parseDeletedRecords([
    DELETED_RECORDS_HEADERS,
    deletedRow({ resident_name: 'First' }),
    deletedRow({ resident_name: 'Second' }),
  ]);
  assert.strictEqual(result.records.length, 1);
  assert.strictEqual(result.records[0].residentName, 'First');
  assert.strictEqual(result.errors[0].code, 'duplicate_id');
  assert.strictEqual(result.errors[0].row, 3);
});

test('identical retried archive rows and activity events collapse without poisoning sync', () => {
  const deleted = parseDeletedRecords([
    DELETED_RECORDS_HEADERS,
    deletedRow(),
    deletedRow(),
  ]);
  assert.deepStrictEqual(deleted.errors, []);
  assert.strictEqual(deleted.records.length, 1);

  const activity = parseActivityEvents([
    ACTIVITY_EVENTS_HEADERS,
    activityRow(),
    activityRow(),
  ]);
  assert.deepStrictEqual(activity.errors, []);
  assert.strictEqual(activity.records.length, 1);
});

test('the same resident may be archived from master and captain copies', () => {
  const result = parseDeletedRecords([
    DELETED_RECORDS_HEADERS,
    deletedRow({ source_sheet_id: 'master', source_sheet_tab: 'Master Data' }),
    deletedRow({ source_sheet_id: 'zone-12', source_sheet_tab: 'Residents' }),
  ]);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.records.length, 2);
});

test('archive rows sharing an operation ID must agree on operation identity', () => {
  const result = parseDeletedRecords([
    DELETED_RECORDS_HEADERS,
    deletedRow(),
    deletedRow({
      source_sheet_id: 'sheet-2',
      action: 'delete_address',
    }),
  ]);
  assert.strictEqual(result.records.length, 1);
  assert.ok(result.errors.some((item) => item.code === 'inconsistent_operation'));
});

test('one whole-address operation retains and groups multiple resident archive rows', () => {
  const result = parseDeletedRecords([
    DELETED_RECORDS_HEADERS,
    deletedRow({ action: 'delete_address', resident_id: 'resident-1' }),
    deletedRow({
      action: 'delete_address',
      resident_id: 'resident-2',
      resident_name: 'Sam Rivera',
      full_row_json: '{"resident_id":"resident-2"}',
    }),
  ]);
  assert.deepStrictEqual(result.errors, []);
  const groups = groupDeletedRecordsByOperation(result.records);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].operationId, 'op-1');
  assert.deepStrictEqual(
    groups[0].records.map((record) => record.residentId),
    ['resident-1', 'resident-2']
  );
});

test('activity rejects notes, outreach contents, contact data, and metadata columns', () => {
  for (const privateHeader of ['notes', 'outreach_message', 'phone', 'email', 'metadata']) {
    const result = parseActivityEvents([
      [...ACTIVITY_EVENTS_HEADERS, privateHeader],
      [...activityRow(), 'must not survive'],
    ]);
    assert.strictEqual(result.records.length, 0, privateHeader);
    assert.strictEqual(result.errors[0].code, 'privacy_violation', privateHeader);
  }
});

test('activity strip mode drops every non-allowlisted field', () => {
  const result = parseActivityEvents(
    [
      [...ACTIVITY_EVENTS_HEADERS, 'notes', 'arbitrary_metadata'],
      [...activityRow(), 'secret', '{"anything":true}'],
    ],
    { privacyMode: 'strip' }
  );
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(Object.keys(result.records[0]), [
    'eventId',
    'schemaVersion',
    'actor',
    'zone',
    'eventType',
    'residentId',
    'addressId',
    'residentName',
    'addressLabel',
    'quantity',
    'timestamp',
  ]);
  assert.strictEqual('notes' in result.records[0], false);
});

test('duplicate activity event IDs keep the first valid event', () => {
  const result = parseActivityEvents([
    ACTIVITY_EVENTS_HEADERS,
    activityRow({ resident_name: 'First' }),
    activityRow({ resident_name: 'Second' }),
  ]);
  assert.strictEqual(result.records.length, 1);
  assert.strictEqual(result.records[0].residentName, 'First');
  assert.strictEqual(result.errors[0].code, 'duplicate_id');
  assert.strictEqual(result.errors[0].row, 3);
});

test('activity malformed versions are reported without blocking valid rows', () => {
  const result = parseActivityEvents([
    ACTIVITY_EVENTS_HEADERS,
    activityRow({ schema_version: 'next' }),
    activityRow({ event_id: 'event-2' }),
  ]);
  assert.strictEqual(result.records.length, 1);
  assert.strictEqual(result.records[0].eventId, 'event-2');
  assert.strictEqual(result.errors[0].code, 'unsupported_version');
});

test("aggregation produces 'Michael logged outreach for 2 people.'", () => {
  const parsed = parseActivityEvents([
    ACTIVITY_EVENTS_HEADERS,
    activityRow(),
    activityRow({
      event_id: 'event-2',
      resident_id: 'resident-2',
      resident_name: 'Sam Rivera',
    }),
  ]);
  const aggregate = aggregateActivityEvents(parsed.records);
  assert.strictEqual(aggregate.length, 1);
  assert.deepStrictEqual(aggregate[0], {
    actor: 'Michael',
    zone: 'Zone 12',
    eventType: 'outreach_logged',
    quantity: 2,
    eventCount: 2,
  });
  assert.strictEqual(
    summarizeActivityAggregation(aggregate[0]),
    'Michael logged outreach for 2 people.'
  );
});

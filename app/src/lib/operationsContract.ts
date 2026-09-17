/**
 * Pure, versioned contract for the private operations workbook.
 *
 * Parsers never mutate their input and never throw for workbook data errors.
 * Header order is part of the contract so producers cannot silently add fields.
 */

export const OPERATIONS_SCHEMA_VERSION = '1.0' as const;

export const DELETED_RECORDS_HEADERS = [
  'operation_id',
  'schema_version',
  'action',
  'actor',
  'zone',
  'timestamp',
  'resident_id',
  'address_id',
  'resident_name',
  'address_label',
  'source_sheet_id',
  'source_sheet_tab',
  'full_row_json',
] as const;

export const ACTIVITY_EVENTS_HEADERS = [
  'event_id',
  'schema_version',
  'actor',
  'zone',
  'event_type',
  'resident_id',
  'address_id',
  'resident_name',
  'address_label',
  'quantity',
  'timestamp',
] as const;

export type DeletionAction = 'delete_person' | 'delete_address' | 'restore';
export type ActivityEventType =
  | 'address_added'
  | 'person_added'
  | 'address_deleted'
  | 'person_deleted'
  | 'outreach_logged'
  | 'follow_up_changed'
  | 'restore';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface DeletedRecord {
  operationId: string;
  schemaVersion: typeof OPERATIONS_SCHEMA_VERSION;
  action: DeletionAction;
  actor: string;
  zone: string;
  timestamp: string;
  residentId: string;
  addressId: string;
  residentName: string;
  addressLabel: string;
  sourceSheetId: string;
  sourceSheetTab: string;
  fullRow: { [key: string]: JsonValue };
}

/** The complete allowlisted activity payload. No free-form field is present. */
export interface ActivityEvent {
  eventId: string;
  schemaVersion: typeof OPERATIONS_SCHEMA_VERSION;
  actor: string;
  zone: string;
  eventType: ActivityEventType;
  residentId: string;
  addressId: string;
  residentName: string;
  addressLabel: string;
  quantity: number;
  timestamp: string;
}

export type ContractErrorCode =
  | 'invalid_headers'
  | 'privacy_violation'
  | 'missing_value'
  | 'invalid_value'
  | 'unsupported_version'
  | 'invalid_json'
  | 'duplicate_id'
  | 'inconsistent_operation';

export interface ContractRowError {
  /** One-based workbook row number; headers are row 1. */
  row: number;
  field: string;
  code: ContractErrorCode;
  message: string;
}

export interface ParseResult<T> {
  records: T[];
  errors: ContractRowError[];
}

export interface ParseActivityOptions {
  /**
   * `reject` is the safe default. `strip` accepts extra columns but discards
   * every value outside ACTIVITY_EVENTS_HEADERS.
   */
  privacyMode?: 'reject' | 'strip';
}

export interface DeletedOperationGroup {
  operationId: string;
  action: DeletionAction;
  actor: string;
  zone: string;
  timestamp: string;
  addressId: string;
  records: DeletedRecord[];
}

export interface ActivityAggregation {
  actor: string;
  zone: string;
  eventType: ActivityEventType;
  quantity: number;
  eventCount: number;
}

type Grid = readonly (readonly unknown[])[];

const DELETION_ACTIONS: readonly DeletionAction[] = [
  'delete_person',
  'delete_address',
];

const ACTIVITY_EVENT_TYPES: readonly ActivityEventType[] = [
  'address_added',
  'person_added',
  'address_deleted',
  'person_deleted',
  'outreach_logged',
  'follow_up_changed',
  'restore',
];

const SENSITIVE_HEADER = /(note|comment|outreach.*(content|text|detail|message)|phone|mobile|cell|email|metadata|payload|json|detail)/i;

function error(
  row: number,
  field: string,
  code: ContractErrorCode,
  message: string
): ContractRowError {
  return { row, field, code, message };
}

function textCell(
  row: readonly unknown[],
  index: number,
  rowNumber: number,
  field: string,
  errors: ContractRowError[],
  allowEmpty = false
): string {
  const value = row[index];
  if (typeof value !== 'string') {
    errors.push(error(rowNumber, field, 'invalid_value', `${field} must be text.`));
    return '';
  }
  const valueTrimmed = value.trim();
  if (!allowEmpty && valueTrimmed === '') {
    errors.push(error(rowNumber, field, 'missing_value', `${field} is required.`));
  }
  return valueTrimmed;
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function parseHeaders(
  grid: Grid,
  expected: readonly string[],
  kind: string,
  allowExtras: boolean
): { indexes: number[]; errors: ContractRowError[] } {
  if (grid.length === 0) {
    return {
      indexes: [],
      errors: [error(1, 'headers', 'invalid_headers', `${kind} is missing its header row.`)],
    };
  }

  const actual = grid[0].map((value) => typeof value === 'string' ? value.trim() : String(value));
  if (!allowExtras) {
    const exact = actual.length === expected.length
      && expected.every((header, index) => actual[index] === header);
    if (!exact) {
      return {
        indexes: [],
        errors: [error(
          1,
          'headers',
          'invalid_headers',
          `${kind} headers must exactly be: ${expected.join(', ')}.`
        )],
      };
    }
    return { indexes: expected.map((_, index) => index), errors: [] };
  }

  const indexes = expected.map((header) => actual.indexOf(header));
  const missing = expected.filter((_, index) => indexes[index] < 0);
  if (missing.length > 0) {
    return {
      indexes: [],
      errors: [error(
        1,
        'headers',
        'invalid_headers',
        `${kind} is missing required headers: ${missing.join(', ')}.`
      )],
    };
  }
  return { indexes, errors: [] };
}

function rowIsBlank(row: readonly unknown[]): boolean {
  return row.every((value) => value === null || value === undefined || String(value).trim() === '');
}

function hasErrorsForRow(errors: readonly ContractRowError[], row: number): boolean {
  return errors.some((item) => item.row === row);
}

export function parseDeletedRecords(grid: Grid): ParseResult<DeletedRecord> {
  const headerResult = parseHeaders(grid, DELETED_RECORDS_HEADERS, 'Deleted Records', false);
  if (headerResult.errors.length > 0) return { records: [], errors: headerResult.errors };

  const records: DeletedRecord[] = [];
  const errors: ContractRowError[] = [];
  const seen = new Map<string, string>();
  const operationSignatures = new Map<string, string>();

  for (let index = 1; index < grid.length; index += 1) {
    const source = grid[index];
    if (rowIsBlank(source)) continue;
    const rowNumber = index + 1;
    const row = DELETED_RECORDS_HEADERS.map((_, cell) => source[headerResult.indexes[cell]]);
    const operationId = textCell(row, 0, rowNumber, 'operation_id', errors);
    const schemaVersion = textCell(row, 1, rowNumber, 'schema_version', errors);
    const action = textCell(row, 2, rowNumber, 'action', errors);
    const actor = textCell(row, 3, rowNumber, 'actor', errors);
    const zone = textCell(row, 4, rowNumber, 'zone', errors);
    const timestamp = textCell(row, 5, rowNumber, 'timestamp', errors);
    const residentId = textCell(row, 6, rowNumber, 'resident_id', errors);
    const addressId = textCell(row, 7, rowNumber, 'address_id', errors);
    const residentName = textCell(row, 8, rowNumber, 'resident_name', errors, true);
    const addressLabel = textCell(row, 9, rowNumber, 'address_label', errors, true);
    const sourceSheetId = textCell(row, 10, rowNumber, 'source_sheet_id', errors);
    const sourceSheetTab = textCell(row, 11, rowNumber, 'source_sheet_tab', errors);
    const fullRowJson = textCell(row, 12, rowNumber, 'full_row_json', errors);

    if (schemaVersion !== '' && schemaVersion !== OPERATIONS_SCHEMA_VERSION) {
      errors.push(error(
        rowNumber,
        'schema_version',
        'unsupported_version',
        `Unsupported schema version "${schemaVersion}"; expected ${OPERATIONS_SCHEMA_VERSION}.`
      ));
    }
    if (action !== '' && !DELETION_ACTIONS.includes(action as DeletionAction)) {
      errors.push(error(rowNumber, 'action', 'invalid_value', `Unknown deletion action "${action}".`));
    }
    if (timestamp !== '' && !validTimestamp(timestamp)) {
      errors.push(error(rowNumber, 'timestamp', 'invalid_value', 'timestamp must be ISO 8601 with a time zone.'));
    }

    let fullRow: { [key: string]: JsonValue } | undefined;
    if (fullRowJson !== '') {
      try {
        const parsed: unknown = JSON.parse(fullRowJson);
        if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
          errors.push(error(rowNumber, 'full_row_json', 'invalid_json', 'full_row_json must contain a JSON object.'));
        } else if (
          Object.values(parsed as Record<string, unknown>).some(
            (value) => value !== null && typeof value === 'object'
          )
        ) {
          errors.push(
            error(
              rowNumber,
              'full_row_json',
              'invalid_json',
              'full_row_json values must be spreadsheet cell values, not nested objects or arrays.'
            )
          );
        } else {
          fullRow = parsed as { [key: string]: JsonValue };
        }
      } catch {
        errors.push(error(rowNumber, 'full_row_json', 'invalid_json', 'full_row_json is not valid JSON.'));
      }
    }

    const dedupeKey = `${operationId}\u0000${residentId}\u0000${addressId}\u0000${sourceSheetId}\u0000${sourceSheetTab}`;
    const operationSignature = [action, actor, zone, timestamp, addressId].join('\u0000');
    const priorSignature = operationSignatures.get(operationId);
    if (operationId && priorSignature && priorSignature !== operationSignature) {
      errors.push(
        error(
          rowNumber,
          'operation_id',
          'inconsistent_operation',
          `Archive rows for operation "${operationId}" disagree about the action, actor, zone, time, or address.`
        )
      );
    }

    if (hasErrorsForRow(errors, rowNumber) || fullRow === undefined) continue;
    const payloadSignature = canonicalJson({
      operationId,
      schemaVersion,
      action,
      actor,
      zone,
      timestamp,
      residentId,
      addressId,
      residentName,
      addressLabel,
      sourceSheetId,
      sourceSheetTab,
      fullRow,
    });
    const existingPayload = seen.get(dedupeKey);
    if (existingPayload) {
      if (existingPayload !== payloadSignature) {
        errors.push(
          error(
            rowNumber,
            'operation_id',
            'duplicate_id',
            `Operation "${operationId}" reused a source-row identity with different archive data.`
          )
        );
      }
      continue;
    }
    seen.set(dedupeKey, payloadSignature);
    operationSignatures.set(operationId, operationSignature);
    records.push({
      operationId,
      schemaVersion: schemaVersion as typeof OPERATIONS_SCHEMA_VERSION,
      action: action as DeletionAction,
      actor,
      zone,
      timestamp,
      residentId,
      addressId,
      residentName,
      addressLabel,
      sourceSheetId,
      sourceSheetTab,
      fullRow,
    });
  }

  return { records, errors };
}

export function parseActivityEvents(
  grid: Grid,
  options: ParseActivityOptions = {}
): ParseResult<ActivityEvent> {
  const privacyMode = options.privacyMode ?? 'reject';
  const actualHeaders = grid.length > 0
    ? grid[0].map((value) => typeof value === 'string' ? value.trim() : String(value))
    : [];
  const extras = actualHeaders.filter((header) => !ACTIVITY_EVENTS_HEADERS.includes(
    header as typeof ACTIVITY_EVENTS_HEADERS[number]
  ));

  if (privacyMode === 'reject' && extras.length > 0) {
    const sensitive = extras.filter((header) => SENSITIVE_HEADER.test(header));
    const fields = sensitive.length > 0 ? sensitive : extras;
    return {
      records: [],
      errors: [error(
        1,
        fields.join(', '),
        'privacy_violation',
        `Activity Events contains non-allowlisted private fields: ${fields.join(', ')}.`
      )],
    };
  }

  const headerResult = parseHeaders(
    grid,
    ACTIVITY_EVENTS_HEADERS,
    'Activity Events',
    privacyMode === 'strip'
  );
  if (headerResult.errors.length > 0) return { records: [], errors: headerResult.errors };

  const records: ActivityEvent[] = [];
  const errors: ContractRowError[] = [];
  const seen = new Map<string, string>();

  for (let index = 1; index < grid.length; index += 1) {
    const source = grid[index];
    if (rowIsBlank(source)) continue;
    const rowNumber = index + 1;
    const row = ACTIVITY_EVENTS_HEADERS.map((_, cell) => source[headerResult.indexes[cell]]);
    const eventId = textCell(row, 0, rowNumber, 'event_id', errors);
    const schemaVersion = textCell(row, 1, rowNumber, 'schema_version', errors);
    const actor = textCell(row, 2, rowNumber, 'actor', errors);
    const zone = textCell(row, 3, rowNumber, 'zone', errors);
    const eventType = textCell(row, 4, rowNumber, 'event_type', errors);
    const residentId = textCell(row, 5, rowNumber, 'resident_id', errors, true);
    const addressId = textCell(row, 6, rowNumber, 'address_id', errors, true);
    const residentName = textCell(row, 7, rowNumber, 'resident_name', errors, true);
    const addressLabel = textCell(row, 8, rowNumber, 'address_label', errors, true);
    const quantityValue = row[9];
    const timestamp = textCell(row, 10, rowNumber, 'timestamp', errors);

    if (schemaVersion !== '' && schemaVersion !== OPERATIONS_SCHEMA_VERSION) {
      errors.push(error(
        rowNumber,
        'schema_version',
        'unsupported_version',
        `Unsupported schema version "${schemaVersion}"; expected ${OPERATIONS_SCHEMA_VERSION}.`
      ));
    }
    if (eventType !== '' && !ACTIVITY_EVENT_TYPES.includes(eventType as ActivityEventType)) {
      errors.push(error(rowNumber, 'event_type', 'invalid_value', `Unknown activity event type "${eventType}".`));
    }
    const quantity = typeof quantityValue === 'number'
      ? quantityValue
      : typeof quantityValue === 'string' && /^\d+$/.test(quantityValue.trim())
        ? Number(quantityValue.trim())
        : NaN;
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      errors.push(error(rowNumber, 'quantity', 'invalid_value', 'quantity must be a positive whole number.'));
    }
    if (timestamp !== '' && !validTimestamp(timestamp)) {
      errors.push(error(rowNumber, 'timestamp', 'invalid_value', 'timestamp must be ISO 8601 with a time zone.'));
    }
    if (hasErrorsForRow(errors, rowNumber)) continue;
    const payloadSignature = canonicalJson({
      eventId,
      schemaVersion,
      actor,
      zone,
      eventType,
      residentId,
      addressId,
      residentName,
      addressLabel,
      quantity,
      timestamp,
    });
    const existingPayload = seen.get(eventId);
    if (existingPayload) {
      if (existingPayload !== payloadSignature) {
        errors.push(
          error(rowNumber, 'event_id', 'duplicate_id', `event_id "${eventId}" was reused with different data.`)
        );
      }
      continue;
    }
    seen.set(eventId, payloadSignature);
    records.push({
      eventId,
      schemaVersion: schemaVersion as typeof OPERATIONS_SCHEMA_VERSION,
      actor,
      zone,
      eventType: eventType as ActivityEventType,
      residentId,
      addressId,
      residentName,
      addressLabel,
      quantity,
      timestamp,
    });
  }

  return { records, errors };
}

/** Groups archive rows without collapsing residents from whole-address deletes. */
export function groupDeletedRecordsByOperation(
  records: readonly DeletedRecord[]
): DeletedOperationGroup[] {
  const groups = new Map<string, DeletedOperationGroup>();
  for (const record of records) {
    const existing = groups.get(record.operationId);
    if (existing) {
      existing.records.push(record);
    } else {
      groups.set(record.operationId, {
        operationId: record.operationId,
        action: record.action,
        actor: record.actor,
        zone: record.zone,
        timestamp: record.timestamp,
        addressId: record.addressId,
        records: [record],
      });
    }
  }
  return [...groups.values()];
}

export function aggregateActivityEvents(
  events: readonly ActivityEvent[]
): ActivityAggregation[] {
  const aggregations = new Map<string, ActivityAggregation>();
  for (const event of events) {
    const key = `${event.actor}\u0000${event.zone}\u0000${event.eventType}`;
    const current = aggregations.get(key);
    if (current) {
      current.quantity += event.quantity;
      current.eventCount += 1;
    } else {
      aggregations.set(key, {
        actor: event.actor,
        zone: event.zone,
        eventType: event.eventType,
        quantity: event.quantity,
        eventCount: 1,
      });
    }
  }
  return [...aggregations.values()];
}

function noun(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function summarizeActivity(
  activity: ActivityEvent | ActivityAggregation
): string {
  const { actor, eventType, quantity } = activity;
  const subject = activity instanceof Object && 'residentName' in activity
    ? (activity.residentName || activity.addressLabel)
    : '';
  const suffix = subject ? ` (${subject})` : '';
  switch (eventType) {
    case 'outreach_logged':
      return `${actor} logged outreach for ${quantity} ${noun(quantity, 'person', 'people')}.`;
    case 'address_added':
      return `${actor} added ${quantity} ${noun(quantity, 'address')}${suffix}.`;
    case 'person_added':
      return `${actor} added ${quantity} ${noun(quantity, 'person', 'people')}${suffix}.`;
    case 'address_deleted':
      return `${actor} deleted ${quantity} ${noun(quantity, 'address')}${suffix}.`;
    case 'person_deleted':
      return `${actor} deleted ${quantity} ${noun(quantity, 'person', 'people')}${suffix}.`;
    case 'follow_up_changed':
      return `${actor} changed follow-up for ${quantity} ${noun(quantity, 'person', 'people')}${suffix}.`;
    case 'restore':
      return `${actor} restored ${quantity} ${noun(quantity, 'record')}${suffix}.`;
  }
}

export const summarizeActivityEvent = summarizeActivity;
export const summarizeActivityAggregation = summarizeActivity;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

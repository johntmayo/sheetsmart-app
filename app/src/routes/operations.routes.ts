import type { Request, Response, Router } from 'express';
import type { Deps } from '../types';
import * as google from '../google';
import * as jobs from '../jobs';
import { APPLY_DELETION_TASK } from '../executionTasks';
import { fingerprintArchivedPayload } from '../lib/deletionEngine';
import {
  ACTIVITY_EVENTS_HEADERS,
  DELETED_RECORDS_HEADERS,
  OPERATIONS_SCHEMA_VERSION,
  aggregateActivityEvents,
  groupDeletedRecordsByOperation,
  parseActivityEvents,
  parseDeletedRecords,
  summarizeActivityAggregation,
  summarizeActivityEvent,
  type ActivityEvent,
  type DeletedRecord,
} from '../lib/operationsContract';

const CONFIG_KEY = 'operations_workbook_v1';

export interface OperationsWorkbookConfig {
  spreadsheetId: string;
  deletedRecordsTab: string;
  activityEventsTab: string;
  allowedWriterEmails: string[];
}

const DEFAULT_CONFIG: OperationsWorkbookConfig = {
  spreadsheetId: '',
  deletedRecordsTab: 'Deleted Records',
  activityEventsTab: 'Activity Events',
  allowedWriterEmails: [],
};

export default function registerOperationsRoutes(api: Router, { db }: Deps): void {
  api.get('/operations/contract', (_req: Request, res: Response) => {
    res.json({
      schemaVersion: OPERATIONS_SCHEMA_VERSION,
      deletedRecordsHeaders: DELETED_RECORDS_HEADERS,
      activityEventsHeaders: ACTIVITY_EVENTS_HEADERS,
      ordering: 'Write every full Deleted Records archive row before setting its reversible Deleted Record marker.',
      idempotency: 'Reuse the same operation_id or event_id when retrying an action.',
      deletionActions: ['delete_person', 'delete_address'],
      restoration: 'Only SheetSmart Undo restores records; Zone Dashboard may emit a restore activity afterward.',
      deletionMarker: 'Write operation_id into the Deleted Record column; never physically remove the row.',
      privacy:
        'Activity Events accepts only the listed columns. Never include notes, outreach text, phone numbers, email addresses, or arbitrary metadata.',
    });
  });

  api.get('/operations/source', (_req: Request, res: Response) => {
    const config = loadConfig(db);
    res.json({ configured: Boolean(config.spreadsheetId), config });
  });

  api.put('/operations/source', async (req: Request, res: Response) => {
    const config = normalizeConfig(req.body);
    if (!config.spreadsheetId) {
      return res.status(400).json({ error: 'Enter the private operations spreadsheet ID.' });
    }
    if (config.deletedRecordsTab === config.activityEventsTab) {
      return res.status(400).json({ error: 'Deleted Records and Activity Events must use different tabs.' });
    }
    await assertPrivateWorkbook(config);
    db.setSetting(CONFIG_KEY, JSON.stringify(config));
    res.json({ configured: true, config });
  });

  api.post('/operations/initialize', async (req: Request, res: Response) => {
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'Confirm before creating or resetting the operations headers.' });
    }
    const config = loadConfig(db);
    if (!config.spreadsheetId) return res.status(400).json({ error: 'Set the operations spreadsheet first.' });
    await assertPrivateWorkbook(config);
    const meta = await google.getSpreadsheetMeta(config.spreadsheetId);
    const missing = [config.deletedRecordsTab, config.activityEventsTab].filter((tab) => !meta.tabs.includes(tab));
    const expectedByTab = new Map<string, readonly string[]>([
      [config.deletedRecordsTab, DELETED_RECORDS_HEADERS],
      [config.activityEventsTab, ACTIVITY_EVENTS_HEADERS],
    ]);
    for (const tab of [config.deletedRecordsTab, config.activityEventsTab].filter((name) => meta.tabs.includes(name))) {
      const existing = (await google.readValues(config.spreadsheetId, google.a1Range(tab, '1:1')))[0] || [];
      const actual = existing.map((value) => String(value ?? '').trim());
      const expected = expectedByTab.get(tab) || [];
      const blank = actual.every((value) => !value);
      const exact = actual.length === expected.length && expected.every((value, index) => value === actual[index]);
      if (!blank && !exact) {
        return res.status(409).json({
          error: `Tab "${tab}" already has different headers. SheetSmart left it unchanged. Use an empty tab or rename the existing tab.`,
        });
      }
    }
    if (missing.length > 0) {
      await google.batchUpdateSpreadsheet(
        config.spreadsheetId,
        missing.map((title) => ({ addSheet: { properties: { title } } }))
      );
    }
    await google.updateValues(config.spreadsheetId, [
      {
        range: google.a1Range(config.deletedRecordsTab, '1:1'),
        values: [[...DELETED_RECORDS_HEADERS]],
      },
      {
        range: google.a1Range(config.activityEventsTab, '1:1'),
        values: [[...ACTIVITY_EVENTS_HEADERS]],
      },
    ]);
    res.json({ ok: true, tabs: [config.deletedRecordsTab, config.activityEventsTab] });
  });

  api.post('/operations/sync', async (_req: Request, res: Response) => {
    const config = loadConfig(db);
    if (!config.spreadsheetId) return res.status(400).json({ error: 'Set the operations spreadsheet first.' });
    await assertPrivateWorkbook(config);
    const [deletedGrid, activityGrid] = await Promise.all([
      google.readValues(config.spreadsheetId, google.a1Range(config.deletedRecordsTab, 'A:M')),
      google.readValues(config.spreadsheetId, google.a1Range(config.activityEventsTab, 'A:K')),
    ]);
    const deleted = parseDeletedRecords(deletedGrid);
    const activity = parseActivityEvents(activityGrid);
    const errors = [
      ...deleted.errors.map((item) => ({ tab: config.deletedRecordsTab, ...item })),
      ...activity.errors.map((item) => ({ tab: config.activityEventsTab, ...item })),
    ];
    if (errors.length > 0) {
      return res.status(409).json({
        error: 'The operations workbook has invalid or unsafe rows. Nothing was imported.',
        errors,
      });
    }

    const groups = groupDeletedRecordsByOperation(deleted.records);
    const consistencyErrors = validateExistingOperations(db, groups);
    if (consistencyErrors.length > 0) {
      return res.status(409).json({
        error: 'An operation ID was reused with different deletion details. Nothing was imported.',
        errors: consistencyErrors,
      });
    }

    let operationsAdded = 0;
    let archiveRowsAdded = 0;
    let activityAdded = 0;
    db.transaction(() => {
      db.run(
        `DELETE FROM lifecycle_operation_locks
         WHERE run_id IN (SELECT id FROM runs WHERE status NOT IN ('queued','running'))`
      );
      if (db.get('SELECT run_id FROM lifecycle_operation_locks LIMIT 1')) {
        throw new Error('A deletion or restoration is running. Refresh activity again after it finishes.');
      }
      for (const group of groups) {
        const inserted = db.run(
          `INSERT OR IGNORE INTO deletion_operations
             (operation_id, action, actor, zone, address_id, requested_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            group.operationId,
            group.action,
            group.actor,
            group.zone,
            group.addressId,
            normalizeTimestamp(group.timestamp),
            group.action === 'restore' ? 'restored' : 'pending',
          ]
        );
        operationsAdded += inserted.changes;
        for (const record of group.records) {
          archiveRowsAdded += db.run(
            `INSERT OR IGNORE INTO deletion_archive_index
               (operation_id, resident_id, address_id, source_sheet_id, source_sheet_tab, archive_fingerprint)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              record.operationId,
              record.residentId,
              record.addressId,
              record.sourceSheetId,
              record.sourceSheetTab,
              archiveFingerprint(record),
            ]
          ).changes;
        }
        if (inserted.changes === 1) {
          applyTombstones(db, group.action, group.operationId, normalizeTimestamp(group.timestamp), group.records);
        }
      }
      for (const event of activity.records) {
        activityAdded += db.run(
          `INSERT OR IGNORE INTO activity_events
             (event_id, actor, zone, event_type, resident_id, address_id, resident_name,
              address_label, quantity, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            event.eventId,
            event.actor,
            event.zone,
            event.eventType,
            event.residentId,
            event.addressId,
            event.residentName,
            event.addressLabel,
            event.quantity,
            normalizeTimestamp(event.timestamp),
          ]
        ).changes;
      }
    })();
    res.json({
      ok: true,
      operationsAdded,
      archiveRowsAdded,
      activityAdded,
      pendingDeletions: pendingDeletionCount(db),
      syncedAt: new Date().toISOString(),
    });
  });

  api.get('/operations/deletions', (_req: Request, res: Response) => {
    res.json({
      operations: db.all(
        `SELECT operation_id, action, actor, zone, address_id, requested_at, status,
                applied_run_id, error
         FROM deletion_operations
         ORDER BY requested_at DESC, operation_id DESC LIMIT 500`
      ),
      pending: pendingDeletionCount(db),
    });
  });

  api.post('/operations/deletions/apply', (req: Request, res: Response) => {
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'Confirm before propagating captain deletions to other live sheets.' });
    }
    const operationIds = Array.isArray(req.body?.operationIds)
      ? [...new Set((req.body.operationIds as unknown[]).map((value) => String(value).trim()).filter(Boolean))]
      : [];
    if (operationIds.length < 1 || operationIds.length > 100) {
      return res.status(400).json({ error: 'Choose between 1 and 100 pending deletions.' });
    }
    const queued: Array<{ operationId: string; runId: number; jobId: number }> = [];
    for (const operationId of operationIds) {
      try {
        const created = jobs.enqueueDeletionOperation(operationId, {
          workflowName: 'Apply captain deletion',
          type: APPLY_DELETION_TASK,
          mode: 'live',
          params: { operationId },
        });
        queued.push({ operationId, ...created });
      } catch (error) {
        if (error instanceof jobs.OperationUnavailableError) {
          return res.status(409).json({
            error: `Deletion ${operationId} was already queued or applied. Refresh before trying again.`,
            queued,
          });
        }
        throw error;
      }
    }
    res.status(202).json({ queued, status: 'queued' });
  });

  api.post('/operations/deletions/:operationId/retry', (req: Request, res: Response) => {
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'Confirm before retrying this deletion.' });
    }
    const operationId = String(req.params.operationId || '').trim();
    const reset = db.run(
      `UPDATE deletion_operations
       SET status='pending', applied_run_id=NULL, error='', updated_at=datetime('now')
       WHERE operation_id=? AND status='failed'`,
      [operationId]
    );
    if (reset.changes !== 1) {
      return res.status(409).json({ error: 'Only a failed deletion can be retried.' });
    }
    const queued = jobs.enqueueDeletionOperation(operationId, {
      workflowName: 'Retry captain deletion',
      type: APPLY_DELETION_TASK,
      mode: 'live',
      params: { operationId },
    });
    res.status(202).json({ ...queued, status: 'queued' });
  });

  api.get('/operations/activity', (req: Request, res: Response) => {
    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) ? Math.max(1, Math.min(250, requested)) : 50;
    const events = db.all<ActivityEvent>(
      `SELECT event_id AS eventId, '1.0' AS schemaVersion, actor, zone,
              event_type AS eventType, resident_id AS residentId, address_id AS addressId,
              resident_name AS residentName, address_label AS addressLabel,
              quantity, occurred_at AS timestamp
       FROM activity_events ORDER BY julianday(occurred_at) DESC, event_id DESC LIMIT ?`,
      [limit]
    );
    const grouped = aggregateActivityEvents(events);
    res.json({
      events: events.map((event) => ({ ...event, summary: summarizeActivityEvent(event) })),
      summary: grouped.map((item) => ({ ...item, summary: summarizeActivityAggregation(item) })),
    });
  });
}

export function loadOperationsConfig(db: Deps['db']): OperationsWorkbookConfig {
  return loadConfig(db);
}

function loadConfig(db: Deps['db']): OperationsWorkbookConfig {
  const raw = db.getSetting(CONFIG_KEY, '');
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function normalizeConfig(value: unknown): OperationsWorkbookConfig {
  const input = (value || {}) as Partial<OperationsWorkbookConfig>;
  return {
    spreadsheetId: String(input.spreadsheetId || '').trim(),
    deletedRecordsTab: String(input.deletedRecordsTab || DEFAULT_CONFIG.deletedRecordsTab).trim(),
    activityEventsTab: String(input.activityEventsTab || DEFAULT_CONFIG.activityEventsTab).trim(),
    allowedWriterEmails: Array.isArray(input.allowedWriterEmails)
      ? [...new Set(input.allowedWriterEmails.map((value) => String(value).trim().toLowerCase()).filter(Boolean))]
      : [],
  };
}

function archiveFingerprint(record: DeletedRecord): string {
  return fingerprintArchivedPayload(record.fullRow);
}

function validateExistingOperations(
  db: Deps['db'],
  groups: ReturnType<typeof groupDeletedRecordsByOperation>
): Array<{ operationId: string; reason: string }> {
  const errors: Array<{ operationId: string; reason: string }> = [];
  for (const group of groups) {
    const existing = db.get<{
      action: string;
      actor: string;
      zone: string;
      address_id: string;
      requested_at: string;
    }>('SELECT action, actor, zone, address_id, requested_at FROM deletion_operations WHERE operation_id=?', [
      group.operationId,
    ]);
    if (
      existing &&
      (existing.action !== group.action ||
        existing.actor !== group.actor ||
        existing.zone !== group.zone ||
        existing.address_id !== group.addressId ||
        normalizeTimestamp(existing.requested_at) !== normalizeTimestamp(group.timestamp))
    ) {
      errors.push({ operationId: group.operationId, reason: 'The stored operation has different identity details.' });
    }
  }
  return errors;
}

function applyTombstones(
  db: Deps['db'],
  action: string,
  operationId: string,
  timestamp: string,
  records: DeletedRecord[]
): void {
  const residentIds = [...new Set(records.map((record) => record.residentId).filter(Boolean))];
  const addressIds = [...new Set(records.map((record) => record.addressId).filter(Boolean))];
  if (action === 'restore') {
    for (const residentId of residentIds) {
      db.run('UPDATE resident_tombstones SET active=0, restored_at=? WHERE resident_id=?', [timestamp, residentId]);
    }
    for (const addressId of addressIds) {
      db.run('UPDATE address_tombstones SET active=0, restored_at=? WHERE address_id=?', [timestamp, addressId]);
    }
    return;
  }
  for (const record of records) {
    db.run(
      `INSERT INTO resident_tombstones
         (resident_id, address_id, operation_id, active, deleted_at, restored_at)
       VALUES (?, ?, ?, 1, ?, NULL)
       ON CONFLICT(resident_id) DO UPDATE SET
         address_id=excluded.address_id, operation_id=excluded.operation_id,
         active=1, deleted_at=excluded.deleted_at, restored_at=NULL`,
      [record.residentId, record.addressId, operationId, timestamp]
    );
  }
  if (action === 'delete_address') {
    for (const addressId of addressIds) {
      db.run(
        `INSERT INTO address_tombstones
           (address_id, operation_id, active, deleted_at, restored_at)
         VALUES (?, ?, 1, ?, NULL)
         ON CONFLICT(address_id) DO UPDATE SET
           operation_id=excluded.operation_id, active=1, deleted_at=excluded.deleted_at, restored_at=NULL`,
        [addressId, operationId, timestamp]
      );
    }
  }
}

function pendingDeletionCount(db: Deps['db']): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM deletion_operations
       WHERE action IN ('delete_person','delete_address') AND status='pending'`
    )?.n || 0
  );
}

function normalizeTimestamp(value: string): string {
  return new Date(value).toISOString();
}

async function assertPrivateWorkbook(config: OperationsWorkbookConfig): Promise<void> {
  const permissions = await google.listDrivePermissions(config.spreadsheetId);
  const serviceAccount = (google.getClientEmail() || '').toLowerCase();
  const allowed = new Set([serviceAccount, ...config.allowedWriterEmails]);
  const unsafe = permissions.filter((permission) => {
    if (permission.type !== 'user') return true;
    if (permission.role === 'owner') return false;
    return !allowed.has(permission.emailAddress.toLowerCase());
  });
  if (unsafe.length > 0) {
    throw Object.assign(
      new Error(
        'This workbook is shared beyond its owner and the SheetSmart service account. Remove public, link, domain, group, and other-user access before using it for deleted records.'
      ),
      { status: 409 }
    );
  }
}

// In-process job runner (handoff 3.2 + Section 3). One job at a time, tracked
// in the `jobs` table so progress and interruptions are durable. Kept behind a
// clear enqueue()/runNext() boundary so it can later become Redis/BullMQ
// without touching callers.

import * as db from './db';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// A single durable log entry recorded during a run. Values are stored as text.
export interface LogEntry {
  spreadsheet?: unknown;
  row?: unknown;
  column?: unknown;
  resident_id?: unknown;
  type: string;
  existing_value?: unknown;
  incoming_value?: unknown;
  message?: unknown;
}

// The context handed to each task implementation.
export interface JobContext {
  runId: number;
  jobId: number;
  mode: string;
  params: Record<string, unknown>;
  assertLease(): void;
  reportProgress(progressObj: unknown): void;
  log(entry: LogEntry): void;
}

// A task is `async (ctx) => summaryObject`, keyed in the registry by run type.
export type TaskFn = (ctx: JobContext) => Promise<unknown> | unknown;

export interface EnqueueArgs {
  workflowId?: number | null;
  workflowName?: string;
  type: string;
  mode: 'dry' | 'live';
  params?: Record<string, unknown>;
}

interface JobRow {
  id: number;
  run_id: number;
  status: string;
  progress_json: string;
  owner_id: string;
}

interface RunRow {
  id: number;
  type: string;
  mode: string;
}

const taskRegistry = new Map<string, TaskFn>();
const workerId = `${process.pid}:${randomUUID()}`;
const leaseContext = new AsyncLocalStorage<{ jobId: number; ownerId: string }>();

let running = false;
let wakeTimer: NodeJS.Timeout | null = null;

export class PreviewAlreadyClaimedError extends Error {
  constructor(public readonly appliedRunId: number) {
    super(`That preview was already used for live run #${appliedRunId}.`);
  }
}

export class PreviewUnavailableError extends Error {}
export class OperationUnavailableError extends Error {}

export function registerTask(type: string, fn: TaskFn): void {
  taskRegistry.set(type, fn);
}

export function nowSql(): string {
  return db.get<{ t: string }>("SELECT datetime('now') AS t")!.t;
}

// Enqueue a run + its job. Returns { runId, jobId }.
export function enqueue({ workflowId = null, workflowName = '', type, mode, params = {} }: EnqueueArgs): {
  runId: number;
  jobId: number;
} {
  const queued = db.immediateTransaction(() => insertQueued({ workflowId, workflowName, type, mode, params }))();
  setImmediate(runNext);
  return queued;
}

export function enqueueFromPreview(
  previewRunId: number,
  expectedType: string,
  args: EnqueueArgs
): { runId: number; jobId: number } {
  const queued = db.immediateTransaction(() => {
    const preview = db.get<{ type: string; mode: string; status: string }>(
      'SELECT type, mode, status FROM runs WHERE id=?',
      [previewRunId]
    );
    if (
      !preview ||
      preview.type !== expectedType ||
      preview.mode !== 'dry' ||
      preview.status !== 'succeeded'
    ) {
      throw new PreviewUnavailableError('That preview is no longer available.');
    }
    const existing = db.get<{ applied_run_id: number }>(
      'SELECT applied_run_id FROM preview_claims WHERE preview_run_id=?',
      [previewRunId]
    );
    if (existing) throw new PreviewAlreadyClaimedError(existing.applied_run_id);
    const created = insertQueued(args);
    db.run('INSERT INTO preview_claims (preview_run_id, applied_run_id) VALUES (?, ?)', [
      previewRunId,
      created.runId,
    ]);
    return created;
  })();
  setImmediate(runNext);
  return queued;
}

export function appliedRunForPreview(previewRunId: number): number | null {
  return (
    db.get<{ applied_run_id: number }>('SELECT applied_run_id FROM preview_claims WHERE preview_run_id=?', [
      previewRunId,
    ])?.applied_run_id ?? null
  );
}

export function enqueueDeletionOperation(
  operationId: string,
  args: EnqueueArgs
): { runId: number; jobId: number } {
  const queued = db.immediateTransaction(() => {
    const operation = db.get<{ status: string; action: string }>(
      'SELECT status, action FROM deletion_operations WHERE operation_id=?',
      [operationId]
    );
    if (
      !operation ||
      operation.status !== 'pending' ||
      !['delete_person', 'delete_address'].includes(operation.action)
    ) {
      throw new OperationUnavailableError('That deletion operation has already been queued or applied.');
    }
    const created = insertQueued(args);
    const claimed = db.run(
      `UPDATE deletion_operations
       SET status='queued', applied_run_id=?, updated_at=datetime('now')
       WHERE operation_id=? AND status='pending'`,
      [created.runId, operationId]
    );
    if (claimed.changes !== 1) {
      throw new OperationUnavailableError('That deletion operation was claimed by another request.');
    }
    db.run(
      'INSERT INTO deletion_attempt_runs (operation_id, run_id) VALUES (?, ?)',
      [operationId, created.runId]
    );
    return created;
  })();
  setImmediate(runNext);
  return queued;
}

export function startProcessing(): void {
  if (!wakeTimer) {
    wakeTimer = setInterval(() => void runNext(), 15_000);
    wakeTimer.unref();
  }
  setImmediate(runNext);
}

export function assertCurrentJobLease(): void {
  const current = leaseContext.getStore();
  if (!current) return;
  const owned = db.get<{ id: number }>(
    `SELECT id FROM jobs
     WHERE id=? AND status='running' AND owner_id=?
       AND heartbeat_at >= datetime('now', '-60 seconds')`,
    [current.jobId, current.ownerId]
  );
  if (!owned) throw new Error('This job lost its execution lease. No further Google changes were attempted.');
}

function insertQueued({ workflowId = null, workflowName = '', type, mode, params = {} }: EnqueueArgs): {
  runId: number;
  jobId: number;
} {
  const insertRun = db.run(
    `INSERT INTO runs (workflow_id, workflow_name, type, mode, status, summary_json, created_at)
     VALUES (?, ?, ?, ?, 'queued', '{}', datetime('now'))`,
    [workflowId, workflowName, type, mode]
  );
  const runId = Number(insertRun.lastInsertRowid);
  const insertJob = db.run(
    `INSERT INTO jobs (run_id, status, progress_json, enqueued_at)
     VALUES (?, 'queued', ?, datetime('now'))`,
    [runId, JSON.stringify({ params })]
  );
  const jobId = Number(insertJob.lastInsertRowid);
  return { runId, jobId };
}

export async function runNext(): Promise<void> {
  if (running) return;
  const jobId = claimNextJob();
  if (jobId === null) return;

  running = true;
  try {
    await executeJob(jobId);
  } catch (e) {
    // executeJob already records failures; this is a last-resort guard.
    console.error('Job execution crashed:', e);
  } finally {
    running = false;
    setImmediate(runNext);
  }
}

function claimNextJob(): number | null {
  return db.immediateTransaction(() => {
    const expired = db.all<{ id: number; run_id: number | null }>(
      `SELECT id, run_id FROM jobs
       WHERE status='running'
         AND (heartbeat_at IS NULL OR heartbeat_at < datetime('now', '-60 seconds'))`
    );
    for (const job of expired) {
      const interrupted = db.run(
        `UPDATE jobs
         SET status='interrupted', finished_at=datetime('now'), error='Worker heartbeat expired'
         WHERE id=? AND status='running'
           AND (heartbeat_at IS NULL OR heartbeat_at < datetime('now', '-60 seconds'))`,
        [job.id]
      );
      if (interrupted.changes === 1 && job.run_id) {
        db.run(
          `UPDATE runs SET status='interrupted', finished_at=datetime('now')
           WHERE id=? AND status='running'`,
          [job.run_id]
        );
        db.run(
          `UPDATE deletion_operations
           SET status='failed', error='Worker heartbeat expired', updated_at=datetime('now')
           WHERE applied_run_id=? AND status='queued'`,
          [job.run_id]
        );
        db.run('DELETE FROM lifecycle_operation_locks WHERE run_id=?', [job.run_id]);
      }
    }

    if (db.get("SELECT id FROM jobs WHERE status='running' LIMIT 1")) return null;
    const next = db.get<{ id: number; run_id: number }>(
      "SELECT id, run_id FROM jobs WHERE status='queued' ORDER BY id LIMIT 1"
    );
    if (!next) return null;
    const claimed = db.run(
      `UPDATE jobs
       SET status='running', owner_id=?, heartbeat_at=datetime('now'), started_at=datetime('now')
       WHERE id=? AND status='queued'`,
      [workerId, next.id]
    );
    if (claimed.changes !== 1) return null;
    db.run(
      `UPDATE runs SET status='running', started_at=COALESCE(started_at, datetime('now'))
       WHERE id=? AND status='queued'`,
      [next.run_id]
    );
    return next.id;
  })();
}

async function executeJob(jobId: number): Promise<void> {
  const job = db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job || job.status !== 'running' || job.owner_id !== workerId) return;
  const run = db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [job.run_id]);
  if (!run) return;

  const task = taskRegistry.get(run.type);
  if (!task) {
    fail(job, run, `No task registered for type "${run.type}"`);
    return;
  }

  const params = safeParseParams(job.progress_json);
  const sensitiveKeys = sensitiveLogKeys();
  const heartbeat = setInterval(() => {
    db.run(
      "UPDATE jobs SET heartbeat_at=datetime('now') WHERE id=? AND status='running' AND owner_id=?",
      [jobId, workerId]
    );
  }, 10_000);
  heartbeat.unref();

  const ctx: JobContext = {
    runId: run.id,
    jobId,
    mode: run.mode,
    params,
    assertLease: assertCurrentJobLease,
    reportProgress(progressObj: unknown) {
      db.run(
        `UPDATE jobs SET progress_json=?, heartbeat_at=datetime('now')
         WHERE id=? AND status='running' AND owner_id=?`,
        [JSON.stringify({ params, progress: progressObj }), jobId, workerId]
      );
    },
    log(entry: LogEntry) {
      const column = str(entry.column);
      const redact = entry.type === 'sensitive' || sensitiveKeys.has(normalizeKey(column));
      db.run(
        `INSERT INTO run_log_entries
           (run_id, spreadsheet, row, column, resident_id, type, existing_value, incoming_value, message, value_redacted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          run.id,
          str(entry.spreadsheet),
          str(entry.row),
          column,
          str(entry.resident_id),
          str(entry.type),
          redact ? '[private field hidden]' : str(entry.existing_value),
          redact ? '[private field hidden]' : str(entry.incoming_value),
          redact ? 'Private field event recorded; values hidden.' : str(entry.message),
          redact ? 1 : 0,
        ]
      );
      if (entry.type === 'conflict') {
        db.run(
          `INSERT INTO conflicts
             (run_id, spreadsheet, row, column, resident_id, existing_value, incoming_value)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            run.id,
            str(entry.spreadsheet),
            str(entry.row),
            str(entry.column),
            str(entry.resident_id),
            str(entry.existing_value),
            str(entry.incoming_value),
          ]
        );
      }
    },
  };

  try {
    const summary = (await leaseContext.run({ jobId, ownerId: workerId }, () => task(ctx))) || {};
    db.immediateTransaction(() => {
      const finished = db.run(
        `UPDATE jobs SET status='succeeded', finished_at=datetime('now'), heartbeat_at=datetime('now')
         WHERE id=? AND status='running' AND owner_id=?`,
        [jobId, workerId]
      );
      if (finished.changes === 1) {
        db.run("UPDATE runs SET status='succeeded', finished_at=datetime('now'), summary_json=? WHERE id=?", [
          JSON.stringify(summary),
          run.id,
        ]);
        db.run('DELETE FROM lifecycle_operation_locks WHERE run_id=?', [run.id]);
      }
    })();
  } catch (e) {
    fail(job, run, e instanceof Error ? e.message : String(e));
  } finally {
    clearInterval(heartbeat);
  }
}

function fail(job: JobRow, run: RunRow, message: string): void {
  db.immediateTransaction(() => {
    const failed = db.run(
      `UPDATE jobs SET status='failed', finished_at=datetime('now'), error=?
       WHERE id=? AND status='running' AND owner_id=?`,
      [String(message), job.id, workerId]
    );
    if (failed.changes === 1) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [run.id]);
      db.run(
        `UPDATE deletion_operations
         SET status='failed', error=?, updated_at=datetime('now')
         WHERE applied_run_id=? AND status='queued'`,
        [String(message), run.id]
      );
      db.run('DELETE FROM lifecycle_operation_locks WHERE run_id=?', [run.id]);
    }
  })();
}

function safeParseParams(progressJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(progressJson || '{}');
    return parsed.params || {};
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function normalizeKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sensitiveLogKeys(): Set<string> {
  const keys = new Set<string>();
  const fields = db.all<{ id: number; canonical_name: string }>(
    'SELECT id, canonical_name FROM dictionary_fields WHERE is_sensitive=1'
  );
  for (const field of fields) {
    keys.add(normalizeKey(field.canonical_name));
    for (const alias of db.all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id=?', [field.id])) {
      keys.add(normalizeKey(alias.alias));
    }
  }
  return keys;
}

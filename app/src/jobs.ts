// In-process job runner (handoff 3.2 + Section 3). One job at a time, tracked
// in the `jobs` table so progress and interruptions are durable. Kept behind a
// clear enqueue()/runNext() boundary so it can later become Redis/BullMQ
// without touching callers.

import * as db from './db';

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
}

interface RunRow {
  id: number;
  type: string;
  mode: string;
}

const taskRegistry = new Map<string, TaskFn>();

let running = false;
const queue: number[] = []; // array of jobId

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

  queue.push(jobId);
  setImmediate(runNext);
  return { runId, jobId };
}

export async function runNext(): Promise<void> {
  if (running) return;
  const jobId = queue.shift();
  if (jobId === undefined) return;

  running = true;
  try {
    await executeJob(jobId);
  } catch (e) {
    // executeJob already records failures; this is a last-resort guard.
    console.error('Job execution crashed:', e);
  } finally {
    running = false;
    if (queue.length > 0) setImmediate(runNext);
  }
}

async function executeJob(jobId: number): Promise<void> {
  const job = db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return;
  const run = db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [job.run_id]);
  if (!run) return;

  const task = taskRegistry.get(run.type);
  if (!task) {
    fail(job, run, `No task registered for type "${run.type}"`);
    return;
  }

  db.run("UPDATE jobs SET status='running', started_at=datetime('now') WHERE id=?", [jobId]);
  db.run("UPDATE runs SET status='running', started_at=datetime('now') WHERE id=?", [run.id]);

  const params = safeParseParams(job.progress_json);

  const ctx: JobContext = {
    runId: run.id,
    jobId,
    mode: run.mode,
    params,
    reportProgress(progressObj: unknown) {
      db.run('UPDATE jobs SET progress_json=? WHERE id=?', [JSON.stringify({ params, progress: progressObj }), jobId]);
    },
    log(entry: LogEntry) {
      db.run(
        `INSERT INTO run_log_entries
           (run_id, spreadsheet, row, column, resident_id, type, existing_value, incoming_value, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          run.id,
          str(entry.spreadsheet),
          str(entry.row),
          str(entry.column),
          str(entry.resident_id),
          str(entry.type),
          str(entry.existing_value),
          str(entry.incoming_value),
          str(entry.message),
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
    const summary = (await task(ctx)) || {};
    db.run("UPDATE runs SET status='succeeded', finished_at=datetime('now'), summary_json=? WHERE id=?", [
      JSON.stringify(summary),
      run.id,
    ]);
    db.run("UPDATE jobs SET status='succeeded', finished_at=datetime('now') WHERE id=?", [jobId]);
  } catch (e) {
    fail(job, run, e instanceof Error ? e.message : String(e));
  }
}

function fail(job: JobRow, run: RunRow, message: string): void {
  db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [run.id]);
  db.run("UPDATE jobs SET status='failed', finished_at=datetime('now'), error=? WHERE id=?", [String(message), job.id]);
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

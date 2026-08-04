// Thin data-access module. Everything that touches the database goes through
// here so the storage engine (SQLite today, Postgres later) can be swapped
// without rewriting the rest of the app. See handoff Section 3 upgrade paths.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from './config';
import { buildSeed } from './dictionarySeed';

// The dictionary field data types, shared with the seed + routes.
export type DataType = 'text' | 'number' | 'date' | 'checkbox';

// Parameters accepted by the underlying prepared statement (positional array or
// a named-parameter object). better-sqlite3 binds either shape.
export type SqlParams = readonly unknown[] | Record<string, unknown>;

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('master','captain_folder','external')),
  google_id    TEXT NOT NULL,
  source_tab   TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflows (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  type                  TEXT NOT NULL,
  source_connection_id  INTEGER REFERENCES connections(id) ON DELETE SET NULL,
  target_connection_id  INTEGER REFERENCES connections(id) ON DELETE SET NULL,
  match_column          TEXT DEFAULT '',
  source_tab            TEXT DEFAULT '',
  notes                 TEXT DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS column_mappings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id    INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  source_column  TEXT NOT NULL,
  target_column  TEXT NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS column_policies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id  INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  column_name  TEXT NOT NULL,
  policy       TEXT NOT NULL CHECK (policy IN ('fill_blank','overwrite','conflict','never'))
);

CREATE TABLE IF NOT EXISTS sensitive_columns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  column_name  TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id   INTEGER REFERENCES workflows(id) ON DELETE SET NULL,
  workflow_name TEXT DEFAULT '',
  type          TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('dry','live')),
  status        TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  actor         TEXT DEFAULT 'admin',
  summary_json  TEXT DEFAULT '{}',
  started_at    TEXT,
  finished_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS run_log_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  spreadsheet    TEXT DEFAULT '',
  row            TEXT DEFAULT '',
  column         TEXT DEFAULT '',
  resident_id    TEXT DEFAULT '',
  type           TEXT NOT NULL,
  existing_value TEXT DEFAULT '',
  incoming_value TEXT DEFAULT '',
  message        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_log_run ON run_log_entries(run_id);
CREATE INDEX IF NOT EXISTS idx_log_type ON run_log_entries(run_id, type);

-- Exact pre-write state for Phase-C undo. Snapshots are keyed by resident
-- identity as well as their original A1 range so revert can re-find a row even
-- after people insert, sort, or edit rows in Google Sheets.
CREATE TABLE IF NOT EXISTS run_snapshots (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  spreadsheet_id     TEXT NOT NULL,
  spreadsheet_name   TEXT DEFAULT '',
  tab_name            TEXT NOT NULL,
  operation           TEXT NOT NULL CHECK (operation IN ('cell_update','row_append','row_delete')),
  resident_id         TEXT NOT NULL,
  range_a1            TEXT DEFAULT '',
  before_json         TEXT NOT NULL DEFAULT 'null',
  after_json          TEXT NOT NULL DEFAULT 'null',
  metadata_json       TEXT NOT NULL DEFAULT '{}',
  reverted_by_run_id  INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshot_run ON run_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_identity
  ON run_snapshots(spreadsheet_id, tab_name, resident_id);

CREATE TABLE IF NOT EXISTS conflicts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  spreadsheet      TEXT DEFAULT '',
  row              TEXT DEFAULT '',
  column           TEXT DEFAULT '',
  resident_id      TEXT DEFAULT '',
  existing_value   TEXT DEFAULT '',
  incoming_value   TEXT DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution_notes TEXT DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  progress_json TEXT DEFAULT '{}',
  error         TEXT DEFAULT '',
  enqueued_at   TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT
);

-- Simple key/value store for app-wide settings that are not workflow-scoped.
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Field Dictionary (SHEETSMART_VISION_AND_ROADMAP.md §5.1): the canonical list
-- of logical fields, each with its data type, protection rules, default sync
-- policy, and aliases. This is where "column drift" becomes a managed mapping.
CREATE TABLE IF NOT EXISTS dictionary_fields (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL UNIQUE,
  data_type      TEXT NOT NULL DEFAULT 'text' CHECK (data_type IN ('text','number','date','checkbox')),
  is_identity    INTEGER NOT NULL DEFAULT 0,
  is_sensitive   INTEGER NOT NULL DEFAULT 0,
  is_text_safe   INTEGER NOT NULL DEFAULT 0,
  default_policy TEXT NOT NULL DEFAULT 'fill_blank' CHECK (default_policy IN ('fill_blank','overwrite','conflict','never')),
  notes          TEXT DEFAULT '',
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dictionary_aliases (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  field_id  INTEGER NOT NULL REFERENCES dictionary_fields(id) ON DELETE CASCADE,
  alias     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alias_field ON dictionary_aliases(field_id);
`;

export function init(): Database.Database {
  if (db) return db;

  const dir = path.dirname(config.databasePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  applyColumnMigrations();

  reconcileInterruptedJobsOnStartup();
  seedDictionaryIfEmpty();
  return db;
}

// Additive column migrations for databases created by an earlier build. Each
// entry must be safe to apply to an existing database with live data.
function applyColumnMigrations(): void {
  const conn = getDb();
  const migrations: Array<{ table: string; column: string; definition: string }> = [
    // Where a conflict came from (spreadsheet, tab, row, column), so the
    // Conflict Inbox can write the approved value back to the exact cell.
    { table: 'conflicts', column: 'context_json', definition: "TEXT NOT NULL DEFAULT '{}'" },
  ];

  for (const migration of migrations) {
    const columns = conn.prepare(`PRAGMA table_info(${migration.table})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === migration.column)) continue;
    conn.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.definition}`);
  }
}

// Populate the Field Dictionary from the real master schema on first run. Only
// runs when the table is empty, so it never clobbers Operator edits.
function seedDictionaryIfEmpty(): void {
  const conn = getDb();
  const { n } = conn.prepare('SELECT COUNT(*) AS n FROM dictionary_fields').get() as { n: number };
  if (n > 0) return;

  const seed = buildSeed();
  const insertField = conn.prepare(
    `INSERT INTO dictionary_fields
       (canonical_name, data_type, is_identity, is_sensitive, is_text_safe, default_policy, notes, sort_order)
     VALUES (@canonical_name, @data_type, @is_identity, @is_sensitive, @is_text_safe, @default_policy, @notes, @sort_order)`
  );
  const insertAlias = conn.prepare('INSERT INTO dictionary_aliases (field_id, alias) VALUES (?, ?)');
  const tx = conn.transaction(() => {
    for (const f of seed) {
      const { aliases, ...fieldRow } = f;
      const info = insertField.run(fieldRow);
      for (const alias of aliases) insertAlias.run(info.lastInsertRowid, alias);
    }
  });
  tx();
}

export function getDb(): Database.Database {
  if (!db) init();
  return db as Database.Database;
}

// Job durability (handoff 3.2): on startup, no job can still be legitimately
// "running" because the process just started, so mark any such rows and their
// runs as interrupted. This keeps the queue from being blocked by a zombie.
function reconcileInterruptedJobsOnStartup(): void {
  const conn = getDb();
  const now = "datetime('now')";
  const stuck = conn
    .prepare("SELECT id, run_id FROM jobs WHERE status IN ('running','queued')")
    .all() as Array<{ id: number; run_id: number | null }>;
  if (stuck.length === 0) return;
  const markJob = conn.prepare(
    `UPDATE jobs SET status='interrupted', finished_at=${now}, error='Interrupted by server restart' WHERE id=?`
  );
  const markRun = conn.prepare(
    `UPDATE runs SET status='interrupted', finished_at=${now} WHERE id=? AND status IN ('running','queued')`
  );
  const tx = conn.transaction(() => {
    for (const job of stuck) {
      markJob.run(job.id);
      if (job.run_id) markRun.run(job.run_id);
    }
  });
  tx();
}

// ---- Generic helpers ----
export function run(sql: string, params: SqlParams = []): Database.RunResult {
  return getDb().prepare(sql).run(params as never);
}
export function get<T = any>(sql: string, params: SqlParams = []): T | undefined {
  return getDb().prepare(sql).get(params as never) as T | undefined;
}
export function all<T = any>(sql: string, params: SqlParams = []): T[] {
  return getDb().prepare(sql).all(params as never) as T[];
}
export function transaction<F extends (...args: any[]) => any>(fn: F): Database.Transaction<F> {
  return getDb().transaction(fn);
}

// ---- App settings ----
export function getSetting(key: string, fallback = ''): string {
  const row = get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}
export function setSetting(key: string, value: unknown): void {
  run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    String(value),
  ]);
}

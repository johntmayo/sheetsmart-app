// Thin data-access module. Everything that touches the database goes through
// here so the storage engine (SQLite today, Postgres later) can be swapped
// without rewriting the rest of the app. See handoff Section 3 upgrade paths.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from './config';
import { APPROVED_BOOLEAN_FIELDS, buildSeed } from './dictionarySeed';
import { ZONE_DASHBOARD_SALES_FIELDS, ZONE_DASHBOARD_SALES_NOTE } from './lib/salesFieldPolicy';

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
  message        TEXT DEFAULT '',
  value_redacted INTEGER NOT NULL DEFAULT 0
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

-- Folder cleanup snapshots preserve whole affected columns as Sheets CellData,
-- including values, formats, notes, and validation. One record per sheet lets
-- Undo remain atomic and conservatively refuse a sheet changed afterward.
CREATE TABLE IF NOT EXISTS cleanup_sheet_snapshots (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  spreadsheet_id     TEXT NOT NULL,
  spreadsheet_name   TEXT NOT NULL DEFAULT '',
  tab_name            TEXT NOT NULL,
  sheet_id            INTEGER NOT NULL,
  folder_id           TEXT NOT NULL DEFAULT '',
  before_json         TEXT NOT NULL,
  after_json          TEXT NOT NULL,
  reverted_by_run_id  INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, spreadsheet_id, tab_name)
);
CREATE INDEX IF NOT EXISTS idx_cleanup_snapshot_run ON cleanup_sheet_snapshots(run_id);

-- Files created by SheetSmart (currently missing captain-zone sheets). Their
-- post-create modified time lets Undo preserve any file humans edited later.
CREATE TABLE IF NOT EXISTS run_created_files (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  file_id            TEXT NOT NULL,
  file_name          TEXT NOT NULL DEFAULT '',
  web_view_link      TEXT NOT NULL DEFAULT '',
  modified_time      TEXT NOT NULL DEFAULT '',
  reverted_by_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_created_file_run ON run_created_files(run_id);

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

-- Cross-app resident/address lifecycle. Full deleted row payloads remain in a
-- private Google workbook; SQLite keeps identities, status, and source indexes
-- so normal reconciliation cannot resurrect deliberately deleted records.
CREATE TABLE IF NOT EXISTS deletion_operations (
  operation_id       TEXT PRIMARY KEY,
  action             TEXT NOT NULL CHECK (action IN ('delete_person','delete_address','restore')),
  actor              TEXT NOT NULL DEFAULT '',
  zone               TEXT NOT NULL DEFAULT '',
  address_id         TEXT NOT NULL DEFAULT '',
  requested_at       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','queued','applied','restored','failed')),
  applied_run_id     INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  error              TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deletion_archive_index (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id       TEXT NOT NULL REFERENCES deletion_operations(operation_id) ON DELETE CASCADE,
  resident_id        TEXT NOT NULL DEFAULT '',
  address_id         TEXT NOT NULL DEFAULT '',
  source_sheet_id    TEXT NOT NULL DEFAULT '',
  source_sheet_tab   TEXT NOT NULL DEFAULT '',
  archive_fingerprint TEXT NOT NULL DEFAULT '',
  UNIQUE(operation_id, resident_id, address_id, source_sheet_id, source_sheet_tab)
);
CREATE INDEX IF NOT EXISTS idx_deletion_archive_operation ON deletion_archive_index(operation_id);

CREATE TABLE IF NOT EXISTS deletion_attempt_runs (
  operation_id       TEXT NOT NULL REFERENCES deletion_operations(operation_id) ON DELETE CASCADE,
  run_id             INTEGER NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(operation_id, run_id)
);

CREATE TABLE IF NOT EXISTS lifecycle_operation_locks (
  run_id             INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  operation_id       TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sheet_safety_locks (
  spreadsheet_id     TEXT NOT NULL,
  protected_range_id INTEGER NOT NULL,
  operation_id       TEXT NOT NULL,
  run_id             INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(spreadsheet_id, protected_range_id)
);

CREATE TABLE IF NOT EXISTS resident_tombstones (
  resident_id        TEXT PRIMARY KEY,
  address_id         TEXT NOT NULL DEFAULT '',
  operation_id       TEXT NOT NULL REFERENCES deletion_operations(operation_id) ON DELETE RESTRICT,
  active             INTEGER NOT NULL DEFAULT 1,
  deleted_at         TEXT NOT NULL,
  restored_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_resident_tombstones_active ON resident_tombstones(active, address_id);

CREATE TABLE IF NOT EXISTS address_tombstones (
  address_id         TEXT PRIMARY KEY,
  operation_id       TEXT NOT NULL REFERENCES deletion_operations(operation_id) ON DELETE RESTRICT,
  active             INTEGER NOT NULL DEFAULT 1,
  deleted_at         TEXT NOT NULL,
  restored_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_address_tombstones_active ON address_tombstones(active);

CREATE TABLE IF NOT EXISTS activity_events (
  event_id           TEXT PRIMARY KEY,
  actor              TEXT NOT NULL,
  zone               TEXT NOT NULL DEFAULT '',
  event_type         TEXT NOT NULL,
  resident_id        TEXT NOT NULL DEFAULT '',
  address_id         TEXT NOT NULL DEFAULT '',
  resident_name      TEXT NOT NULL DEFAULT '',
  address_label      TEXT NOT NULL DEFAULT '',
  quantity           INTEGER NOT NULL DEFAULT 1,
  occurred_at        TEXT NOT NULL,
  ingested_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_occurred ON activity_events(occurred_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  progress_json TEXT DEFAULT '{}',
  error         TEXT DEFAULT '',
  owner_id      TEXT DEFAULT '',
  heartbeat_at  TEXT,
  enqueued_at   TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT
);

CREATE TABLE IF NOT EXISTS preview_claims (
  preview_run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT,
  applied_run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  claimed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, enqueued_at, id);

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
  distribute_to_captain INTEGER NOT NULL DEFAULT 1,
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
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  applyColumnMigrations();
  backfillPreviewClaims();

  seedDictionaryIfEmpty();
  ensureDeletionMarkerField();
  applySalesOwnershipLock();
  applyAddressDistributionScopeV2();
  applyPrivacyClassificationV1();
  applyApprovedBooleanTypesV1();
  redactHistoricalSensitiveLogsV1();
  return db;
}

function ensureDeletionMarkerField(): void {
  const conn = getDb();
  if (conn.prepare("SELECT id FROM dictionary_fields WHERE canonical_name='Deleted Record'").get()) return;
  const field = buildSeed().find((item) => item.canonical_name === 'Deleted Record');
  if (!field) throw new Error('Deleted Record dictionary seed is missing.');
  const { aliases, ...row } = field;
  const info = conn
    .prepare(
      `INSERT INTO dictionary_fields
         (canonical_name, data_type, is_identity, is_sensitive, is_text_safe, distribute_to_captain,
          default_policy, notes, sort_order)
       VALUES (@canonical_name, @data_type, @is_identity, @is_sensitive, @is_text_safe, @distribute_to_captain,
               @default_policy, @notes, @sort_order)`
    )
    .run(row);
  for (const alias of aliases) {
    conn.prepare('INSERT INTO dictionary_aliases (field_id, alias) VALUES (?, ?)').run(info.lastInsertRowid, alias);
  }
}

function backfillPreviewClaims(): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO preview_claims (preview_run_id, applied_run_id)
       SELECT preview.id, CAST(json_extract(preview.summary_json, '$.appliedRunId') AS INTEGER)
       FROM runs preview
       JOIN runs applied
         ON applied.id = CAST(json_extract(preview.summary_json, '$.appliedRunId') AS INTEGER)
       WHERE json_valid(preview.summary_json)
         AND json_type(preview.summary_json, '$.appliedRunId') = 'integer'`
    )
    .run();
}

// Additive column migrations for databases created by an earlier build. Each
// entry must be safe to apply to an existing database with live data.
function applyColumnMigrations(): void {
  const conn = getDb();
  const migrations: Array<{ table: string; column: string; definition: string }> = [
    // Where a conflict came from (spreadsheet, tab, row, column), so the
    // Conflict Inbox can write the approved value back to the exact cell.
    { table: 'conflicts', column: 'context_json', definition: "TEXT NOT NULL DEFAULT '{}'" },
    { table: 'jobs', column: 'owner_id', definition: "TEXT NOT NULL DEFAULT ''" },
    { table: 'jobs', column: 'heartbeat_at', definition: 'TEXT' },
    { table: 'run_log_entries', column: 'value_redacted', definition: 'INTEGER NOT NULL DEFAULT 0' },
    {
      table: 'dictionary_fields',
      column: 'distribute_to_captain',
      definition: 'INTEGER NOT NULL DEFAULT 1',
    },
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
       (canonical_name, data_type, is_identity, is_sensitive, is_text_safe, distribute_to_captain,
        default_policy, notes, sort_order)
     VALUES (@canonical_name, @data_type, @is_identity, @is_sensitive, @is_text_safe, @distribute_to_captain,
             @default_policy, @notes, @sort_order)`
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

// Zone Dashboard owns sales. Reapply this invariant at every startup so an
// older UI, direct database edit, or stale deployment cannot loosen it.
function applySalesOwnershipLock(): void {
  const conn = getDb();
  conn
    .prepare(
      `UPDATE dictionary_fields
          SET distribute_to_captain=0, default_policy='never', notes=?
        WHERE canonical_name IN (${ZONE_DASHBOARD_SALES_FIELDS.map(() => '?').join(',')})`
    )
    .run(ZONE_DASHBOARD_SALES_NOTE, ...ZONE_DASHBOARD_SALES_FIELDS);
}

// Canonical House and Street are master-only. Captain sheets use the canonical
// _Situs fields after the dedicated cleanup has verified every eligible row.
function applyAddressDistributionScopeV2(): void {
  const conn = getDb();
  const key = 'captain_distribution_scope_v2';
  if (conn.prepare('SELECT value FROM app_settings WHERE key=?').get(key)) return;
  const tx = conn.transaction(() => {
    conn
      .prepare(`UPDATE dictionary_fields SET distribute_to_captain=0 WHERE canonical_name IN ('House','Street')`)
      .run();
    conn.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key, new Date().toISOString());
  });
  tx();
}

// One-time classification of resident PII, casework notes, and sensitive
// outreach/status fields. Operators can refine these flags afterward in the
// Field Dictionary without startup overwriting their choices.
function applyPrivacyClassificationV1(): void {
  const conn = getDb();
  const key = 'privacy_classification_v1';
  const alreadyApplied = conn.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  if (alreadyApplied) return;
  const fields = [
    'Age',
    'Gender',
    'Home Phone',
    'Cell',
    'Email',
    'Damage',
    'Address Plan',
    'Build Status',
    'Person - Renter',
    'Person - Needs Follow-Up',
    'Person - Unable to Reach',
    'Person Notes',
    'Last Outreach Attempt Date',
    'Outreach Log',
    'Address Notes',
    'Former Resident',
    'Deceased',
    'Wants_Updates',
    'Remediation Status',
    'Successfully Contacted',
    'NC Phone',
    'NC Email',
  ];
  const tx = conn.transaction(() => {
    conn
      .prepare(`UPDATE dictionary_fields SET is_sensitive=1 WHERE canonical_name IN (${fields.map(() => '?').join(',')})`)
      .run(...fields);
    conn.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key, new Date().toISOString());
  });
  tx();
}

function applyApprovedBooleanTypesV1(): void {
  const conn = getDb();
  const key = 'approved_boolean_types_v1';
  if (conn.prepare('SELECT value FROM app_settings WHERE key=?').get(key)) return;
  const fields = [...APPROVED_BOOLEAN_FIELDS];
  const tx = conn.transaction(() => {
    conn
      .prepare(
        `UPDATE dictionary_fields SET data_type='checkbox'
         WHERE canonical_name IN (${fields.map(() => '?').join(',')})`
      )
      .run(...fields);
    conn.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key, new Date().toISOString());
  });
  tx();
}

function redactHistoricalSensitiveLogsV1(): void {
  const conn = getDb();
  const key = 'historical_log_redaction_v1';
  if (conn.prepare('SELECT value FROM app_settings WHERE key=?').get(key)) return;
  const sensitiveKeys = new Set<string>();
  const fields = conn
    .prepare('SELECT id, canonical_name FROM dictionary_fields WHERE is_sensitive=1')
    .all() as Array<{ id: number; canonical_name: string }>;
  const aliases = conn.prepare('SELECT alias FROM dictionary_aliases WHERE field_id=?');
  const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const field of fields) {
    sensitiveKeys.add(normalize(field.canonical_name));
    for (const row of aliases.all(field.id) as Array<{ alias: string }>) sensitiveKeys.add(normalize(row.alias));
  }
  const rows = conn
    .prepare('SELECT id, column, type FROM run_log_entries WHERE value_redacted=0')
    .all() as Array<{ id: number; column: string; type: string }>;
  const redact = conn.prepare(
    `UPDATE run_log_entries
     SET existing_value='[private field hidden]',
         incoming_value='[private field hidden]',
         message='Private field event recorded; values hidden.',
         value_redacted=1
     WHERE id=?`
  );
  const tx = conn.transaction(() => {
    for (const row of rows) {
      if (row.type === 'sensitive' || sensitiveKeys.has(normalize(row.column))) redact.run(row.id);
    }
    conn.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key, new Date().toISOString());
  });
  tx();
}

export function getDb(): Database.Database {
  if (!db) init();
  return db as Database.Database;
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
export function immediateTransaction<F extends (...args: any[]) => any>(fn: F): F {
  return getDb().transaction(fn).immediate as F;
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

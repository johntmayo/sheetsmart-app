import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

test('existing dictionaries migrate safely and mark sales fields master-only', async () => {
  const databasePath = path.join(os.tmpdir(), `sheetsmart-scope-${process.pid}-${Date.now()}.sqlite`);
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    CREATE TABLE dictionary_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_name TEXT NOT NULL UNIQUE,
      data_type TEXT NOT NULL DEFAULT 'text',
      is_identity INTEGER NOT NULL DEFAULT 0,
      is_sensitive INTEGER NOT NULL DEFAULT 0,
      is_text_safe INTEGER NOT NULL DEFAULT 0,
      default_policy TEXT NOT NULL DEFAULT 'fill_blank',
      notes TEXT DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const salesFields = [
    'Address - For Sale',
    'Address - Sold Since Fire',
    'Latest Sale Date',
    'Latest Sale Price',
    'Latest New Owner',
    'Lot SqFt',
    'Sales History',
  ];
  const insert = legacy.prepare('INSERT INTO dictionary_fields (canonical_name, sort_order) VALUES (?, ?)');
  salesFields.forEach((field, index) => insert.run(field, index));
  insert.run('Resident Name', salesFields.length);
  const approvedBooleans = [
    'Wants_Updates',
    'Former Resident',
    'Deceased',
    'Person - Needs Follow-Up',
    'Person - Unable to Reach',
    'Person - Renter',
    'Successfully Contacted',
  ];
  approvedBooleans.forEach((field, index) => insert.run(field, salesFields.length + index + 1));
  legacy.close();

  process.env.DATABASE_PATH = databasePath;
  const db = await import('../src/db.js');
  const connection = db.init();
  const migrated = connection
    .prepare('SELECT canonical_name, distribute_to_captain, default_policy, notes FROM dictionary_fields ORDER BY sort_order')
    .all() as Array<{ canonical_name: string; distribute_to_captain: number; default_policy: string; notes: string }>;

  const migratedSales = migrated.filter((field) => salesFields.includes(field.canonical_name));
  assert.deepStrictEqual(migratedSales.map((field) => field.distribute_to_captain), salesFields.map(() => 0));
  assert.deepStrictEqual(migratedSales.map((field) => field.default_policy), salesFields.map(() => 'never'));
  assert.ok(migratedSales.every((field) => /Zone Dashboard central sales data/.test(field.notes)));
  assert.strictEqual(
    migrated.find((field) => field.canonical_name === 'Resident Name')?.distribute_to_captain,
    1
  );
  const typed = connection
    .prepare(
      `SELECT canonical_name, data_type FROM dictionary_fields
       WHERE canonical_name IN (${approvedBooleans.map(() => '?').join(',')})`
    )
    .all(...approvedBooleans) as Array<{ canonical_name: string; data_type: string }>;
  assert.strictEqual(typed.length, approvedBooleans.length);
  assert.ok(typed.every((field) => field.data_type === 'checkbox'));
  for (const table of [
    'deletion_operations',
    'deletion_archive_index',
    'resident_tombstones',
    'address_tombstones',
    'activity_events',
  ]) {
    assert.strictEqual(
      Boolean(connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)),
      true,
      `${table} should be created for existing databases`
    );
  }

  connection.close();
  fs.rmSync(databasePath, { force: true });
});

'use strict';

// Adds (or updates) one connection in the database from the command line.
// Handy for seeding without typing long IDs into the UI. Usage:
//
//   node scripts/add-connection.js "<name>" <master|captain_folder|external> <googleId> ["<tab>"]

const db = require('../src/db');

const [, , name, type, googleId, tab = ''] = process.argv;
const VALID = ['master', 'captain_folder', 'external'];

if (!name || !type || !googleId) {
  console.error('Usage: node scripts/add-connection.js "<name>" <master|captain_folder|external> <googleId> ["<tab>"]');
  process.exit(1);
}
if (!VALID.includes(type)) {
  console.error(`type must be one of: ${VALID.join(', ')}`);
  process.exit(1);
}

db.init();
const existing = db.get('SELECT id FROM connections WHERE google_id = ?', [googleId]);
if (existing) {
  db.run('UPDATE connections SET name = ?, type = ?, source_tab = ? WHERE id = ?', [name, type, tab, existing.id]);
  console.log(`Updated connection #${existing.id}: ${name} (${type})`);
} else {
  const info = db.run('INSERT INTO connections (name, type, google_id, source_tab) VALUES (?, ?, ?, ?)', [name, type, googleId, tab]);
  console.log(`Added connection #${info.lastInsertRowid}: ${name} (${type})`);
}

'use strict';

// Read-only Phase 0 connection checker. Verifies the service account can reach
// a spreadsheet or folder. Writes NOTHING. Usage:
//
//   node scripts/check-connection.js master  <spreadsheetId> [tabName]
//   node scripts/check-connection.js external <spreadsheetId> [tabName]
//   node scripts/check-connection.js folder  <folderId>
//
// Exit code 0 on success, 1 on failure.

const google = require('../src/google');

async function main() {
  const [, , type, googleId, tab] = process.argv;

  if (!type || !googleId) {
    console.error('Usage: node scripts/check-connection.js <master|external|folder> <googleId> [tab]');
    process.exit(1);
  }
  if (!google.isConfigured()) {
    console.error('Google is not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON_B64 in .env first.');
    process.exit(1);
  }

  console.log(`Service account: ${google.getClientEmail()}`);
  console.log(`Testing ${type}: ${googleId}\n`);

  try {
    if (type === 'folder') {
      const files = await google.listSpreadsheetsInFolder(googleId);
      console.log(`OK — folder is reachable. Found ${files.length} spreadsheet(s):`);
      files.slice(0, 60).forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}. ${f.name}`));
      if (files.length > 60) console.log(`  … and ${files.length - 60} more`);
    } else {
      const meta = await google.getSpreadsheetMeta(googleId);
      const tabToRead = tab || meta.tabs[0];
      const headers = await google.readHeaders(googleId, tabToRead);
      const nonBlank = headers.filter((h) => h !== '');
      console.log(`OK — "${meta.title}" is reachable.`);
      console.log(`  Tabs: ${meta.tabs.join(', ')}`);
      console.log(`  Read tab "${tabToRead}" — ${nonBlank.length} column headers:`);
      console.log('  ' + nonBlank.join(' | '));
    }
    process.exit(0);
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.error('FAILED: ' + msg);
    if (/permission|403|not have access|forbidden/i.test(msg)) {
      console.error('\nMost likely cause: this sheet/folder is not shared with the service account.');
      console.error('Share it as Editor with: ' + google.getClientEmail());
    } else if (/not found|404/i.test(msg)) {
      console.error('\nMost likely cause: the ID is wrong. Re-check the ID from the URL.');
    }
    process.exit(1);
  }
}

main();

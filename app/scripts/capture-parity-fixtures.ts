// Read-only parity-fixture capture (SHEETSMART parity harness).
//
// Reads (a) frozen COPIES of the master + captain sheets — the INPUT — and
// (b) the legacy Apps Script audit report those copies produced — the GOLDEN
// OUTPUT — and writes a single committed fixture consumed by test/parity.test.ts.
// This script WRITES NOTHING to any Google sheet; it only reads.
//
// Usage (PowerShell), after the Operator has:
//   1. made COPIES of the master + a few captain sheets (into one Drive folder),
//   2. shared them with the service-account bot as at least Viewer, and
//   3. run the legacy runAudit() on those copies to produce the report:
//
//   npx tsx scripts/capture-parity-fixtures.ts <masterCopyId> <folderCopyId> <legacyReportId> [masterTabName]
//
// The IDs come from the URLs:
//   spreadsheet: .../spreadsheets/d/THIS_PART/edit
//   folder:      .../folders/THIS_PART
//
// Output: test/fixtures/parity/parity-fixture.json

import fs from 'node:fs';
import path from 'node:path';
import * as google from '../src/google';

const REPORT_TABS = {
  overview: 'Overview',
  columnDetail: 'Column Detail',
  duplicates: 'Duplicate Resident IDs',
  missingRows: 'Missing Rows',
  extraRows: 'Extra Rows',
  missingSitus: 'Missing Situs Address',
  apnInconsistencies: 'APN Inconsistencies',
} as const;

type Grid = unknown[][];

async function readGrid(spreadsheetId: string, tab?: string): Promise<Grid> {
  const range = tab ? google.a1Range(tab, 'A:ZZ') : 'A:ZZ';
  return (await google.readValues(spreadsheetId, range)) as Grid;
}

// Turn a report tab grid into an array of row objects keyed by its header row,
// skipping the legacy tool's placeholder/message rows ("No ... found.", skip
// reasons, or otherwise-empty rows).
function parseReportTab(grid: Grid): Array<Record<string, unknown>> {
  if (!grid || grid.length === 0) return [];
  const headers = (grid[0] || []).map((h) => String(h == null ? '' : h).trim());
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] || [];
    const first = String(r[0] == null ? '' : r[0]).trim();
    const nonBlank = r.filter((c) => c !== '' && c !== null && c !== undefined).length;
    const looksLikeMessage = /^no .*found\.?$/i.test(first) || /skipped/i.test(first) || first === '';
    if (nonBlank <= 1 && looksLikeMessage) continue;
    const obj: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      if (h !== '') obj[h] = r[idx] === undefined ? '' : r[idx];
    });
    rows.push(obj);
  }
  return rows;
}

async function main(): Promise<void> {
  const [, , masterCopyId, folderCopyId, reportId, masterTab] = process.argv;
  if (!masterCopyId || !folderCopyId || !reportId) {
    console.error('Usage: npx tsx scripts/capture-parity-fixtures.ts <masterCopyId> <folderCopyId> <legacyReportId> [masterTabName]');
    process.exit(1);
  }
  if (!google.isConfigured()) {
    console.error('Google is not configured (.env). Set GOOGLE_SERVICE_ACCOUNT_JSON_B64 first.');
    process.exit(1);
  }

  console.log(`Service account: ${google.getClientEmail()}`);
  console.log('Reading frozen copies + legacy report (read-only)…\n');

  // INPUT: master copy + every captain-sheet copy in the folder.
  const masterData = await readGrid(masterCopyId, masterTab);
  console.log(`Master copy: ${masterData.length} rows.`);

  const files = await google.listSpreadsheetsInFolder(folderCopyId);
  files.sort((a, b) => a.name.localeCompare(b.name)); // match legacy collectSpreadsheets_ ordering
  console.log(`Folder copy: ${files.length} captain sheet copy(ies).`);

  const sheets: Array<{ name: string; url: string; data: Grid }> = [];
  for (const f of files) {
    const data = await readGrid(f.id);
    sheets.push({ name: f.name, url: f.webViewLink || '', data });
    console.log(`  • ${f.name}: ${data.length} rows`);
  }

  // GOLDEN: parse each tab of the legacy audit report.
  console.log('\nReading legacy report tabs…');
  const golden: Record<string, Array<Record<string, unknown>>> = {};
  for (const [key, tabName] of Object.entries(REPORT_TABS)) {
    try {
      const grid = await readGrid(reportId, tabName);
      golden[key] = parseReportTab(grid);
      console.log(`  • ${tabName}: ${golden[key].length} row(s)`);
    } catch (e) {
      console.error(`  ! Could not read tab "${tabName}": ${(e as Error).message}`);
      golden[key] = [];
    }
  }

  const fixture = {
    capturedAt: new Date().toISOString(),
    note: 'Read-only parity fixture. INPUT = frozen copies; golden = legacy Code.gs report. See test/parity.test.ts.',
    master: { id: masterCopyId, data: masterData },
    sheets,
    golden: {
      overview: golden.overview,
      columnDetail: golden.columnDetail,
      duplicates: golden.duplicates,
      missingRows: golden.missingRows,
      extraRows: golden.extraRows,
      missingSitus: golden.missingSitus,
      apnInconsistencies: golden.apnInconsistencies,
    },
  };

  const outDir = path.join(process.cwd(), 'test', 'fixtures', 'parity');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'parity-fixture.json');
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2), 'utf8');

  console.log(`\nWrote ${outPath}`);
  console.log('Now run:  npm test   (the parity test will activate and diff our engine vs legacy).');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', (e as Error).message);
  process.exit(1);
});

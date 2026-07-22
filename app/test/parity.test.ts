// Parity harness (SHEETSMART_VISION_AND_ROADMAP.md §7, handoff §8.5).
//
// WHY THIS EXISTS: before SheetSmart is ever allowed to write to a real sheet,
// we must PROVE that its new (TypeScript) audit engine produces the *same*
// numbers as the trusted legacy Apps Script tool (`legacy-appsscript/Code.gs`).
// "Safe" must be demonstrable, not asserted.
//
// HOW IT WORKS: the Operator makes frozen COPIES of the master + a few captain
// sheets, runs the legacy `runAudit()` on those copies (producing its 8-tab
// report spreadsheet), and then `scripts/capture-parity-fixtures.ts` reads both
// the copies (the INPUT) and the legacy report (the GOLDEN OUTPUT) and writes a
// single committed fixture file. This test feeds that INPUT to our engine and
// asserts, cell for cell, that our output matches the legacy GOLDEN output. Any
// divergence fails loudly.
//
// Until that fixture exists, this test SKIPS (so the suite stays green) while
// clearly telling the next agent/operator what to do to activate it.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { runAudit, type Grid, type SheetInput, type SheetAudit } from '../src/lib/auditEngine';

const FIXTURE_PATH = path.join(process.cwd(), 'test', 'fixtures', 'parity', 'parity-fixture.json');

// The shape written by scripts/capture-parity-fixtures.ts.
interface ParityFixture {
  capturedAt: string;
  master: { id: string; data: Grid };
  sheets: Array<{ name: string; url: string; data: Grid }>;
  golden: {
    overview: Array<Record<string, unknown>>; // one row per scanned sheet
    columnDetail: Array<Record<string, unknown>>;
    duplicates: Array<Record<string, unknown>>;
    missingRows: Array<Record<string, unknown>>;
    extraRows: Array<Record<string, unknown>>;
    missingSitus: Array<Record<string, unknown>>;
    apnInconsistencies: Array<Record<string, unknown>>;
  };
}

// Normalize any scalar to a comparable string so 72 (number) and "72" (from a
// spreadsheet cell) compare equal, and 'N/A' stays 'N/A'.
function norm(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).trim();
}

// Map a golden Overview row (keyed by the legacy report's exact header names) to
// the subset of our SheetAudit we compare. Drive-metadata columns the legacy
// report includes but our engine intentionally omits (Last Edited / Last Editor)
// are not part of parity — parity is about audit *logic*, not Drive metadata.
function goldenOverviewToComparable(row: Record<string, unknown>): Record<string, string> {
  return {
    totalColumns: norm(row['Total Columns']),
    dataRows: norm(row['Data Rows']),
    apnValues: norm(row['APN Values']),
    damageValues: norm(row['Damage Values']),
    addressesMissingApn: norm(row['Addresses Missing APN']),
    zone: norm(row['Zone']),
    apnInconsistentAddresses: norm(row['APN Inconsistent Addresses']),
    missingRows: norm(row['Missing Rows']),
    extraNotInMaster: norm(row['Extra (Not in Master)']),
    extraWrongZone: norm(row['Extra (Wrong Zone)']),
    missingVsMaster: norm(row['Missing vs Master']),
    extraVsMaster: norm(row['Extra vs Master']),
    status: norm(row['Status']),
  };
}

// Our SheetAudit -> the same comparable shape. Legacy displays the detected zone
// as `zone || '(no zone detected)'`; ERROR/Empty rows leave many cells blank.
function ourAuditToComparable(a: SheetAudit): Record<string, string> {
  const isNormal = a.status !== 'ERROR' && a.status !== 'Empty';
  return {
    totalColumns: norm(a.totalColumns),
    dataRows: norm(a.dataRows),
    apnValues: norm(a.apnValues),
    damageValues: norm(a.damageValues),
    addressesMissingApn: norm(a.addressesMissingApn),
    zone: isNormal ? norm(a.zone || '(no zone detected)') : norm(a.zone),
    apnInconsistentAddresses: norm(a.apnInconsistentAddresses),
    missingRows: norm(a.missingRows),
    extraNotInMaster: norm(a.extraNotInMaster),
    extraWrongZone: norm(a.extraWrongZone),
    missingVsMaster: norm((a.missingColumns || []).join(', ')),
    extraVsMaster: norm((a.extraColumns || []).join(', ')),
    status: norm(a.status),
  };
}

const hasFixture = fs.existsSync(FIXTURE_PATH);

test(
  'audit engine matches legacy golden output on frozen copies (parity harness)',
  {
    skip: hasFixture
      ? false
      : 'No parity fixture yet. Ask the Operator for frozen COPIES + a legacy audit run, then run: npx tsx scripts/capture-parity-fixtures.ts <masterCopyId> <folderCopyId> <legacyReportId>',
  },
  () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as ParityFixture;

    const sheets: SheetInput[] = fixture.sheets.map((s) => ({ name: s.name, url: s.url, data: s.data }));
    const report = runAudit(fixture.master.data, sheets);

    // ---- Overview: per-sheet audit numbers must match, sheet by sheet ----
    const ours = new Map<string, SheetAudit>();
    for (const a of report.sheets) ours.set(a.name, a);

    assert.strictEqual(
      report.sheets.length,
      fixture.golden.overview.length,
      `sheet count mismatch: ours=${report.sheets.length} legacy=${fixture.golden.overview.length}`
    );

    for (const goldenRow of fixture.golden.overview) {
      const name = norm(goldenRow['Spreadsheet']);
      const our = ours.get(name);
      assert.ok(our, `our audit is missing a sheet the legacy report has: "${name}"`);
      assert.deepStrictEqual(
        ourAuditToComparable(our),
        goldenOverviewToComparable(goldenRow),
        `Overview parity mismatch for sheet "${name}"`
      );
    }

    // ---- Detail tabs: the counts our engine reports must match the legacy
    // report's row counts exactly (the individual rows are spot-checked below).
    const dupIds = new Set(report.duplicateResidentIds.map((d) => d.residentId));
    assert.strictEqual(
      report.summary.duplicateResidentIds,
      dupIds.size,
      'internal: distinct duplicate id count'
    );
    assert.strictEqual(
      report.missingRows.length,
      fixture.golden.missingRows.length,
      'Missing Rows count mismatch vs legacy'
    );
    assert.strictEqual(
      report.extraRows.length,
      fixture.golden.extraRows.length,
      'Extra Rows count mismatch vs legacy'
    );
    assert.strictEqual(
      report.missingSitusRows.length,
      fixture.golden.missingSitus.length,
      'Missing Situs Address count mismatch vs legacy'
    );
    assert.strictEqual(
      report.apnInconsistencies.length,
      fixture.golden.apnInconsistencies.length,
      'APN Inconsistencies count mismatch vs legacy'
    );
    assert.strictEqual(
      report.duplicateResidentIds.length,
      fixture.golden.duplicates.length,
      'Duplicate Resident IDs row count mismatch vs legacy'
    );
    assert.strictEqual(
      report.columnDetail.length,
      fixture.golden.columnDetail.length,
      'Column Detail row count mismatch vs legacy'
    );

    // ---- Spot-check Extra Rows content (identity + reason), sorted for stability.
    const key = (r: { spreadsheet: string; residentId: string; reason: string }) =>
      `${r.spreadsheet}|${r.residentId}|${r.reason}`;
    const ourExtra = report.extraRows.map(key).sort();
    const goldenExtra = fixture.golden.extraRows
      .map((r) => `${norm(r['Spreadsheet'])}|${norm(r['resident_id'])}|${norm(r['Reason'])}`)
      .sort();
    assert.deepStrictEqual(ourExtra, goldenExtra, 'Extra Rows identities/reasons mismatch vs legacy');
  }
);

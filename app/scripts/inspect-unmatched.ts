// Read-only: list captain-sheet residents whose resident_id is absent from the
// master copy, and try to tell genuine new people apart from data problems
// (blank/malformed ids, whitespace or case drift, or a name that already
// exists on the master under a different id).
//
// Run with: npx tsx scripts/inspect-unmatched.ts

import * as db from '../src/db';
import * as google from '../src/google';
import { trimHeaders, type Grid } from '../src/lib/mergeEngine';

const SAFE_COPY_TARGET_KEY = 'safe_copy_execution_target';

interface SafeCopyTarget {
  masterSpreadsheetId: string;
  masterTab: string;
  captainSpreadsheetId: string;
  captainTab: string;
  masterName: string;
  captainName: string;
}

async function main(): Promise<void> {
  db.init();
  const raw = db.getSetting(SAFE_COPY_TARGET_KEY, '');
  if (!raw) throw new Error('No safe copy target is configured.');
  const target = JSON.parse(raw) as SafeCopyTarget;

  const [master, captain] = await Promise.all([
    read(target.masterSpreadsheetId, target.masterTab),
    read(target.captainSpreadsheetId, target.captainTab),
  ]);
  console.log(`master:  ${target.masterName} / ${target.masterTab} (${master.length - 1} rows)`);
  console.log(`captain: ${target.captainName} / ${target.captainTab} (${captain.length - 1} rows)\n`);

  const masterHeaders = trimHeaders(master[0]);
  const captainHeaders = trimHeaders(captain[0]);
  const mIdCol = masterHeaders.indexOf('resident_id');
  const cIdCol = captainHeaders.indexOf('resident_id');

  const masterIds = new Set<string>();
  const masterLooseIds = new Map<string, string>();
  const masterNames = new Map<string, string>();
  for (let r = 1; r < master.length; r++) {
    const id = text(master[r]?.[mIdCol]);
    if (!id) continue;
    masterIds.add(id);
    masterLooseIds.set(id.toLowerCase().replace(/[^a-z0-9]/g, ''), id);
    const name = field(master[r], masterHeaders, ['Resident Name']);
    if (name) masterNames.set(name.toLowerCase(), id);
  }

  const blanks: number[] = [];
  const unmatched: Array<Record<string, string>> = [];
  for (let r = 1; r < captain.length; r++) {
    const row = captain[r];
    if (!row || row.every((cell) => text(cell) === '')) continue;
    const id = text(row?.[cIdCol]);
    if (!id) {
      blanks.push(r + 1);
      continue;
    }
    if (masterIds.has(id)) continue;

    const name = field(row, captainHeaders, ['Resident Name']);
    const loose = masterLooseIds.get(id.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const nameMatch = name ? masterNames.get(name.toLowerCase()) : undefined;
    unmatched.push({
      captainRow: String(r + 1),
      resident_id: id,
      idShape: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? 'uuid' : 'OTHER',
      name: name || '(blank)',
      address: field(row, captainHeaders, ['Address', 'Street Address', 'Property Address']) || '(blank)',
      zone: field(row, captainHeaders, ['ZoneName']) || '(blank)',
      verdict: loose
        ? `near-miss id on master: ${loose}`
        : nameMatch
          ? `same name on master under id ${nameMatch}`
          : 'looks like a new person',
    });
  }

  console.log(`Captain rows with a blank resident_id (skipped entirely): ${blanks.length}`);
  if (blanks.length > 0) console.log(`  rows: ${blanks.join(', ')}\n`);

  console.log(`Captain residents absent from the master: ${unmatched.length}\n`);
  for (const row of unmatched) {
    console.log(`row ${row.captainRow.padStart(5)}  ${row.resident_id}  [${row.idShape}]`);
    console.log(`         name: ${row.name}`);
    console.log(`      address: ${row.address}`);
    console.log(`         zone: ${row.zone}`);
    console.log(`      verdict: ${row.verdict}\n`);
  }

  // The configured master tab is a dated join snapshot. Anyone "missing" from
  // it may still be on the raw master tab, which would make these stale-join
  // rows rather than new people.
  const rawTab = 'Master Data File';
  if (rawTab !== target.masterTab) {
    const rawGrid = await read(target.masterSpreadsheetId, rawTab);
    const rawHeaders = trimHeaders(rawGrid[0]);
    const rawIdCol = rawHeaders.indexOf('resident_id');
    const rawIds = new Set<string>();
    for (let r = 1; r < rawGrid.length; r++) {
      const id = text(rawGrid[r]?.[rawIdCol]);
      if (id) rawIds.add(id);
    }
    const onRaw = unmatched.filter((row) => rawIds.has(row.resident_id));
    console.log(`--- cross-check against the raw "${rawTab}" tab (${rawGrid.length - 1} rows) ---`);
    console.log(`${onRaw.length} of ${unmatched.length} are already on the raw master tab.`);
    for (const row of onRaw) console.log(`  ${row.resident_id}  ${row.name}`);
    console.log('');
  }

  // A shared name could be one person re-keyed under a new id, or two people
  // who happen to share a name. The property (APN / house + street) decides it.
  const collisions = unmatched.filter((row) => row.verdict.startsWith('same name on master'));
  if (collisions.length > 0) {
    console.log('--- name collisions: same person or coincidence? ---');
    for (const row of collisions) {
      const masterId = row.verdict.replace('same name on master under id ', '');
      const masterRow = master.find((candidate, index) => index > 0 && text(candidate?.[mIdCol]) === masterId);
      const captainRow = captain[Number(row.captainRow) - 1];
      const captainProperty = property(captainRow, captainHeaders);
      const masterProperty = property(masterRow, masterHeaders);
      console.log(`\n${row.name}`);
      console.log(`  captain ${row.resident_id}: ${captainProperty}`);
      console.log(`  master  ${masterId}: ${masterProperty}`);
      console.log(`  => ${captainProperty === masterProperty ? 'SAME PROPERTY (likely a duplicate person)' : 'different property'}`);
    }
    console.log('');
  }

  // What do these rows actually carry? Print every non-blank cell for a sample.
  console.log('--- every non-blank cell on the first 3 unmatched rows ---');
  for (const row of unmatched.slice(0, 3)) {
    const grid = captain[Number(row.captainRow) - 1] || [];
    console.log(`\nrow ${row.captainRow}:`);
    captainHeaders.forEach((header, index) => {
      const value = text(grid[index]);
      if (value) console.log(`  ${header}: ${value}`);
    });
  }
}

async function read(spreadsheetId: string, tab: string): Promise<Grid> {
  return (await google.readValues(spreadsheetId, google.a1Range(tab, 'A:ZZ'))) as Grid;
}

function text(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

function property(row: Grid[number] | undefined, headers: string[]): string {
  const apn = field(row, headers, ['APN']);
  const house = field(row, headers, ['House', '_SitusHouseNo']);
  const street = field(row, headers, ['Street', '_SitusStreet']);
  return `${house} ${street}`.trim() + (apn ? ` (APN ${apn})` : '');
}

function field(row: Grid[number] | undefined, headers: string[], candidates: string[]): string {
  for (const candidate of candidates) {
    const index = headers.indexOf(candidate);
    if (index !== -1) {
      const value = text(row?.[index]);
      if (value) return value;
    }
  }
  return '';
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

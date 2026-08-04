// Read-only: run planPullNewResidents against the configured safe copies and
// print how each captain-created resident is classified.
//
// Run with: npx tsx scripts/preview-new-residents.ts

import * as db from '../src/db';
import * as google from '../src/google';
import { trimHeaders, type Grid } from '../src/lib/mergeEngine';
import { planPullNewResidents } from '../src/lib/pullEngine';

const SAFE_COPY_TARGET_KEY = 'safe_copy_execution_target';

async function main(): Promise<void> {
  db.init();
  const raw = db.getSetting(SAFE_COPY_TARGET_KEY, '');
  if (!raw) throw new Error('No safe copy target is configured.');
  const target = JSON.parse(raw) as {
    masterSpreadsheetId: string;
    masterTab: string;
    captainSpreadsheetId: string;
    captainTab: string;
    masterName: string;
    captainName: string;
  };

  const [master, captain] = await Promise.all([
    read(target.masterSpreadsheetId, target.masterTab),
    read(target.captainSpreadsheetId, target.captainTab),
  ]);
  const plan = planPullNewResidents(master, captain);

  console.log(`${target.captainName} → ${target.masterName} / ${target.masterTab}`);
  console.log(`master rows: ${master.length - 1}, captain rows: ${captain.length - 1}`);
  console.log(`master headers: ${trimHeaders(master[0]).length}, captain-only columns: ${plan.columnsOnlyOnCaptain.length}`);
  if (plan.columnsOnlyOnCaptain.length > 0) {
    console.log(`  dropped (not on master): ${plan.columnsOnlyOnCaptain.join(', ')}`);
  }
  if (plan.errors.length > 0) console.log(`errors: ${plan.errors.join('; ')}`);
  console.log('');

  const byRisk = { likely: 0, possible: 0, none: 0 };
  for (const candidate of plan.candidates) byRisk[candidate.risk]++;
  console.log(`candidates: ${plan.candidates.length}  (likely dup ${byRisk.likely}, possible ${byRisk.possible}, clean ${byRisk.none})\n`);

  for (const candidate of plan.candidates) {
    const flag = candidate.risk === 'none' ? 'CLEAN   ' : candidate.risk === 'likely' ? 'LIKELY  ' : 'POSSIBLE';
    console.log(`${flag} row ${String(candidate.captainRow).padStart(4)}  ${candidate.residentName || '(no name)'}`);
    console.log(`         ${candidate.property || '(no property)'}  ·  ${candidate.filledColumns} filled column(s)`);
    if (candidate.riskReason) console.log(`         ${candidate.riskReason} (${candidate.matchedResidentId})`);
    if (candidate.missingRequired.length > 0) {
      console.log(`         missing required: ${candidate.missingRequired.join(', ')}`);
    }
  }

  if (plan.skipped.length > 0) {
    console.log(`\nskipped: ${plan.skipped.length}`);
    for (const skip of plan.skipped) console.log(`  ${skip.reason}`);
  }
}

async function read(spreadsheetId: string, tab: string): Promise<Grid> {
  return (await google.readValues(spreadsheetId, google.a1Range(tab, 'A:ZZ'))) as Grid;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

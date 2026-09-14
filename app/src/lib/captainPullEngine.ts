import { createHash } from 'node:crypto';
import {
  fingerprintPullChanges,
  planPullToMaster,
  type PullCellChange,
  type PullToMasterOptions,
  type PullToMasterPlan,
  type UnmatchedResident,
} from './pullEngine';
import type { Grid } from './mergeEngine';

export interface CaptainPullSheetRef {
  spreadsheetId: string;
  spreadsheetName: string;
  tabName: string;
  url: string;
}

export interface CaptainPullSheetInput extends CaptainPullSheetRef {
  grid: Grid;
}

export interface PullFolderSheetPlan extends CaptainPullSheetRef {
  fills: number;
  overwrites: number;
  conflicts: number;
  unmatched: number;
  errors: string[];
  sheetFingerprint: string;
}

export interface PullConflictRecord {
  change: PullCellChange;
  sourceSpreadsheetId: string;
  sourceSpreadsheetName: string;
  sourceTabName: string;
  crossSheetDisagreement?: boolean;
}

export interface FolderPullToMasterPlan {
  fills: PullCellChange[];
  overwrites: PullCellChange[];
  conflicts: PullCellChange[];
  conflictRecords: PullConflictRecord[];
  unmatchedResidents: UnmatchedResident[];
  errors: string[];
  fingerprint: string;
  sheets: PullFolderSheetPlan[];
}

export interface AttributedPullChange extends PullCellChange {
  sourceSpreadsheetId: string;
  sourceSpreadsheetName: string;
  sourceTabName: string;
  action: 'fill' | 'overwrite';
}

const MAPBOX_ASSIGNMENT_CANONICALS = ['ZoneName', 'NC Name', 'NC Phone', 'NC Email'];

function hashParts(parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? '')).digest('hex').slice(0, 16);
}

export function pullSheetFingerprint(spreadsheetId: string, plan: PullToMasterPlan): string {
  const parts = [
    ...plan.fills.map(
      (change) => `f:${change.residentId}:${change.column}:${hashValue(change.captainValue)}`
    ),
    ...plan.overwrites.map(
      (change) => `o:${change.residentId}:${change.column}:${hashValue(change.captainValue)}`
    ),
    ...plan.conflicts.map(
      (change) =>
        `c:${change.residentId}:${change.column}:${change.masterNormalized}:${change.captainNormalized}`
    ),
  ].sort();
  return hashParts([spreadsheetId, ...parts]);
}

export function fingerprintPullFolderSheets(sheets: PullFolderSheetPlan[]): string {
  const parts = sheets
    .filter((sheet) => sheet.fills + sheet.overwrites > 0 || sheet.conflicts > 0)
    .map((sheet) => `${sheet.spreadsheetId}:${sheet.sheetFingerprint}`)
    .sort();
  return hashParts(parts);
}

export function fingerprintSelectedPullFolder(
  sheets: PullFolderSheetPlan[],
  spreadsheetIds: string[]
): string {
  const selected = new Set(spreadsheetIds);
  return fingerprintPullFolderSheets(sheets.filter((sheet) => selected.has(sheet.spreadsheetId)));
}

/** Force Mapbox-owned zone/captain-assignment columns to never during folder pull. */
export function applyMapboxAssignmentNeverPolicies(
  policies: Record<string, string>,
  headers: string[]
): Record<string, string> {
  const next = { ...policies };
  for (const canonical of MAPBOX_ASSIGNMENT_CANONICALS) {
    if (headers.includes(canonical)) next[canonical] = 'never';
  }
  return next;
}

/**
 * Plan a folder-wide captain → master pull. Runs planPullToMaster per sheet, then
 * merges proposed writes. Cross-sheet agreement on the same resident+column becomes
 * one write; disagreement becomes a conflict instead of a guess.
 */
export function planFolderPullToMaster(
  masterGrid: Grid,
  captainSheets: CaptainPullSheetInput[],
  options: PullToMasterOptions = {}
): FolderPullToMasterPlan {
  const plan: FolderPullToMasterPlan = {
    fills: [],
    overwrites: [],
    conflicts: [],
    conflictRecords: [],
    unmatchedResidents: [],
    errors: [],
    fingerprint: fingerprintPullChanges([]),
    sheets: [],
  };

  const sheetPlans: Array<{ sheet: CaptainPullSheetInput; sheetPlan: PullToMasterPlan }> = [];
  for (const sheet of captainSheets) {
    const sheetPlan = planPullToMaster(masterGrid, sheet.grid, options);
    sheetPlans.push({ sheet, sheetPlan });
    plan.errors.push(...sheetPlan.errors.map((error) => `${sheet.spreadsheetName}: ${error}`));
    plan.sheets.push({
      spreadsheetId: sheet.spreadsheetId,
      spreadsheetName: sheet.spreadsheetName,
      tabName: sheet.tabName,
      url: sheet.url,
      fills: sheetPlan.fills.length,
      overwrites: sheetPlan.overwrites.length,
      conflicts: sheetPlan.conflicts.length,
      unmatched: sheetPlan.unmatchedResidents.length,
      errors: sheetPlan.errors,
      sheetFingerprint: pullSheetFingerprint(sheet.spreadsheetId, sheetPlan),
    });
    for (const unmatched of sheetPlan.unmatchedResidents) {
      if (!plan.unmatchedResidents.some((entry) => entry.residentId === unmatched.residentId)) {
        plan.unmatchedResidents.push(unmatched);
      }
    }
  }

  for (const { sheet, sheetPlan } of sheetPlans) {
    for (const change of sheetPlan.conflicts) {
      plan.conflictRecords.push({
        change,
        sourceSpreadsheetId: sheet.spreadsheetId,
        sourceSpreadsheetName: sheet.spreadsheetName,
        sourceTabName: sheet.tabName,
      });
    }
  }

  const writesByKey = new Map<string, AttributedPullChange[]>();
  for (const { sheet, sheetPlan } of sheetPlans) {
    for (const change of sheetPlan.fills) {
      const key = `${change.residentId}\u0000${change.column}`;
      const list = writesByKey.get(key) ?? [];
      list.push({
        ...change,
        sourceSpreadsheetId: sheet.spreadsheetId,
        sourceSpreadsheetName: sheet.spreadsheetName,
        sourceTabName: sheet.tabName,
        action: 'fill',
      });
      writesByKey.set(key, list);
    }
    for (const change of sheetPlan.overwrites) {
      const key = `${change.residentId}\u0000${change.column}`;
      const list = writesByKey.get(key) ?? [];
      list.push({
        ...change,
        sourceSpreadsheetId: sheet.spreadsheetId,
        sourceSpreadsheetName: sheet.spreadsheetName,
        sourceTabName: sheet.tabName,
        action: 'overwrite',
      });
      writesByKey.set(key, list);
    }
  }

  const crossSheetConflictKeys = new Set<string>();
  for (const [key, proposals] of writesByKey) {
    if (proposals.length === 1) {
      const only = proposals[0];
      if (only.action === 'fill') plan.fills.push(only);
      else plan.overwrites.push(only);
      continue;
    }

    proposals.sort((left, right) => left.sourceSpreadsheetId.localeCompare(right.sourceSpreadsheetId));
    const normalized = new Set(proposals.map((proposal) => proposal.captainNormalized));
    if (normalized.size === 1) {
      const winner = proposals[0];
      if (winner.action === 'fill') plan.fills.push(winner);
      else plan.overwrites.push(winner);
      continue;
    }

    const first = proposals[0];
    const disagreeingSheets = proposals.map((proposal) => proposal.sourceSpreadsheetName).join(', ');
    const crossConflict: PullCellChange = {
      ...first,
      captainValue: first.captainValue,
      captainNormalized: first.captainNormalized,
      suspectedTextCoercion: proposals.some((proposal) => proposal.suspectedTextCoercion),
    };
    plan.conflicts.push(crossConflict);
    crossSheetConflictKeys.add(key);
    plan.conflictRecords.push({
      change: crossConflict,
      sourceSpreadsheetId: first.sourceSpreadsheetId,
      sourceSpreadsheetName: first.sourceSpreadsheetName,
      sourceTabName: first.sourceTabName,
      crossSheetDisagreement: true,
    });
    plan.errors.push(
      `Captains disagree on ${first.column} for resident ${first.residentId} (${disagreeingSheets}). Logged as a conflict instead of writing.`
    );
  }

  for (const record of plan.conflictRecords) {
    if (crossSheetConflictKeys.has(`${record.change.residentId}\u0000${record.change.column}`)) {
      if (!record.crossSheetDisagreement) continue;
    }
    if (
      !plan.conflicts.some(
        (conflict) =>
          conflict.residentId === record.change.residentId && conflict.column === record.change.column
      )
    ) {
      plan.conflicts.push(record.change);
    }
  }

  plan.fingerprint = fingerprintPullChanges([...plan.fills, ...plan.overwrites]);
  plan.sheets.sort(
    (left, right) =>
      left.spreadsheetId.localeCompare(right.spreadsheetId) ||
      left.spreadsheetName.localeCompare(right.spreadsheetName)
  );
  return plan;
}

export function replanPullToMasterSheet(
  masterGrid: Grid,
  captainGrid: Grid,
  options: PullToMasterOptions = {}
): PullToMasterPlan {
  return planPullToMaster(masterGrid, captainGrid, options);
}

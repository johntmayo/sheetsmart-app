import * as db from './db';
import * as google from './google';
import type { JobContext } from './jobs';
import { registerTask } from './jobs';
import { planPushMissingResidents, trimHeaders, type Grid } from './lib/mergeEngine';
import {
  ensureHeaderColumns,
  planAppendRevert,
  planCellRevert,
  planGuardedAppends,
  planGuardedDeletes,
  planGuardedMoves,
  planGuardedCellWrites,
  planRowRestores,
  type AppendSnapshot,
  type CellSnapshot,
} from './lib/liveWriteEngine';
import {
  fingerprintCaptainMoves,
  planCaptainSheetMoves,
  planZoneEnrichment,
  type ZoneReconcileConfig,
} from './lib/zoneEngine';
import {
  fingerprintPullCells,
  newResidentCellKeys,
  planPullNewResidents,
  planPullToMaster,
  pullCellValueKey,
  type PullCellChange,
  type PullCellKey,
} from './lib/pullEngine';
import { cellValuesEqual } from './lib/values';
import { fetchZoneFeatures, isMapboxConfigured, DEFAULT_MAPBOX_USERNAME, DEFAULT_MAPBOX_DATASET_ID } from './mapbox';
import { detectSheetZone, findColumn } from './lib/columns';
import type { CellValue } from './lib/values';

export const PUSH_MISSING_COPY_TASK = 'push_missing_copy';
export const REVERT_APPEND_COPY_TASK = 'revert_append_copy';
export const ENRICH_ZONES_COPY_TASK = 'enrich_zones_copy';
export const REVERT_CELL_COPY_TASK = 'revert_cell_copy';
export const MOVE_RESIDENTS_COPY_TASK = 'move_residents_copy';
export const REVERT_MOVE_COPY_TASK = 'revert_move_copy';
export const PULL_TO_MASTER_COPY_TASK = 'pull_to_master_copy';
export const APPLY_CONFLICT_COPY_TASK = 'apply_conflict_copy';
export const PULL_NEW_RESIDENTS_COPY_TASK = 'pull_new_residents_copy';

/** Hard refuse: never enrich the production master spreadsheet. */
export const PRODUCTION_MASTER_SPREADSHEET_ID = '1dW7oC9VlGBEfeHhl2zeq2_Td8c6QoYwjTxoqAn-3p6w';
export const DEFAULT_ENRICHMENT_TAB = 'Master Data File';

export interface SafeCopyTarget {
  masterSpreadsheetId: string;
  masterTab: string;
  captainSpreadsheetId: string;
  captainTab: string;
  folderId: string;
  masterName: string;
  captainName: string;
}

export interface PushMissingPreviewPlan {
  kind: 'push_missing_copy_preview';
  target: SafeCopyTarget;
  expectedResidentIds: string[];
  appended: number;
  flagged: number;
  detectedZone: string;
  generatedAt: string;
  appliedRunId?: number;
}

export interface EnrichZonesPreviewPlan {
  kind: 'enrich_zones_copy_preview';
  target: SafeCopyTarget;
  enrichmentTab: string;
  columnsToAdd: string[];
  fingerprint: string;
  cellsToFill: number;
  residentsTouched: number;
  generatedAt: string;
  appliedRunId?: number;
}

export interface MoveCopyTarget {
  masterSpreadsheetId: string;
  masterTab: string;
  fromCaptainSpreadsheetId: string;
  fromCaptainTab: string;
  toCaptainSpreadsheetId: string;
  toCaptainTab: string;
  folderId: string;
  masterName: string;
  fromCaptainName: string;
  toCaptainName: string;
  fromZoneOverride: string;
  toZoneOverride: string;
}

export interface MoveResidentsPreviewPlan {
  kind: 'move_residents_copy_preview';
  target: MoveCopyTarget;
  fromZone: string;
  toZone: string;
  destinationFields: Record<string, string>;
  expectedResidentIds: string[];
  fingerprint: string;
  generatedAt: string;
  appliedRunId?: number;
}

export interface PullToMasterPreviewPlan {
  kind: 'pull_to_master_copy_preview';
  target: SafeCopyTarget;
  expectedCells: PullCellKey[];
  fingerprint: string;
  conflicts: number;
  generatedAt: string;
  appliedRunId?: number;
}

export interface NewResidentsPreviewPlan {
  kind: 'pull_new_residents_copy_preview';
  target: SafeCopyTarget;
  expectedRows: PullCellKey[];
  fingerprint: string;
  flaggedCount: number;
  generatedAt: string;
  appliedRunId?: number;
}

/** Everything the Conflict Inbox needs to write one approved value back. */
export interface ConflictContext {
  kind: 'pull_to_master';
  spreadsheetId: string;
  spreadsheetName: string;
  tabName: string;
  residentId: string;
  residentName: string;
  column: string;
  masterRow: number;
  masterValue: string;
  captainValue: string;
  sourceSpreadsheetId: string;
  sourceName: string;
  sourceTab: string;
}

interface ConflictRow {
  id: number;
  status: string;
  column: string;
  resident_id: string;
  existing_value: string;
  incoming_value: string;
  context_json: string;
}

interface SnapshotRow {
  id: number;
  spreadsheet_id: string;
  spreadsheet_name: string;
  tab_name: string;
  resident_id: string;
  after_json: string;
}

interface CellSnapshotRow {
  id: number;
  spreadsheet_id: string;
  spreadsheet_name: string;
  tab_name: string;
  resident_id: string;
  range_a1: string;
  before_json: string;
  after_json: string;
  metadata_json: string;
}

export function registerExecutionTasks(): void {
  registerTask(PUSH_MISSING_COPY_TASK, pushMissingCopy);
  registerTask(REVERT_APPEND_COPY_TASK, revertAppendCopy);
  registerTask(ENRICH_ZONES_COPY_TASK, enrichZonesCopy);
  registerTask(REVERT_CELL_COPY_TASK, revertCellCopy);
  registerTask(MOVE_RESIDENTS_COPY_TASK, moveResidentsCopy);
  registerTask(REVERT_MOVE_COPY_TASK, revertMoveCopy);
  registerTask(PULL_TO_MASTER_COPY_TASK, pullToMasterCopy);
  registerTask(APPLY_CONFLICT_COPY_TASK, applyConflictCopy);
  registerTask(PULL_NEW_RESIDENTS_COPY_TASK, pullNewResidentsCopy);
}

/**
 * Append captain-created residents to the master copy as brand-new rows.
 * Only the identities the Operator ticked are appended, and only if the rows
 * still look exactly as they did in the preview.
 */
async function pullNewResidentsCopy(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const previewRunId = numberParam(ctx.params.previewRunId, 'previewRunId');
  const target = parseTarget(ctx.params.target);
  const expectedFingerprint = String(ctx.params.fingerprint || '').trim();
  const approvedIds = stringArray(ctx.params.expectedResidentIds);
  if (!expectedFingerprint) throw new Error('Approved new-resident fingerprint is missing.');
  if (approvedIds.length === 0) throw new Error('No residents were approved.');
  assertCopyMaster(target.masterSpreadsheetId);
  assertNotProductionSheet(target.captainSpreadsheetId, 'captain');

  ctx.reportProgress({ stage: 'reading', message: 'Rechecking the master copy and captain copy before adding anyone.' });
  const [masterGrid, captainGrid] = await Promise.all([
    readGrid(target.masterSpreadsheetId, target.masterTab),
    readGrid(target.captainSpreadsheetId, target.captainTab),
  ]);
  const plan = planPullNewResidents(masterGrid, captainGrid);
  if (plan.errors.length > 0) throw new Error(plan.errors.join('; '));

  const approvedSet = new Set(approvedIds);
  const approved = plan.candidates.filter((candidate) => approvedSet.has(candidate.residentId));
  const freshFingerprint = fingerprintPullCells(newResidentCellKeys(approved));
  if (approved.length !== approvedIds.length || freshFingerprint !== expectedFingerprint) {
    throw new Error(
      'The captain copy or master copy changed after the preview. Nobody was added. Please run a fresh preview and approve that result.'
    );
  }

  const guarded = planGuardedAppends(
    masterGrid,
    approved.map((candidate) => candidate.row)
  );
  if (guarded.errors.length > 0) throw new Error(guarded.errors.join('; '));
  if (guarded.appends.length !== approved.length) {
    throw new Error(
      `Only ${guarded.appends.length} of ${approved.length} approved resident(s) still pass the write guard. Nobody was added.`
    );
  }

  const headers = trimHeaders(masterGrid[0]);
  const riskById = new Map(approved.map((candidate) => [candidate.residentId, candidate]));
  const snapshotIds: number[] = [];
  const insertSnapshots = db.transaction(() => {
    for (const append of guarded.appends) {
      const candidate = riskById.get(append.residentId);
      const result = db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, ?, ?, 'row_append', ?, '', 'null', ?, ?)`,
        [
          ctx.runId,
          target.masterSpreadsheetId,
          target.masterName,
          target.masterTab,
          append.residentId,
          JSON.stringify(append.row),
          JSON.stringify({
            kind: 'new_resident_append',
            previewRunId,
            headers,
            sourceSheet: target.captainName,
            captainRow: candidate?.captainRow ?? null,
            risk: candidate?.risk ?? 'none',
          }),
        ]
      );
      snapshotIds.push(Number(result.lastInsertRowid));
    }
  });
  insertSnapshots();

  ctx.reportProgress({
    stage: 'writing',
    message: `Adding ${guarded.appends.length} captain-created resident(s) to the master copy.`,
  });
  const result = await google.appendValues(
    target.masterSpreadsheetId,
    google.a1Range(target.masterTab, 'A:ZZ'),
    guarded.appends.map((append) => append.row)
  );
  if (result.updatedRows !== guarded.appends.length) {
    throw new Error(
      `Google reported ${result.updatedRows} appended row(s), but ${guarded.appends.length} were approved. The run was stopped for review.`
    );
  }
  if (snapshotIds.length > 0) {
    const placeholders = snapshotIds.map(() => '?').join(',');
    db.run(`UPDATE run_snapshots SET range_a1 = ? WHERE id IN (${placeholders})`, [
      result.updatedRange,
      ...snapshotIds,
    ]);
  }

  for (const append of guarded.appends) {
    const candidate = riskById.get(append.residentId);
    ctx.log({
      spreadsheet: target.masterName,
      row: result.updatedRange,
      resident_id: append.residentId,
      type: 'append',
      incoming_value: candidate?.residentName || 'New resident row',
      message: `Added ${candidate?.residentName || append.residentId} to the master copy from ${target.captainName} row ${
        candidate?.captainRow ?? '?'
      }.`,
    });
    if (candidate && candidate.risk !== 'none') {
      ctx.log({
        spreadsheet: target.masterName,
        resident_id: append.residentId,
        type: 'sensitive',
        existing_value: candidate.matchedResidentId,
        message: `Approved despite a ${candidate.risk} duplicate warning: ${candidate.riskReason}`,
      });
    }
  }

  return {
    previewRunId,
    targetSpreadsheet: target.masterName,
    targetTab: target.masterTab,
    sourceSpreadsheet: target.captainName,
    appended: guarded.appends.length,
    flagged: approved.filter((candidate) => candidate.risk !== 'none').length,
    updatedRange: result.updatedRange,
    revertAvailable: true,
  };
}

/**
 * Field Dictionary policies keyed by the header they resolve to on this sheet.
 * A column the dictionary does not know stays unlisted, so the pull planner's
 * conflict-only default applies to it.
 */
export function pullPoliciesForHeaders(headers: string[]): Record<string, string> {
  const policies: Record<string, string> = {};
  const fields = db.all<{ id: number; canonical_name: string; default_policy: string }>(
    'SELECT id, canonical_name, default_policy FROM dictionary_fields'
  );
  for (const field of fields) {
    const aliases = db
      .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id = ?', [field.id])
      .map((row) => row.alias);
    const header = findColumn(headers, [field.canonical_name, ...aliases]);
    if (header) policies[header] = field.default_policy;
  }
  return policies;
}

export function pullCellKeys(changes: PullCellChange[]): PullCellKey[] {
  return changes.map((change) => ({
    residentId: change.residentId,
    column: change.column,
    value: pullCellValueKey(change.captainValue),
  }));
}

async function pullToMasterCopy(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const previewRunId = numberParam(ctx.params.previewRunId, 'previewRunId');
  const target = parseTarget(ctx.params.target);
  const expectedFingerprint = String(ctx.params.fingerprint || '').trim();
  const approvedCells = parseCellKeys(ctx.params.approvedCells);
  if (!expectedFingerprint) throw new Error('Approved pull fingerprint is missing.');
  assertCopyMaster(target.masterSpreadsheetId);
  assertNotProductionSheet(target.captainSpreadsheetId, 'captain');

  ctx.reportProgress({ stage: 'reading', message: 'Rechecking the master copy and captain copy before writing.' });
  const [masterGrid, captainGrid] = await Promise.all([
    readGrid(target.masterSpreadsheetId, target.masterTab),
    readGrid(target.captainSpreadsheetId, target.captainTab),
  ]);
  const policies = pullPoliciesForHeaders(trimHeaders(masterGrid[0]));
  const plan = planPullToMaster(masterGrid, captainGrid, { policies });
  if (plan.errors.length > 0) throw new Error(plan.errors.join('; '));

  const approvedKeys = new Set(approvedCells.map((cell) => `${cell.residentId}\u0000${cell.column}`));
  const approvedChanges = [...plan.fills, ...plan.overwrites].filter((change) =>
    approvedKeys.has(`${change.residentId}\u0000${change.column}`)
  );
  const freshFingerprint = fingerprintPullCells(pullCellKeys(approvedChanges));
  if (approvedChanges.length !== approvedCells.length || freshFingerprint !== expectedFingerprint) {
    throw new Error(
      'The captain copy or master copy changed after the preview. Nothing was written. Please run a fresh preview and approve that result.'
    );
  }

  const recorded = recordPullConflicts(ctx.runId, target, plan.conflicts);

  if (approvedChanges.length === 0) {
    ctx.log({
      spreadsheet: target.masterName,
      type: 'pull_to_master',
      message: `No cells were approved for writing. Logged ${recorded} conflict(s) for review.`,
    });
    return {
      previewRunId,
      targetSpreadsheet: target.masterName,
      cellsWritten: 0,
      conflictsLogged: recorded,
      message:
        recorded > 0
          ? `Nothing was written. ${recorded} disagreement(s) are waiting in the Conflict inbox.`
          : 'Nothing needed to be written.',
    };
  }

  const guarded = planGuardedCellWrites(
    masterGrid,
    approvedChanges.map((change) => ({
      residentId: change.residentId,
      column: change.column,
      value: change.captainValue,
      policy: change.policy,
    }))
  );
  if (guarded.errors.length > 0) throw new Error(guarded.errors.join('; '));
  if (guarded.writes.length !== approvedChanges.length) {
    throw new Error(
      `Only ${guarded.writes.length} of ${approvedChanges.length} approved cell(s) still pass the write guard. Nothing was written. Please run a fresh preview.`
    );
  }

  const insertSnapshots = db.transaction(() => {
    for (const write of guarded.writes) {
      const range = google.a1Range(target.masterTab, `${google.columnLetter(write.col - 1)}${write.row}`);
      db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, ?, ?, 'cell_update', ?, ?, ?, ?, ?)`,
        [
          ctx.runId,
          target.masterSpreadsheetId,
          target.masterName,
          target.masterTab,
          write.residentId,
          range,
          JSON.stringify(write.before ?? ''),
          JSON.stringify(write.after ?? ''),
          JSON.stringify({ kind: 'pull_to_master', column: write.column, previewRunId }),
        ]
      );
    }
  });
  insertSnapshots();

  ctx.reportProgress({
    stage: 'writing',
    message: `Writing ${guarded.writes.length.toLocaleString()} approved captain value(s) to the master copy.`,
  });
  const updatedCells = await google.updateValuesChunked(
    target.masterSpreadsheetId,
    guarded.writes.map((write) => ({
      range: google.a1Range(target.masterTab, `${google.columnLetter(write.col - 1)}${write.row}`),
      values: [[write.after]],
    }))
  );

  for (const write of guarded.writes) {
    ctx.log({
      spreadsheet: target.masterName,
      row: write.row,
      column: write.column,
      resident_id: write.residentId,
      type: write.action === 'overwrite' ? 'overwrite' : 'fill',
      existing_value: String(write.before ?? ''),
      incoming_value: String(write.after ?? ''),
      message: `Pulled ${write.column} from ${target.captainName} into the master copy.`,
    });
  }

  return {
    previewRunId,
    targetSpreadsheet: target.masterName,
    targetTab: target.masterTab,
    sourceSpreadsheet: target.captainName,
    cellsWritten: guarded.writes.length,
    residentsTouched: new Set(guarded.writes.map((write) => write.residentId)).size,
    conflictsLogged: recorded,
    updatedCells,
    revertAvailable: true,
  };
}

/**
 * Write one or more Conflict Inbox decisions (take the captain value) to the
 * master copy. Each cell is snapshotted, so the whole batch is undoable.
 */
async function applyConflictCopy(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const conflictIds = Array.isArray(ctx.params.conflictIds)
    ? ctx.params.conflictIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  if (conflictIds.length === 0) throw new Error('No conflicts were selected.');

  const placeholders = conflictIds.map(() => '?').join(',');
  const conflicts = db.all<ConflictRow>(
    `SELECT id, status, "column", resident_id, existing_value, incoming_value, context_json
     FROM conflicts WHERE id IN (${placeholders}) ORDER BY id`,
    conflictIds
  );
  const open = conflicts.filter((conflict) => conflict.status === 'open');
  if (open.length === 0) throw new Error('Those conflicts are no longer open.');

  const groups = new Map<string, { context: ConflictContext; rows: ConflictRow[] }>();
  for (const conflict of open) {
    const context = parseConflictContext(conflict.context_json);
    if (!context) {
      ctx.log({
        resident_id: conflict.resident_id,
        column: conflict.column,
        type: 'skip',
        message: 'This conflict predates one-click resolution and has to be handled by hand.',
      });
      continue;
    }
    const key = `${context.spreadsheetId}\u0000${context.tabName}`;
    const group = groups.get(key) ?? { context, rows: [] };
    group.rows.push(conflict);
    groups.set(key, group);
  }
  if (groups.size === 0) throw new Error('None of the selected conflicts carry enough context to apply.');

  let written = 0;
  let stale = 0;
  let skipped = 0;

  for (const group of groups.values()) {
    const { context } = group;
    assertCopyMaster(context.spreadsheetId);
    ctx.reportProgress({ stage: 'reading', message: `Rechecking ${context.spreadsheetName} before writing.` });
    const grid = await readGrid(context.spreadsheetId, context.tabName);
    const headers = trimHeaders(grid[0]);

    const applicable: ConflictRow[] = [];
    for (const conflict of group.rows) {
      const conflictContext = parseConflictContext(conflict.context_json);
      const column = conflictContext?.column || conflict.column;
      const colIndex = headers.indexOf(column);
      const rowIndex = findRowByResidentId(grid, headers, conflict.resident_id);
      const current = colIndex === -1 || rowIndex === -1 ? undefined : grid[rowIndex]?.[colIndex];
      if (colIndex === -1 || rowIndex === -1) {
        skipped++;
        ctx.log({
          spreadsheet: context.spreadsheetName,
          resident_id: conflict.resident_id,
          column,
          type: 'skip',
          message: 'That resident or column is no longer on the master copy.',
        });
        continue;
      }
      // Only apply when the master still holds the value we showed the Operator.
      if (!cellValuesEqual(current ?? '', conflict.existing_value)) {
        stale++;
        ctx.log({
          spreadsheet: context.spreadsheetName,
          resident_id: conflict.resident_id,
          column,
          type: 'conflict',
          existing_value: String(current ?? ''),
          incoming_value: conflict.incoming_value,
          message: 'The master value changed since this conflict was logged, so it was left alone.',
        });
        continue;
      }
      applicable.push(conflict);
    }
    if (applicable.length === 0) continue;

    const guarded = planGuardedCellWrites(
      grid,
      applicable.map((conflict) => ({
        residentId: conflict.resident_id,
        column: parseConflictContext(conflict.context_json)?.column || conflict.column,
        value: conflict.incoming_value,
        policy: 'overwrite' as const,
      }))
    );
    if (guarded.errors.length > 0) throw new Error(guarded.errors.join('; '));
    for (const item of guarded.skipped) {
      skipped++;
      ctx.log({
        spreadsheet: context.spreadsheetName,
        resident_id: item.residentId,
        column: item.column,
        type: 'skip',
        message: item.reason,
      });
    }
    if (guarded.writes.length === 0) continue;

    const insertSnapshots = db.transaction(() => {
      for (const write of guarded.writes) {
        db.run(
          `INSERT INTO run_snapshots
             (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
              range_a1, before_json, after_json, metadata_json)
           VALUES (?, ?, ?, ?, 'cell_update', ?, ?, ?, ?, ?)`,
          [
            ctx.runId,
            context.spreadsheetId,
            context.spreadsheetName,
            context.tabName,
            write.residentId,
            google.a1Range(context.tabName, `${google.columnLetter(write.col - 1)}${write.row}`),
            JSON.stringify(write.before ?? ''),
            JSON.stringify(write.after ?? ''),
            JSON.stringify({ kind: 'conflict_resolution', column: write.column }),
          ]
        );
      }
    });
    insertSnapshots();

    ctx.reportProgress({
      stage: 'writing',
      message: `Applying ${guarded.writes.length} approved captain value(s) to ${context.spreadsheetName}.`,
    });
    await google.updateValuesChunked(
      context.spreadsheetId,
      guarded.writes.map((write) => ({
        range: google.a1Range(context.tabName, `${google.columnLetter(write.col - 1)}${write.row}`),
        values: [[write.after]],
      }))
    );

    const writtenKeys = new Set(guarded.writes.map((write) => `${write.residentId}\u0000${write.column}`));
    const resolveConflicts = db.transaction(() => {
      for (const conflict of applicable) {
        const column = parseConflictContext(conflict.context_json)?.column || conflict.column;
        if (!writtenKeys.has(`${conflict.resident_id}\u0000${column}`)) continue;
        db.run("UPDATE conflicts SET status = 'resolved', resolution_notes = ? WHERE id = ?", [
          `Captain value applied by run #${ctx.runId}.`,
          conflict.id,
        ]);
      }
    });
    resolveConflicts();

    for (const write of guarded.writes) {
      written++;
      ctx.log({
        spreadsheet: context.spreadsheetName,
        row: write.row,
        column: write.column,
        resident_id: write.residentId,
        type: 'overwrite',
        existing_value: String(write.before ?? ''),
        incoming_value: String(write.after ?? ''),
        message: 'Applied the captain value after Operator approval.',
      });
    }
  }

  return {
    resolved: written,
    stale,
    skipped,
    revertAvailable: written > 0,
    message:
      stale > 0
        ? 'Some conflicts were skipped because the master value changed after they were logged.'
        : `Applied ${written} approved captain value(s).`,
  };
}

/**
 * Log pull disagreements to the Conflict Inbox, refreshing an existing open
 * entry for the same resident + column instead of piling up duplicates.
 */
function recordPullConflicts(runId: number, target: SafeCopyTarget, conflicts: PullCellChange[]): number {
  if (conflicts.length === 0) return 0;
  const existing = db.all<{ id: number; context_json: string }>(
    "SELECT id, context_json FROM conflicts WHERE status = 'open'"
  );
  const openByKey = new Map<string, number>();
  for (const row of existing) {
    const context = parseConflictContext(row.context_json);
    if (!context) continue;
    openByKey.set(`${context.spreadsheetId}\u0000${context.residentId}\u0000${context.column}`, row.id);
  }

  let recorded = 0;
  const write = db.transaction(() => {
    for (const conflict of conflicts) {
      const context: ConflictContext = {
        kind: 'pull_to_master',
        spreadsheetId: target.masterSpreadsheetId,
        spreadsheetName: target.masterName,
        tabName: target.masterTab,
        residentId: conflict.residentId,
        residentName: conflict.residentName,
        column: conflict.column,
        masterRow: conflict.masterRow,
        masterValue: String(conflict.masterValue ?? ''),
        captainValue: String(conflict.captainValue ?? ''),
        sourceSpreadsheetId: target.captainSpreadsheetId,
        sourceName: target.captainName,
        sourceTab: target.captainTab,
      };
      const key = `${target.masterSpreadsheetId}\u0000${conflict.residentId}\u0000${conflict.column}`;
      const existingId = openByKey.get(key);
      if (existingId) {
        db.run(
          `UPDATE conflicts
             SET run_id = ?, existing_value = ?, incoming_value = ?, context_json = ?
           WHERE id = ?`,
          [runId, context.masterValue, context.captainValue, JSON.stringify(context), existingId]
        );
      } else {
        db.run(
          `INSERT INTO conflicts
             (run_id, spreadsheet, "row", "column", resident_id, existing_value, incoming_value, status, context_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          [
            runId,
            target.masterName,
            String(conflict.masterRow),
            conflict.column,
            conflict.residentId,
            context.masterValue,
            context.captainValue,
            JSON.stringify(context),
          ]
        );
      }
      recorded++;
    }
  });
  write();
  return recorded;
}

function parseConflictContext(json: string): ConflictContext | null {
  try {
    const value = JSON.parse(json || '{}') as Partial<ConflictContext>;
    if (!value || value.kind !== 'pull_to_master' || !value.spreadsheetId || !value.tabName) return null;
    return value as ConflictContext;
  } catch {
    return null;
  }
}

function findRowByResidentId(grid: Grid, headers: string[], residentId: string): number {
  const idCol = headers.indexOf('resident_id');
  if (idCol === -1) return -1;
  const wanted = residentId.trim();
  for (let row = 1; row < grid.length; row++) {
    if (String(grid[row]?.[idCol] ?? '').trim() === wanted) return row;
  }
  return -1;
}

function parseCellKeys(value: unknown): PullCellKey[] {
  if (!Array.isArray(value)) throw new Error('Approved cells are missing.');
  return value.map((item) => {
    const raw = (item || {}) as Partial<PullCellKey>;
    return {
      residentId: String(raw.residentId || '').trim(),
      column: String(raw.column || '').trim(),
      value: String(raw.value ?? ''),
    };
  });
}

async function pushMissingCopy(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const previewRunId = numberParam(ctx.params.previewRunId, 'previewRunId');
  const target = parseTarget(ctx.params.target);
  const expectedResidentIds = stringArray(ctx.params.expectedResidentIds);

  ctx.reportProgress({ stage: 'reading', message: 'Rechecking both copied sheets before writing.' });
  const [masterGrid, captainGrid] = await Promise.all([
    readGrid(target.masterSpreadsheetId, target.masterTab),
    readGrid(target.captainSpreadsheetId, target.captainTab),
  ]);
  const sensitive = db
    .all<{ canonical_name: string }>('SELECT canonical_name FROM dictionary_fields WHERE is_sensitive = 1')
    .map((row) => row.canonical_name);
  const freshPlan = planPushMissingResidents(captainGrid, masterGrid, { sensitiveColumns: sensitive });
  if (freshPlan.errors.length > 0) throw new Error(freshPlan.errors.map((error) => error.message).join('; '));

  const guarded = planGuardedAppends(captainGrid, freshPlan.newRows);
  if (guarded.errors.length > 0) throw new Error(guarded.errors.join('; '));
  const freshIds = guarded.appends.map((append) => append.residentId);
  if (!sameIdentities(expectedResidentIds, freshIds)) {
    throw new Error(
      'The copied sheets changed after the preview. Nothing was written. Please run a fresh preview and approve that result.'
    );
  }

  if (guarded.appends.length === 0) {
    return {
      previewRunId,
      targetSpreadsheet: target.captainName,
      appended: 0,
      flagged: 0,
      message: 'The copy was already up to date. Nothing needed to be written.',
    };
  }

  const headers = trimHeaders(captainGrid[0]);
  const flaggedIds = new Set(freshPlan.flagged.map((row) => row.residentId));
  const snapshotIds: number[] = [];
  const insertSnapshots = db.transaction(() => {
    for (const append of guarded.appends) {
      const result = db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, ?, ?, 'row_append', ?, '', 'null', ?, ?)`,
        [
          ctx.runId,
          target.captainSpreadsheetId,
          target.captainName,
          target.captainTab,
          append.residentId,
          JSON.stringify(append.row),
          JSON.stringify({ headers, previewRunId }),
        ]
      );
      snapshotIds.push(Number(result.lastInsertRowid));
    }
  });
  insertSnapshots();

  ctx.reportProgress({ stage: 'writing', message: `Adding ${guarded.appends.length} approved resident row(s).` });
  const result = await google.appendValues(
    target.captainSpreadsheetId,
    google.a1Range(target.captainTab, 'A:ZZ'),
    guarded.appends.map((append) => append.row)
  );
  if (result.updatedRows !== guarded.appends.length) {
    throw new Error(
      `Google reported ${result.updatedRows} appended row(s), but ${guarded.appends.length} were approved. The run was stopped for review.`
    );
  }

  if (snapshotIds.length > 0) {
    const placeholders = snapshotIds.map(() => '?').join(',');
    db.run(`UPDATE run_snapshots SET range_a1 = ? WHERE id IN (${placeholders})`, [
      result.updatedRange,
      ...snapshotIds,
    ]);
  }

  for (const append of guarded.appends) {
    ctx.log({
      spreadsheet: target.captainName,
      row: result.updatedRange,
      resident_id: append.residentId,
      type: 'append',
      incoming_value: 'New resident row',
      message: `Added resident ${append.residentId} to the copied captain sheet.`,
    });
    if (flaggedIds.has(append.residentId)) {
      ctx.log({
        spreadsheet: target.captainName,
        resident_id: append.residentId,
        type: 'sensitive',
        message: 'This appended row contains one or more fields marked sensitive in the Field Dictionary.',
      });
    }
  }

  return {
    previewRunId,
    targetSpreadsheet: target.captainName,
    targetTab: target.captainTab,
    appended: guarded.appends.length,
    flagged: guarded.appends.filter((append) => flaggedIds.has(append.residentId)).length,
    updatedRange: result.updatedRange,
    revertAvailable: true,
  };
}

async function revertAppendCopy(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const originalRunId = numberParam(ctx.params.originalRunId, 'originalRunId');
  const snapshots = db.all<SnapshotRow>(
    `SELECT id, spreadsheet_id, spreadsheet_name, tab_name, resident_id, after_json
     FROM run_snapshots
     WHERE run_id = ? AND operation = 'row_append' AND reverted_by_run_id IS NULL
     ORDER BY id`,
    [originalRunId]
  );
  if (snapshots.length === 0) throw new Error('This run has no remaining appended rows to revert.');

  const groups = groupSnapshots(snapshots);
  let deleted = 0;
  let conflicts = 0;
  let skipped = 0;

  for (const group of groups.values()) {
    ctx.reportProgress({ stage: 'reading', message: `Checking ${group.spreadsheetName} before undo.` });
    const grid = await readGrid(group.spreadsheetId, group.tabName);
    const appendSnapshots: AppendSnapshot[] = group.rows.map((row) => ({
      snapshotId: row.id,
      residentId: row.resident_id,
      row: parseRow(row.after_json),
    }));
    const plan = planAppendRevert(grid, appendSnapshots);
    if (plan.errors.length > 0) throw new Error(plan.errors.join('; '));

    for (const conflict of plan.conflicts) {
      conflicts++;
      ctx.log({
        spreadsheet: group.spreadsheetName,
        resident_id: conflict.residentId,
        type: 'conflict',
        message: conflict.reason,
      });
    }
    for (const item of plan.skipped) {
      skipped++;
      ctx.log({
        spreadsheet: group.spreadsheetName,
        resident_id: item.residentId,
        type: 'skip',
        message: item.reason,
      });
    }
    if (plan.deletions.length === 0) continue;

    const sheet = (await google.getSheetProperties(group.spreadsheetId)).find(
      (candidate) => candidate.title === group.tabName
    );
    if (!sheet) throw new Error(`Tab "${group.tabName}" no longer exists in ${group.spreadsheetName}.`);

    const saveDeleteSnapshots = db.transaction(() => {
      for (const deletion of plan.deletions) {
        db.run(
          `INSERT INTO run_snapshots
             (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
              range_a1, before_json, after_json, metadata_json)
           VALUES (?, ?, ?, ?, 'row_delete', ?, ?, ?, 'null', ?)`,
          [
            ctx.runId,
            group.spreadsheetId,
            group.spreadsheetName,
            group.tabName,
            deletion.residentId,
            `${deletion.rowIndex + 1}:${deletion.rowIndex + 1}`,
            JSON.stringify(deletion.row),
            JSON.stringify({ originalRunId, originalSnapshotId: deletion.snapshotId }),
          ]
        );
      }
    });
    saveDeleteSnapshots();

    ctx.reportProgress({ stage: 'writing', message: `Removing ${plan.deletions.length} unchanged appended row(s).` });
    await google.batchUpdateSpreadsheet(
      group.spreadsheetId,
      plan.deletions.map((deletion) => ({
        deleteDimension: {
          range: {
            sheetId: sheet.sheetId,
            dimension: 'ROWS',
            startIndex: deletion.rowIndex,
            endIndex: deletion.rowIndex + 1,
          },
        },
      }))
    );

    const originalSnapshotIds = plan.deletions.map((deletion) => deletion.snapshotId);
    const placeholders = originalSnapshotIds.map(() => '?').join(',');
    db.run(`UPDATE run_snapshots SET reverted_by_run_id = ? WHERE id IN (${placeholders})`, [
      ctx.runId,
      ...originalSnapshotIds,
    ]);

    for (const deletion of plan.deletions) {
      deleted++;
      ctx.log({
        spreadsheet: group.spreadsheetName,
        row: deletion.rowIndex + 1,
        resident_id: deletion.residentId,
        type: 'revert_delete',
        existing_value: 'Appended resident row',
        message: `Removed resident ${deletion.residentId}, restoring the copied sheet to its pre-run state.`,
      });
    }
  }

  return {
    revertedRunId: originalRunId,
    deleted,
    conflicts,
    skipped,
    message:
      conflicts > 0
        ? 'Some rows changed after the original run and were left in place for review.'
        : 'The unchanged appended rows were removed.',
  };
}

async function enrichZonesCopy(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const previewRunId = numberParam(ctx.params.previewRunId, 'previewRunId');
  const target = parseTarget(ctx.params.target);
  const enrichmentTab = String(ctx.params.enrichmentTab || DEFAULT_ENRICHMENT_TAB).trim();
  const expectedFingerprint = String(ctx.params.fingerprint || '').trim();
  const expectedColumnsToAdd = Array.isArray(ctx.params.columnsToAdd)
    ? ctx.params.columnsToAdd.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (!expectedFingerprint) throw new Error('Approved enrichment fingerprint is missing.');
  assertCopyMaster(target.masterSpreadsheetId);

  if (!isMapboxConfigured()) {
    throw new Error('Mapbox is not configured. Add MAPBOX_TOKEN to .env and restart.');
  }

  ctx.reportProgress({ stage: 'reading', message: 'Rechecking the master copy and zone shapes before writing.' });
  const masterGrid = await readGrid(target.masterSpreadsheetId, enrichmentTab);
  const cfg = resolveZoneConfig(trimHeaders(masterGrid[0]));
  const features = await fetchZoneFeatures(loadZoneSource());
  const enrichment = planZoneEnrichment(masterGrid, features, cfg);
  if (enrichment.report.configError) throw new Error(enrichment.report.configError);

  if (
    enrichment.fingerprint !== expectedFingerprint ||
    !sameIdentities(expectedColumnsToAdd, enrichment.columnsToAdd)
  ) {
    throw new Error(
      'The master copy or zone shapes changed after the preview. Nothing was written. Please run a fresh preview and approve that result.'
    );
  }

  if (enrichment.proposals.length === 0 && enrichment.columnsToAdd.length === 0) {
    return {
      previewRunId,
      targetSpreadsheet: target.masterName,
      enrichmentTab,
      columnsAdded: 0,
      cellsFilled: 0,
      message: 'The master copy already had the computed zone values. Nothing needed to be written.',
    };
  }

  // Expand the sheet grid, then add missing derived headers so the guarded
  // cell planner can locate them. Sheets rejects writes past columnCount.
  const { headers, added, addedIndexes } = ensureHeaderColumns(masterGrid, enrichment.columnsToAdd);
  if (added.length > 0) {
    const sheet = (await google.getSheetProperties(target.masterSpreadsheetId)).find(
      (candidate) => candidate.title === enrichmentTab
    );
    if (!sheet) throw new Error(`Tab "${enrichmentTab}" no longer exists on the master copy.`);
    const columnsNeeded = headers.length - sheet.columnCount;
    if (columnsNeeded > 0) {
      ctx.reportProgress({
        stage: 'writing',
        message: `Expanding the master copy by ${columnsNeeded} column(s) before writing headers.`,
      });
      await google.batchUpdateSpreadsheet(target.masterSpreadsheetId, [
        {
          appendDimension: {
            sheetId: sheet.sheetId,
            dimension: 'COLUMNS',
            length: columnsNeeded,
          },
        },
      ]);
    }

    const headerUpdates = added.map((column, index) => ({
      range: google.a1Range(enrichmentTab, `${google.columnLetter(addedIndexes[index] - 1)}1`),
      values: [[column]],
    }));
    const insertHeaderSnapshots = db.transaction(() => {
      for (let i = 0; i < added.length; i++) {
        db.run(
          `INSERT INTO run_snapshots
             (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
              range_a1, before_json, after_json, metadata_json)
           VALUES (?, ?, ?, ?, 'cell_update', '', ?, '""', ?, ?)`,
          [
            ctx.runId,
            target.masterSpreadsheetId,
            target.masterName,
            enrichmentTab,
            headerUpdates[i].range,
            JSON.stringify(added[i]),
            JSON.stringify({ kind: 'header_add', column: added[i], previewRunId }),
          ]
        );
      }
    });
    insertHeaderSnapshots();
    ctx.reportProgress({ stage: 'writing', message: `Adding ${added.length} new column header(s).` });
    await google.updateValues(target.masterSpreadsheetId, headerUpdates);
  }

  const guarded = planGuardedCellWrites(
    masterGrid,
    enrichment.proposals.map((proposal) => ({
      residentId: proposal.residentId,
      column: proposal.column,
      value: proposal.value,
      policy: proposal.policy,
    }))
  );
  if (guarded.errors.length > 0) throw new Error(guarded.errors.join('; '));
  if (guarded.writes.length === 0) {
    return {
      previewRunId,
      targetSpreadsheet: target.masterName,
      enrichmentTab,
      columnsAdded: added.length,
      cellsFilled: 0,
      message: 'Headers were ready, but no blank cells needed filling.',
      revertAvailable: added.length > 0,
    };
  }

  const insertCellSnapshots = db.transaction(() => {
    for (const write of guarded.writes) {
      const range = google.a1Range(enrichmentTab, `${google.columnLetter(write.col - 1)}${write.row}`);
      db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, ?, ?, 'cell_update', ?, ?, ?, ?, ?)`,
        [
          ctx.runId,
          target.masterSpreadsheetId,
          target.masterName,
          enrichmentTab,
          write.residentId,
          range,
          JSON.stringify(write.before ?? ''),
          JSON.stringify(write.after ?? ''),
          JSON.stringify({ column: write.column, previewRunId }),
        ]
      );
    }
  });
  insertCellSnapshots();

  ctx.reportProgress({
    stage: 'writing',
    message: `Filling ${guarded.writes.length.toLocaleString()} blank zone/captain cell(s) on the master copy.`,
  });
  const updates = guarded.writes.map((write) => ({
    range: google.a1Range(enrichmentTab, `${google.columnLetter(write.col - 1)}${write.row}`),
    values: [[write.after]],
  }));
  const updatedCells = await google.updateValuesChunked(target.masterSpreadsheetId, updates);

  for (const conflict of guarded.conflicts) {
    ctx.log({
      spreadsheet: target.masterName,
      row: conflict.row,
      column: conflict.column,
      resident_id: conflict.residentId,
      type: 'conflict',
      existing_value: String(conflict.before ?? ''),
      incoming_value: String(conflict.after ?? ''),
      message: 'Skipped a non-blank disagreement (fill_blank only).',
    });
  }

  ctx.log({
    spreadsheet: target.masterName,
    type: 'enrich_zones',
    message: `Filled ${guarded.writes.length} blank cell(s) and added ${added.length} column(s) on tab "${enrichmentTab}".`,
  });

  return {
    previewRunId,
    targetSpreadsheet: target.masterName,
    enrichmentTab,
    columnsAdded: added.length,
    cellsFilled: guarded.writes.length,
    updatedCells,
    residentsTouched: new Set(guarded.writes.map((write) => write.residentId)).size,
    revertAvailable: true,
  };
}

async function revertCellCopy(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const originalRunId = numberParam(ctx.params.originalRunId, 'originalRunId');
  const snapshots = db.all<CellSnapshotRow>(
    `SELECT id, spreadsheet_id, spreadsheet_name, tab_name, resident_id, range_a1,
            before_json, after_json, metadata_json
     FROM run_snapshots
     WHERE run_id = ? AND operation = 'cell_update' AND reverted_by_run_id IS NULL
     ORDER BY id`,
    [originalRunId]
  );
  if (snapshots.length === 0) throw new Error('This run has no remaining cell changes to revert.');

  const groups = groupCellSnapshots(snapshots);
  let restored = 0;
  let conflicts = 0;
  let skipped = 0;

  for (const group of groups.values()) {
    assertCopyMaster(group.spreadsheetId);
    ctx.reportProgress({ stage: 'reading', message: `Checking ${group.spreadsheetName} before undo.` });
    const grid = await readGrid(group.spreadsheetId, group.tabName);

    // Data-cell restores first; header restores (blank resident_id) last so
    // columns stay findable while we put values back.
    const dataSnapshots = group.rows.filter((row) => row.resident_id);
    const headerSnapshots = group.rows.filter((row) => !row.resident_id);

    if (dataSnapshots.length > 0) {
      const cellSnapshots: CellSnapshot[] = dataSnapshots.map((row) => ({
        snapshotId: row.id,
        residentId: row.resident_id,
        column: metadataColumn(row.metadata_json) || '',
        rangeA1: row.range_a1,
        before: parseJsonValue(row.before_json),
        after: parseJsonValue(row.after_json),
      }));
      const plan = planCellRevert(grid, cellSnapshots);
      if (plan.errors.length > 0) throw new Error(plan.errors.join('; '));

      for (const conflict of plan.conflicts) {
        conflicts++;
        ctx.log({
          spreadsheet: group.spreadsheetName,
          resident_id: conflict.residentId,
          type: 'conflict',
          message: conflict.reason,
        });
      }
      for (const item of plan.skipped) {
        skipped++;
        ctx.log({
          spreadsheet: group.spreadsheetName,
          resident_id: item.residentId,
          type: 'skip',
          message: item.reason,
        });
      }
      // Cells that never received the write (or were already restored) are done.
      const alreadyDone = plan.skipped
        .filter((item) => /already matches its pre-run value/i.test(item.reason))
        .map((item) => item.snapshotId);
      markSnapshotsReverted(ctx.runId, alreadyDone);

      if (plan.restores.length > 0) {
        ctx.reportProgress({
          stage: 'writing',
          message: `Restoring ${plan.restores.length.toLocaleString()} unchanged cell(s).`,
        });
        await google.updateValuesChunked(
          group.spreadsheetId,
          plan.restores.map((restore) => ({
            range: restore.rangeA1 || google.a1Range(group.tabName, `${google.columnLetter(restore.col - 1)}${restore.row}`),
            values: [[restore.before]],
          }))
        );
        markSnapshotsReverted(
          ctx.runId,
          plan.restores.map((restore) => restore.snapshotId)
        );
        restored += plan.restores.length;

        // Putting a master value back means the captain still disagrees with
        // it, so the conflict belongs in the inbox again.
        const restoredIds = new Set(plan.restores.map((restore) => restore.snapshotId));
        for (const row of dataSnapshots) {
          if (!restoredIds.has(row.id) || metadataKind(row.metadata_json) !== 'conflict_resolution') continue;
          reopenConflict(group.spreadsheetId, row.resident_id, metadataColumn(row.metadata_json), originalRunId);
        }
      }
    }

    // Header adds: clear the header cell only if it still matches what we wrote.
    for (const header of headerSnapshots) {
      const column = metadataColumn(header.metadata_json) || String(parseJsonValue(header.after_json) ?? '');
      const headers = trimHeaders(grid[0]);
      const colIndex = headers.indexOf(column);
      if (colIndex === -1) {
        skipped++;
        continue;
      }
      const current = grid[0]?.[colIndex];
      const expected = parseJsonValue(header.after_json);
      if (!cellValuesEqualLocal(current, expected)) {
        conflicts++;
        ctx.log({
          spreadsheet: group.spreadsheetName,
          column,
          type: 'conflict',
          message: 'A header added by this run was renamed afterward and was left in place.',
        });
        continue;
      }
      await google.updateValues(group.spreadsheetId, [
        {
          range: header.range_a1 || google.a1Range(group.tabName, `${google.columnLetter(colIndex)}1`),
          values: [['']],
        },
      ]);
      db.run('UPDATE run_snapshots SET reverted_by_run_id = ? WHERE id = ?', [ctx.runId, header.id]);
      restored++;
      if (grid[0]) grid[0][colIndex] = '';
    }
  }

  return {
    revertedRunId: originalRunId,
    restored,
    conflicts,
    skipped,
    message:
      conflicts > 0
        ? 'Some cells changed after the original run and were left in place for review.'
        : 'Unchanged zone/captain cells from this run were restored.',
  };
}

async function moveResidentsCopy(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const previewRunId = numberParam(ctx.params.previewRunId, 'previewRunId');
  const target = parseMoveTarget(ctx.params.target);
  const expectedResidentIds = stringArray(ctx.params.expectedResidentIds);
  const expectedFingerprint = String(ctx.params.fingerprint || '').trim();
  const expectedFromZone = String(ctx.params.fromZone || '').trim();
  const expectedToZone = String(ctx.params.toZone || '').trim();
  const expectedDestinationFields =
    ctx.params.destinationFields && typeof ctx.params.destinationFields === 'object'
      ? (ctx.params.destinationFields as Record<string, string>)
      : { ZoneName: expectedToZone };
  if (!expectedFingerprint) throw new Error('Approved move fingerprint is missing.');
  if (target.masterSpreadsheetId) assertCopyMaster(target.masterSpreadsheetId);
  assertNotProductionSheet(target.fromCaptainSpreadsheetId, 'source captain');
  assertNotProductionSheet(target.toCaptainSpreadsheetId, 'destination captain');

  if (!isMapboxConfigured()) {
    throw new Error('Mapbox is not configured. Add MAPBOX_TOKEN to .env and restart.');
  }

  ctx.reportProgress({ stage: 'reading', message: 'Rechecking both captain copies and zone shapes before moving anyone.' });
  const fromGrid = await readGrid(target.fromCaptainSpreadsheetId, target.fromCaptainTab);
  const toGrid = await readGrid(target.toCaptainSpreadsheetId, target.toCaptainTab);
  const masterGrid =
    target.masterSpreadsheetId && target.masterTab
      ? await readGrid(target.masterSpreadsheetId, target.masterTab)
      : [trimHeaders(fromGrid[0])];

  const fromZone = target.fromZoneOverride || detectSheetZone(trimHeaders(fromGrid[0]), fromGrid.slice(1));
  const toZone = target.toZoneOverride || detectSheetZone(trimHeaders(toGrid[0]), toGrid.slice(1));
  if (fromZone !== expectedFromZone || toZone !== expectedToZone) {
    throw new Error(
      'The detected zones on the captain copies changed after the preview. Nothing was written. Please run a fresh preview.'
    );
  }

  const cfg = resolveZoneConfig(trimHeaders(masterGrid[0]?.length ? masterGrid[0] : fromGrid[0]));
  const features = await fetchZoneFeatures(loadZoneSource());
  const proposal = planCaptainSheetMoves(fromGrid, masterGrid, features, cfg, fromZone, toZone);
  if (proposal.errors.length > 0) throw new Error(proposal.errors.join('; '));

  const approvedSet = new Set(expectedResidentIds);
  const freshIds = proposal.candidates
    .map((candidate) => candidate.residentId)
    .filter((id) => approvedSet.has(id));
  const freshFingerprint = fingerprintCaptainMoves(
    freshIds.map((residentId) => ({ residentId })),
    fromZone,
    toZone
  );
  if (
    !sameIdentities(expectedResidentIds, freshIds) ||
    freshFingerprint !== expectedFingerprint ||
    JSON.stringify(proposal.destinationFields) !== JSON.stringify(expectedDestinationFields)
  ) {
    throw new Error(
      'The captain copies or zone shapes changed after the preview. Nothing was written. Please run a fresh preview and approve that result.'
    );
  }

  const guarded = planGuardedMoves(fromGrid, toGrid, expectedResidentIds, proposal.destinationFields);
  if (guarded.errors.length > 0) throw new Error(guarded.errors.join('; '));
  if (!sameIdentities(
    expectedResidentIds,
    guarded.moves.map((move) => move.residentId)
  )) {
    throw new Error(
      'Some approved residents can no longer be moved safely (already on the destination, missing from the source, or ambiguous). Nothing was written.'
    );
  }
  if (guarded.moves.length === 0) {
    return {
      previewRunId,
      moved: 0,
      message: 'No approved residents needed moving.',
    };
  }

  const toHeaders = trimHeaders(toGrid[0]);
  const fromHeaders = trimHeaders(fromGrid[0]);
  const appendSnapshotIds: number[] = [];
  const insertAppendSnapshots = db.transaction(() => {
    for (const move of guarded.moves) {
      const result = db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, ?, ?, 'row_append', ?, '', 'null', ?, ?)`,
        [
          ctx.runId,
          target.toCaptainSpreadsheetId,
          target.toCaptainName,
          target.toCaptainTab,
          move.residentId,
          JSON.stringify(move.appendRow),
          JSON.stringify({
            kind: 'move_append',
            previewRunId,
            fromZone,
            toZone,
            headers: toHeaders,
          }),
        ]
      );
      appendSnapshotIds.push(Number(result.lastInsertRowid));
    }
  });
  insertAppendSnapshots();

  ctx.reportProgress({
    stage: 'writing',
    message: `Adding ${guarded.moves.length} resident(s) to ${target.toCaptainName}.`,
  });
  const appendResult = await google.appendValues(
    target.toCaptainSpreadsheetId,
    google.a1Range(target.toCaptainTab, 'A:ZZ'),
    guarded.moves.map((move) => move.appendRow)
  );
  if (appendResult.updatedRows !== guarded.moves.length) {
    throw new Error(
      `Google reported ${appendResult.updatedRows} appended row(s), but ${guarded.moves.length} were approved. The run was stopped before any deletes.`
    );
  }
  if (appendSnapshotIds.length > 0) {
    const placeholders = appendSnapshotIds.map(() => '?').join(',');
    db.run(`UPDATE run_snapshots SET range_a1 = ? WHERE id IN (${placeholders})`, [
      appendResult.updatedRange,
      ...appendSnapshotIds,
    ]);
  }

  // Re-read source after append so delete planning uses current identities.
  ctx.reportProgress({ stage: 'reading', message: 'Rechecking the source copy before removing moved residents.' });
  const freshFromGrid = await readGrid(target.fromCaptainSpreadsheetId, target.fromCaptainTab);
  const deletePlan = planGuardedDeletes(
    freshFromGrid,
    guarded.moves.map((move) => move.residentId)
  );
  if (deletePlan.errors.length > 0) throw new Error(deletePlan.errors.join('; '));
  if (deletePlan.deletions.length !== guarded.moves.length) {
    throw new Error(
      `Appended ${guarded.moves.length} resident(s) to the destination, but only ${deletePlan.deletions.length} could be safely removed from the source. Use Undo, then inspect both copies.`
    );
  }

  const sheet = (await google.getSheetProperties(target.fromCaptainSpreadsheetId)).find(
    (candidate) => candidate.title === target.fromCaptainTab
  );
  if (!sheet) throw new Error(`Tab "${target.fromCaptainTab}" no longer exists in ${target.fromCaptainName}.`);

  const insertDeleteSnapshots = db.transaction(() => {
    for (const deletion of deletePlan.deletions) {
      db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, ?, ?, 'row_delete', ?, ?, ?, 'null', ?)`,
        [
          ctx.runId,
          target.fromCaptainSpreadsheetId,
          target.fromCaptainName,
          target.fromCaptainTab,
          deletion.residentId,
          `${deletion.rowIndex + 1}:${deletion.rowIndex + 1}`,
          JSON.stringify(deletion.row),
          JSON.stringify({
            kind: 'move_delete',
            previewRunId,
            fromZone,
            toZone,
            headers: fromHeaders,
          }),
        ]
      );
    }
  });
  insertDeleteSnapshots();

  ctx.reportProgress({
    stage: 'writing',
    message: `Removing ${deletePlan.deletions.length} resident(s) from ${target.fromCaptainName}.`,
  });
  await google.batchUpdateSpreadsheet(
    target.fromCaptainSpreadsheetId,
    deletePlan.deletions.map((deletion) => ({
      deleteDimension: {
        range: {
          sheetId: sheet.sheetId,
          dimension: 'ROWS',
          startIndex: deletion.rowIndex,
          endIndex: deletion.rowIndex + 1,
        },
      },
    }))
  );

  for (const move of guarded.moves) {
    ctx.log({
      spreadsheet: target.toCaptainName,
      resident_id: move.residentId,
      type: 'move_append',
      incoming_value: toZone,
      existing_value: fromZone,
      message: `Moved resident ${move.residentId}: appended to ${target.toCaptainName} (${toZone}).`,
    });
    ctx.log({
      spreadsheet: target.fromCaptainName,
      resident_id: move.residentId,
      type: 'move_delete',
      incoming_value: toZone,
      existing_value: fromZone,
      message: `Moved resident ${move.residentId}: removed from ${target.fromCaptainName} (${fromZone}).`,
    });
  }

  return {
    previewRunId,
    fromSpreadsheet: target.fromCaptainName,
    toSpreadsheet: target.toCaptainName,
    fromZone,
    toZone,
    moved: guarded.moves.length,
    updatedRange: appendResult.updatedRange,
    revertAvailable: true,
  };
}

async function revertMoveCopy(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const originalRunId = numberParam(ctx.params.originalRunId, 'originalRunId');

  const appendSnapshots = db.all<SnapshotRow>(
    `SELECT id, spreadsheet_id, spreadsheet_name, tab_name, resident_id, after_json
     FROM run_snapshots
     WHERE run_id = ? AND operation = 'row_append' AND reverted_by_run_id IS NULL
     ORDER BY id`,
    [originalRunId]
  );
  const deleteSnapshots = db.all<SnapshotRow & { before_json: string }>(
    `SELECT id, spreadsheet_id, spreadsheet_name, tab_name, resident_id, after_json, before_json
     FROM run_snapshots
     WHERE run_id = ? AND operation = 'row_delete' AND reverted_by_run_id IS NULL
     ORDER BY id`,
    [originalRunId]
  );
  if (appendSnapshots.length === 0 && deleteSnapshots.length === 0) {
    throw new Error('This move run has no remaining changes to revert.');
  }

  let deletedFromDest = 0;
  let restoredToSource = 0;
  let conflicts = 0;
  let skipped = 0;

  // 1) Remove unchanged appended rows from destination sheet(s).
  for (const group of groupSnapshots(appendSnapshots).values()) {
    assertNotProductionSheet(group.spreadsheetId, 'destination captain');
    ctx.reportProgress({ stage: 'reading', message: `Checking ${group.spreadsheetName} before undoing appends.` });
    const grid = await readGrid(group.spreadsheetId, group.tabName);
    const plan = planAppendRevert(
      grid,
      group.rows.map((row) => ({
        snapshotId: row.id,
        residentId: row.resident_id,
        row: parseRow(row.after_json),
      }))
    );
    if (plan.errors.length > 0) throw new Error(plan.errors.join('; '));

    for (const conflict of plan.conflicts) {
      conflicts++;
      ctx.log({
        spreadsheet: group.spreadsheetName,
        resident_id: conflict.residentId,
        type: 'conflict',
        message: conflict.reason,
      });
    }
    for (const item of plan.skipped) {
      skipped++;
      ctx.log({
        spreadsheet: group.spreadsheetName,
        resident_id: item.residentId,
        type: 'skip',
        message: item.reason,
      });
    }
    if (plan.deletions.length === 0) continue;

    const sheet = (await google.getSheetProperties(group.spreadsheetId)).find(
      (candidate) => candidate.title === group.tabName
    );
    if (!sheet) throw new Error(`Tab "${group.tabName}" no longer exists in ${group.spreadsheetName}.`);

    ctx.reportProgress({
      stage: 'writing',
      message: `Removing ${plan.deletions.length} unchanged moved row(s) from ${group.spreadsheetName}.`,
    });
    await google.batchUpdateSpreadsheet(
      group.spreadsheetId,
      plan.deletions.map((deletion) => ({
        deleteDimension: {
          range: {
            sheetId: sheet.sheetId,
            dimension: 'ROWS',
            startIndex: deletion.rowIndex,
            endIndex: deletion.rowIndex + 1,
          },
        },
      }))
    );
    markSnapshotsReverted(
      ctx.runId,
      plan.deletions.map((deletion) => deletion.snapshotId)
    );
    deletedFromDest += plan.deletions.length;
  }

  // 2) Restore rows that were removed from the source, if still absent.
  for (const group of groupSnapshots(deleteSnapshots).values()) {
    assertNotProductionSheet(group.spreadsheetId, 'source captain');
    ctx.reportProgress({ stage: 'reading', message: `Checking ${group.spreadsheetName} before restoring rows.` });
    const grid = await readGrid(group.spreadsheetId, group.tabName);
    const restores = planRowRestores(
      grid,
      group.rows.map((row) => ({
        snapshotId: row.id,
        residentId: row.resident_id,
        row: parseRow((row as SnapshotRow & { before_json: string }).before_json || row.after_json),
      }))
    );
    if (restores.errors.length > 0) throw new Error(restores.errors.join('; '));

    for (const conflict of restores.conflicts) {
      conflicts++;
      ctx.log({
        spreadsheet: group.spreadsheetName,
        resident_id: conflict.residentId,
        type: 'conflict',
        message: conflict.reason,
      });
    }
    for (const item of restores.skipped) {
      skipped++;
      ctx.log({
        spreadsheet: group.spreadsheetName,
        resident_id: item.residentId,
        type: 'skip',
        message: item.reason,
      });
      if (/already present with matching values/i.test(item.reason)) {
        markSnapshotsReverted(ctx.runId, [item.snapshotId]);
      }
    }
    if (restores.appends.length === 0) continue;

    ctx.reportProgress({
      stage: 'writing',
      message: `Restoring ${restores.appends.length} resident(s) to ${group.spreadsheetName}.`,
    });
    const appendResult = await google.appendValues(
      group.spreadsheetId,
      google.a1Range(group.tabName, 'A:ZZ'),
      restores.appends.map((append) => append.row)
    );
    if (appendResult.updatedRows !== restores.appends.length) {
      throw new Error(
        `Google reported ${appendResult.updatedRows} restored row(s), but ${restores.appends.length} were planned.`
      );
    }
    markSnapshotsReverted(
      ctx.runId,
      restores.appends.map((append) => append.snapshotId)
    );
    restoredToSource += restores.appends.length;
  }

  return {
    revertedRunId: originalRunId,
    deletedFromDest,
    restoredToSource,
    conflicts,
    skipped,
    message:
      conflicts > 0
        ? 'Some rows changed after the original move and were left in place for review.'
        : 'The move was undone for unchanged rows.',
  };
}

function requireLive(ctx: JobContext): void {
  if (ctx.mode !== 'live') throw new Error('Execution tasks may run only in live mode.');
}

function assertCopyMaster(spreadsheetId: string): void {
  if (spreadsheetId === PRODUCTION_MASTER_SPREADSHEET_ID) {
    throw new Error('Refusing to write to the production master. Use the master copy.');
  }
}

function assertNotProductionSheet(spreadsheetId: string, label: string): void {
  if (spreadsheetId === PRODUCTION_MASTER_SPREADSHEET_ID) {
    throw new Error(`Refusing to use the production master as the ${label} sheet.`);
  }
}

function parseMoveTarget(value: unknown): MoveCopyTarget {
  if (!value || typeof value !== 'object') throw new Error('Move copy target is missing.');
  const raw = value as Partial<MoveCopyTarget>;
  const target: MoveCopyTarget = {
    masterSpreadsheetId: String(raw.masterSpreadsheetId || '').trim(),
    masterTab: String(raw.masterTab || '').trim(),
    fromCaptainSpreadsheetId: String(raw.fromCaptainSpreadsheetId || '').trim(),
    fromCaptainTab: String(raw.fromCaptainTab || '').trim(),
    toCaptainSpreadsheetId: String(raw.toCaptainSpreadsheetId || '').trim(),
    toCaptainTab: String(raw.toCaptainTab || '').trim(),
    folderId: String(raw.folderId || '').trim(),
    masterName: String(raw.masterName || '').trim(),
    fromCaptainName: String(raw.fromCaptainName || '').trim(),
    toCaptainName: String(raw.toCaptainName || '').trim(),
    fromZoneOverride: String(raw.fromZoneOverride || '').trim(),
    toZoneOverride: String(raw.toZoneOverride || '').trim(),
  };
  if (
    !target.fromCaptainSpreadsheetId ||
    !target.fromCaptainTab ||
    !target.toCaptainSpreadsheetId ||
    !target.toCaptainTab ||
    !target.folderId
  ) {
    throw new Error('Move copy target is incomplete.');
  }
  if (Boolean(target.masterSpreadsheetId) !== Boolean(target.masterTab)) {
    throw new Error('Master copy and master tab must both be set, or both left blank.');
  }
  if (target.fromCaptainSpreadsheetId === target.toCaptainSpreadsheetId) {
    throw new Error('Source and destination captain copies must be different spreadsheets.');
  }
  return target;
}

function resolveZoneConfig(masterHeaders: string[]): ZoneReconcileConfig {
  const resolve = (canonical: string): string | null => {
    const field = db.get<{ id: number }>('SELECT id FROM dictionary_fields WHERE canonical_name = ?', [canonical]);
    const aliases = field
      ? db.all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id = ?', [field.id]).map((r) => r.alias)
      : [];
    return findColumn(masterHeaders, [canonical, ...aliases]);
  };
  return {
    latHeader: resolve('Latitude'),
    lonHeader: resolve('Longitude'),
    zoneHeader: resolve('ZoneName'),
    ncNameHeader: resolve('NC Name'),
    ncPhoneHeader: resolve('NC Phone'),
    ncEmailHeader: resolve('NC Email'),
    identityHeader: resolve('resident_id'),
    nameHeader: resolve('Resident Name'),
  };
}

function loadZoneSource(): { username: string; datasetId: string } {
  const raw = db.getSetting('zone_source_config', '');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { username?: string; datasetId?: string };
      return {
        username: (parsed.username || DEFAULT_MAPBOX_USERNAME).trim(),
        datasetId: (parsed.datasetId || DEFAULT_MAPBOX_DATASET_ID).trim(),
      };
    } catch {
      /* defaults */
    }
  }
  return { username: DEFAULT_MAPBOX_USERNAME, datasetId: DEFAULT_MAPBOX_DATASET_ID };
}

function metadataColumn(json: string): string {
  try {
    const value = JSON.parse(json || '{}') as { column?: string };
    return String(value.column || '').trim();
  } catch {
    return '';
  }
}

function metadataKind(json: string): string {
  try {
    const value = JSON.parse(json || '{}') as { kind?: string };
    return String(value.kind || '').trim();
  } catch {
    return '';
  }
}

/** Re-open the conflict a resolution run had closed, if it is still resolved. */
function reopenConflict(spreadsheetId: string, residentId: string, column: string, resolutionRunId: number): void {
  if (!residentId || !column) return;
  const candidates = db.all<{ id: number; context_json: string }>(
    `SELECT id, context_json FROM conflicts
     WHERE status = 'resolved' AND resident_id = ? AND "column" = ?`,
    [residentId, column]
  );
  for (const candidate of candidates) {
    const context = parseConflictContext(candidate.context_json);
    if (!context || context.spreadsheetId !== spreadsheetId) continue;
    db.run("UPDATE conflicts SET status = 'open', resolution_notes = ? WHERE id = ?", [
      `Re-opened when run #${resolutionRunId} was undone.`,
      candidate.id,
    ]);
  }
}

function parseJsonValue(json: string): CellValue {
  try {
    return JSON.parse(json) as CellValue;
  } catch {
    return json;
  }
}

function cellValuesEqualLocal(a: unknown, b: unknown): boolean {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

function markSnapshotsReverted(runId: number, snapshotIds: number[]): void {
  const chunkSize = 400;
  for (let i = 0; i < snapshotIds.length; i += chunkSize) {
    const chunk = snapshotIds.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(',');
    db.run(`UPDATE run_snapshots SET reverted_by_run_id = ? WHERE id IN (${placeholders})`, [runId, ...chunk]);
  }
}

function groupCellSnapshots(rows: CellSnapshotRow[]): Map<
  string,
  { spreadsheetId: string; spreadsheetName: string; tabName: string; rows: CellSnapshotRow[] }
> {
  const groups = new Map<
    string,
    { spreadsheetId: string; spreadsheetName: string; tabName: string; rows: CellSnapshotRow[] }
  >();
  for (const row of rows) {
    const key = `${row.spreadsheet_id}\u0000${row.tab_name}`;
    const group = groups.get(key) ?? {
      spreadsheetId: row.spreadsheet_id,
      spreadsheetName: row.spreadsheet_name,
      tabName: row.tab_name,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return groups;
}

async function readGrid(spreadsheetId: string, tabName: string): Promise<Grid> {
  return (await google.readValues(spreadsheetId, google.a1Range(tabName, 'A:ZZ'))) as Grid;
}

function parseTarget(value: unknown): SafeCopyTarget {
  if (!value || typeof value !== 'object') throw new Error('Safe copy target is missing.');
  const raw = value as Partial<SafeCopyTarget>;
  const target: SafeCopyTarget = {
    masterSpreadsheetId: String(raw.masterSpreadsheetId || '').trim(),
    masterTab: String(raw.masterTab || '').trim(),
    captainSpreadsheetId: String(raw.captainSpreadsheetId || '').trim(),
    captainTab: String(raw.captainTab || '').trim(),
    folderId: String(raw.folderId || '').trim(),
    masterName: String(raw.masterName || '').trim(),
    captainName: String(raw.captainName || '').trim(),
  };
  if (
    !target.masterSpreadsheetId ||
    !target.masterTab ||
    !target.captainSpreadsheetId ||
    !target.captainTab ||
    !target.folderId
  ) {
    throw new Error('Safe copy target is incomplete.');
  }
  return target;
}

function numberParam(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer.`);
  return n;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Approved resident identities are missing.');
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function sameIdentities(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

function parseRow(json: string): Grid[number] {
  try {
    const row = JSON.parse(json);
    return Array.isArray(row) ? row : [];
  } catch {
    return [];
  }
}

function groupSnapshots(rows: SnapshotRow[]): Map<
  string,
  { spreadsheetId: string; spreadsheetName: string; tabName: string; rows: SnapshotRow[] }
> {
  const groups = new Map<
    string,
    { spreadsheetId: string; spreadsheetName: string; tabName: string; rows: SnapshotRow[] }
  >();
  for (const row of rows) {
    const key = `${row.spreadsheet_id}\u0000${row.tab_name}`;
    const group = groups.get(key) ?? {
      spreadsheetId: row.spreadsheet_id,
      spreadsheetName: row.spreadsheet_name,
      tabName: row.tab_name,
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  return groups;
}

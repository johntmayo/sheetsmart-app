import * as db from './db';
import * as google from './google';
import { createHash, randomUUID } from 'node:crypto';
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
  remapRowByHeaders,
  type AppendSnapshot,
  type CellSnapshot,
} from './lib/liveWriteEngine';
import {
  fingerprintFolderZoneMoves,
  fingerprintCaptainMoves,
  planFolderZoneReconciliation,
  planCaptainSheetMoves,
  planZoneEnrichment,
  type AddressMoveCandidate,
  type CaptainSheetInput,
  type ZoneReconcileConfig,
} from './lib/zoneEngine';
import {
  folderNewResidentsFingerprint,
  fingerprintPullCells,
  newResidentCellKeys,
  planPullNewResidents,
  planPullNewResidentsFromFolder,
  planPullToMaster,
  pullCellValueKey,
  type FolderNewResident,
  type PullCellChange,
  type PullCellKey,
} from './lib/pullEngine';
import { isZoneDashboardSalesField } from './lib/salesFieldPolicy';
import {
  cellValuesEqual,
  displayCellValue,
  normalizeForCompare,
  type FieldCompareMeta,
  type FieldMetaMap,
} from './lib/values';
import { fetchZoneFeatures, isMapboxConfigured, DEFAULT_MAPBOX_USERNAME, DEFAULT_MAPBOX_DATASET_ID } from './mapbox';
import {
  canonicalizeHeaders,
  detectSheetZone,
  detectSheetZoneWithName,
  fingerprintDictionaryAliases,
  findColumn,
  type DictionaryAliasSpec,
} from './lib/columns';
import type { CellValue } from './lib/values';
import { fingerprintMissingZoneSheets, planMissingZoneSheets } from './lib/zoneSheetEngine';
import { filterGridByTombstones, loadActiveTombstones } from './lib/tombstones';
import { classifyConflictFreshness } from './lib/conflictRevalidation';
import {
  fingerprintArchivedPayload,
  planAddressDeletion,
  planPersonDeletion,
  type ArchivedDeletionRow,
  type DeletionPlan,
  type DeletionSheet,
} from './lib/deletionEngine';
import {
  OPERATIONS_SCHEMA_VERSION,
  parseDeletedRecords,
  type DeletedRecord,
} from './lib/operationsContract';
import {
  planAddressIntake,
  type AddressHeaders,
  type AddressPlaceholder,
  type AddressRow,
} from './lib/addressIntakeEngine';
import { buildSpatialIndex, findContainingFeatures, ZONE_OUTPUT_FIELDS } from './lib/zoneEngine';

export const PUSH_MISSING_COPY_TASK = 'push_missing_copy';
export const REVERT_APPEND_COPY_TASK = 'revert_append_copy';
export const ENRICH_ZONES_COPY_TASK = 'enrich_zones_copy';
export const REVERT_CELL_COPY_TASK = 'revert_cell_copy';
export const MOVE_RESIDENTS_COPY_TASK = 'move_residents_copy';
export const REVERT_MOVE_COPY_TASK = 'revert_move_copy';
export const PULL_TO_MASTER_COPY_TASK = 'pull_to_master_copy';
export const APPLY_CONFLICT_COPY_TASK = 'apply_conflict_copy';
export const PULL_NEW_RESIDENTS_COPY_TASK = 'pull_new_residents_copy';
export const FOLDER_ZONE_RECONCILE_TASK = 'folder_zone_reconcile';
export const REVERT_FOLDER_ZONE_RECONCILE_TASK = 'revert_folder_zone_reconcile';
export const FOLDER_CAPTAIN_IMPORT_TASK = 'folder_captain_import';
export const CREATE_ZONE_SHEETS_TASK = 'create_zone_sheets';
export const REVERT_CREATE_ZONE_SHEETS_TASK = 'revert_create_zone_sheets';
export const APPLY_DELETION_TASK = 'apply_dashboard_deletion';
export const REVERT_DELETION_TASK = 'revert_dashboard_deletion';
export const ADDRESS_INTAKE_TASK = 'address_intake';

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
  masterValue: CellValue;
  captainValue: CellValue;
  masterDisplay?: string;
  captainDisplay?: string;
  masterNormalized?: string;
  captainNormalized?: string;
  fieldMeta?: FieldCompareMeta;
  suspectedTextCoercion?: boolean;
  reason?: string;
  revalidationStatus?: 'current' | 'stale' | 'equivalent';
  revalidatedAt?: string;
  currentMasterValue?: CellValue;
  currentCaptainValue?: CellValue;
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
  metadata_json?: string;
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
  registerTask(FOLDER_ZONE_RECONCILE_TASK, folderZoneReconcile);
  registerTask(REVERT_FOLDER_ZONE_RECONCILE_TASK, revertFolderZoneReconcile);
  registerTask(FOLDER_CAPTAIN_IMPORT_TASK, folderCaptainImport);
  registerTask(CREATE_ZONE_SHEETS_TASK, createZoneSheets);
  registerTask(REVERT_CREATE_ZONE_SHEETS_TASK, revertCreateZoneSheets);
  registerTask(APPLY_DELETION_TASK, applyDashboardDeletion);
  registerTask(REVERT_DELETION_TASK, revertDashboardDeletion);
  registerTask(ADDRESS_INTAKE_TASK, applyAddressIntake);
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
  const tombstones = loadActiveTombstones(db);
  const filteredMaster = filterGridByTombstones(masterGrid, tombstones);
  const filteredCaptain = filterGridByTombstones(captainGrid, tombstones);
  const plan = planPullNewResidents(filteredMaster, filteredCaptain, {
    forbiddenColumns: db.zoneDashboardSalesHeaders(),
  });
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
    filteredMaster,
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

export function pullFieldMetaForHeaders(headers: string[]): FieldMetaMap {
  const result: FieldMetaMap = {};
  const fields = db.all<{
    id: number;
    canonical_name: string;
    data_type: FieldCompareMeta['dataType'];
    is_text_safe: number;
  }>('SELECT id, canonical_name, data_type, is_text_safe FROM dictionary_fields');
  for (const field of fields) {
    const aliases = db
      .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id = ?', [field.id])
      .map((row) => row.alias);
    const header = findColumn(headers, [field.canonical_name, ...aliases]);
    if (header) {
      result[header] = { dataType: field.data_type, isTextSafe: field.is_text_safe === 1 };
    }
  }
  return result;
}

export async function revalidateOpenPullConflicts(): Promise<{
  checked: number;
  resolved: number;
  stale: number;
}> {
  if (!google.isConfigured()) return { checked: 0, resolved: 0, stale: 0 };
  const rows = db.all<ConflictRow>("SELECT * FROM conflicts WHERE status='open' ORDER BY id");
  const grids = new Map<string, Promise<Grid>>();
  const load = (spreadsheetId: string, tabName: string) => {
    const key = `${spreadsheetId}\u0000${tabName}`;
    const cached = grids.get(key);
    if (cached) return cached;
    const pending = readGrid(spreadsheetId, tabName);
    grids.set(key, pending);
    return pending;
  };
  let checked = 0;
  let resolved = 0;
  let stale = 0;

  for (const row of rows) {
    const context = parseConflictContext(row.context_json);
    if (!context?.sourceSpreadsheetId || !context.sourceTab) continue;
    checked++;
    try {
      const [masterGrid, captainGrid] = await Promise.all([
        load(context.spreadsheetId, context.tabName),
        load(context.sourceSpreadsheetId, context.sourceTab),
      ]);
      const masterHeaders = trimHeaders(masterGrid[0]);
      const captainHeaders = trimHeaders(captainGrid[0]);
      const masterRow = findRowByResidentId(masterGrid, masterHeaders, row.resident_id);
      const captainRow = findRowByResidentId(captainGrid, captainHeaders, row.resident_id);
      const masterCol = masterHeaders.indexOf(context.column || row.column);
      const captainCol = captainHeaders.indexOf(context.column || row.column);
      if (masterRow === -1 || captainRow === -1 || masterCol === -1 || captainCol === -1) {
        stale++;
        context.revalidationStatus = 'stale';
        context.revalidatedAt = new Date().toISOString();
        db.run('UPDATE conflicts SET resolution_notes=?, context_json=? WHERE id=?', [
          'Stale: the resident or field is no longer present on both sheets.',
          JSON.stringify(context),
          row.id,
        ]);
        continue;
      }
      const masterValue = masterGrid[masterRow]?.[masterCol];
      const captainValue = captainGrid[captainRow]?.[captainCol];
      const fieldMeta = pullFieldMetaForHeaders(masterHeaders)[context.column || row.column] || context.fieldMeta;
      context.fieldMeta = fieldMeta;
      context.currentMasterValue = masterValue;
      context.currentCaptainValue = captainValue;
      context.revalidatedAt = new Date().toISOString();

      const freshness = classifyConflictFreshness({
        originalMaster: legacyTypedConflictValue(context.masterValue, fieldMeta, context.masterNormalized),
        originalCaptain: legacyTypedConflictValue(context.captainValue, fieldMeta, context.captainNormalized),
        currentMaster: masterValue,
        currentCaptain: captainValue,
        fieldMeta,
      });
      if (freshness === 'equivalent') {
        resolved++;
        context.revalidationStatus = 'equivalent';
        db.run(
          `UPDATE conflicts
           SET status='resolved', resolution_notes=?, existing_value=?, incoming_value=?, context_json=?
           WHERE id=?`,
          [
            'Auto-resolved: current master and captain values are equivalent under Field Dictionary type rules.',
            displayCellValue(masterValue, fieldMeta),
            displayCellValue(captainValue, fieldMeta),
            JSON.stringify(context),
            row.id,
          ]
        );
        continue;
      }

      const changed = freshness === 'stale';
      context.revalidationStatus = changed ? 'stale' : 'current';
      if (changed) stale++;
      db.run(
        `UPDATE conflicts
         SET resolution_notes=?, existing_value=?, incoming_value=?, context_json=?
         WHERE id=?`,
        [
          changed
            ? 'Stale: current sheet values changed after this conflict was recorded; run a fresh pull.'
            : 'Revalidated: this is still a genuine typed disagreement.',
          displayCellValue(masterValue, fieldMeta),
          displayCellValue(captainValue, fieldMeta),
          JSON.stringify(context),
          row.id,
        ]
      );
    } catch (error) {
      stale++;
      db.run('UPDATE conflicts SET resolution_notes=? WHERE id=?', [
        `Revalidation unavailable: ${String((error as Error)?.message || error)}`,
        row.id,
      ]);
    }
  }
  return { checked, resolved, stale };
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
  const fieldMeta = pullFieldMetaForHeaders(trimHeaders(masterGrid[0]));
  const plan = planPullToMaster(masterGrid, captainGrid, { policies, fieldMeta });
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
      fieldMeta: change.fieldMeta,
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
    const [grid, sourceGrid] = await Promise.all([
      readGrid(context.spreadsheetId, context.tabName),
      readGrid(context.sourceSpreadsheetId, context.sourceTab),
    ]);
    const headers = trimHeaders(grid[0]);
    const sourceHeaders = trimHeaders(sourceGrid[0]);
    const metadata = pullFieldMetaForHeaders(headers);

    const applicable: Array<{
      conflict: ConflictRow;
      value: CellValue;
      fieldMeta?: FieldCompareMeta;
    }> = [];
    for (const conflict of group.rows) {
      const conflictContext = parseConflictContext(conflict.context_json);
      const column = conflictContext?.column || conflict.column;
      if (isZoneDashboardSalesField(column)) {
        skipped++;
        ctx.log({
          spreadsheet: context.spreadsheetName,
          resident_id: conflict.resident_id,
          column,
          type: 'skip',
          message: 'Zone Dashboard owns this sales field; captain values can never be applied to it.',
        });
        continue;
      }
      const colIndex = headers.indexOf(column);
      const rowIndex = findRowByResidentId(grid, headers, conflict.resident_id);
      const sourceColIndex = sourceHeaders.indexOf(column);
      const sourceRowIndex = findRowByResidentId(sourceGrid, sourceHeaders, conflict.resident_id);
      const current = colIndex === -1 || rowIndex === -1 ? undefined : grid[rowIndex]?.[colIndex];
      const currentSource =
        sourceColIndex === -1 || sourceRowIndex === -1
          ? undefined
          : sourceGrid[sourceRowIndex]?.[sourceColIndex];
      const fieldMeta = metadata[column] || conflictContext?.fieldMeta;
      if (colIndex === -1 || rowIndex === -1 || sourceColIndex === -1 || sourceRowIndex === -1) {
        skipped++;
        ctx.log({
          spreadsheet: context.spreadsheetName,
          resident_id: conflict.resident_id,
          column,
          type: 'skip',
          message: 'That resident or column is no longer available on both the master and captain copies.',
        });
        continue;
      }
      if (cellValuesEqual(current, currentSource, fieldMeta)) {
        db.run("UPDATE conflicts SET status='resolved', resolution_notes=? WHERE id=?", [
          `Auto-resolved during apply by run #${ctx.runId}: current typed values are equivalent.`,
          conflict.id,
        ]);
        continue;
      }
      // Only apply when both live cells still mean what the Operator reviewed.
      const freshness = classifyConflictFreshness({
        originalMaster: legacyTypedConflictValue(
          conflictContext?.masterValue ?? conflict.existing_value,
          fieldMeta,
          conflictContext?.masterNormalized
        ),
        originalCaptain: legacyTypedConflictValue(
          conflictContext?.captainValue ?? conflict.incoming_value,
          fieldMeta,
          conflictContext?.captainNormalized
        ),
        currentMaster: current,
        currentCaptain: currentSource,
        fieldMeta,
      });
      if (freshness === 'stale') {
        stale++;
        db.run('UPDATE conflicts SET resolution_notes=? WHERE id=?', [
          'Stale: the master or captain value changed after this conflict was recorded. Re-run pull before applying.',
          conflict.id,
        ]);
        ctx.log({
          spreadsheet: context.spreadsheetName,
          resident_id: conflict.resident_id,
          column,
          type: 'conflict',
          existing_value: String(current ?? ''),
          incoming_value: String(currentSource ?? ''),
          message: 'The master or captain value changed since this conflict was logged, so it was left alone.',
        });
        continue;
      }
      applicable.push({ conflict, value: currentSource, fieldMeta });
    }
    if (applicable.length === 0) continue;

    const guarded = planGuardedCellWrites(
      grid,
      applicable.map(({ conflict, value, fieldMeta }) => ({
        residentId: conflict.resident_id,
        column: parseConflictContext(conflict.context_json)?.column || conflict.column,
        value,
        policy: 'overwrite' as const,
        fieldMeta,
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
      for (const { conflict } of applicable) {
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
        masterValue: conflict.masterValue,
        captainValue: conflict.captainValue,
        masterDisplay: displayCellValue(conflict.masterValue, conflict.fieldMeta),
        captainDisplay: displayCellValue(conflict.captainValue, conflict.fieldMeta),
        masterNormalized: conflict.masterNormalized,
        captainNormalized: conflict.captainNormalized,
        fieldMeta: conflict.fieldMeta,
        suspectedTextCoercion: conflict.suspectedTextCoercion,
        reason: conflict.suspectedTextCoercion
          ? 'A text-safe field contains a numeric raw value; review possible Google Sheets coercion manually.'
          : 'Master and captain values differ under the Field Dictionary type rules.',
        revalidationStatus: 'current',
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
          [runId, context.masterDisplay, context.captainDisplay, JSON.stringify(context), existingId]
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
            context.masterDisplay,
            context.captainDisplay,
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

function legacyTypedConflictValue(
  value: CellValue,
  fieldMeta?: FieldCompareMeta,
  normalized?: string
): CellValue {
  if (
    !normalized &&
    fieldMeta?.dataType === 'date' &&
    typeof value === 'string' &&
    /^-?\d+(\.\d+)?$/.test(value.trim())
  ) {
    return Number(value);
  }
  return value;
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
    .all<{ canonical_name: string }>(
      'SELECT canonical_name FROM dictionary_fields WHERE is_sensitive = 1 AND distribute_to_captain = 1'
    )
    .map((row) => row.canonical_name);
  const distributedColumns = captainDistributedHeaders(trimHeaders(captainGrid[0]));
  const freshPlan = planPushMissingResidents(
    captainGrid,
    filterGridByTombstones(masterGrid, loadActiveTombstones(db)),
    { sensitiveColumns: sensitive, distributedColumns }
  );
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
    `SELECT id, spreadsheet_id, spreadsheet_name, tab_name, resident_id, after_json, metadata_json
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
      headers: metadataHeaders(row.metadata_json),
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
      if (/no longer present/i.test(item.reason)) {
        markSnapshotsReverted(ctx.runId, [item.snapshotId]);
      }
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
    throw new Error('Mapbox is not connected. Zone checks need access to the Mapbox zone dataset.');
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
            range: google.a1Range(group.tabName, `${google.columnLetter(restore.col - 1)}${restore.row}`),
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
          range: google.a1Range(group.tabName, `${google.columnLetter(colIndex)}1`),
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
    throw new Error('Mapbox is not connected. Zone checks need access to the Mapbox zone dataset.');
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
  const allowProductionMaster = ctx.params.allowProductionMaster === true;

  const appendSnapshots = db.all<SnapshotRow>(
    `SELECT id, spreadsheet_id, spreadsheet_name, tab_name, resident_id, after_json, metadata_json
     FROM run_snapshots
     WHERE run_id = ? AND operation = 'row_append' AND reverted_by_run_id IS NULL
     ORDER BY id`,
    [originalRunId]
  );
  let deleteSnapshots = db.all<SnapshotRow & { before_json: string }>(
    `SELECT id, spreadsheet_id, spreadsheet_name, tab_name, resident_id, after_json, before_json, metadata_json
     FROM run_snapshots
     WHERE run_id = ? AND operation = 'row_delete' AND reverted_by_run_id IS NULL
     ORDER BY id`,
    [originalRunId]
  );
  deleteSnapshots = await hydrateArchivedDeletionSnapshots(deleteSnapshots);
  if (appendSnapshots.length === 0 && deleteSnapshots.length === 0) {
    throw new Error('This move run has no remaining changes to revert.');
  }

  let deletedFromDest = 0;
  let restoredToSource = 0;
  let conflicts = 0;
  let skipped = 0;

  // 1) Remove unchanged appended rows from destination sheet(s).
  for (const group of groupSnapshots(appendSnapshots).values()) {
    if (!allowProductionMaster) assertNotProductionSheet(group.spreadsheetId, 'destination captain');
    ctx.reportProgress({ stage: 'reading', message: `Checking ${group.spreadsheetName} before undoing appends.` });
    const grid = await readGrid(group.spreadsheetId, group.tabName);
    const plan = planAppendRevert(
      grid,
      group.rows.map((row) => ({
        snapshotId: row.id,
        residentId: row.resident_id,
        row: parseRow(row.after_json),
        headers: metadataHeaders(row.metadata_json),
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
      if (/no longer present/i.test(item.reason)) {
        markSnapshotsReverted(ctx.runId, [item.snapshotId]);
      }
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
    if (!allowProductionMaster) assertNotProductionSheet(group.spreadsheetId, 'source captain');
    ctx.reportProgress({ stage: 'reading', message: `Checking ${group.spreadsheetName} before restoring rows.` });
    const grid = await readGrid(group.spreadsheetId, group.tabName);
    const restores = planRowRestores(
      grid,
      group.rows.map((row) => ({
        snapshotId: row.id,
        residentId: row.resident_id,
        row: parseRow((row as SnapshotRow & { before_json: string }).before_json || row.after_json),
        headers: metadataHeaders(row.metadata_json),
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

async function createZoneSheets(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const previewRunId = numberParam(ctx.params.previewRunId, 'previewRunId');
  const masterSpreadsheetId = String(ctx.params.masterSpreadsheetId || '').trim();
  const masterTab = String(ctx.params.masterTab || '').trim();
  const folderId = String(ctx.params.folderId || '').trim();
  const templateSpreadsheetId = String(ctx.params.templateSpreadsheetId || '').trim();
  const expectedFingerprint = String(ctx.params.fingerprint || '').trim();
  const approvedZones = stringArray(ctx.params.zones);
  if (
    !masterSpreadsheetId ||
    !masterTab ||
    !folderId ||
    !templateSpreadsheetId ||
    !expectedFingerprint ||
    approvedZones.length === 0
  ) {
    throw new Error('The approved zone-sheet creation plan is incomplete.');
  }

  ctx.reportProgress({
    stage: 'reading',
    message: 'Rechecking Mapbox, the master, and the captain folder before creating any files.',
  });
  const masterGrid = await readGrid(masterSpreadsheetId, masterTab);
  const captainSheets = await readCaptainFolder(folderId, 10);
  const features = await fetchZoneFeatures(loadZoneSource());
  const fresh = planMissingZoneSheets(
    filterGridByTombstones(masterGrid, loadActiveTombstones(db)),
    captainSheets,
    features,
    resolveZoneConfig(trimHeaders(masterGrid[0]))
  );
  if (fresh.errors.length > 0) throw new Error(fresh.errors.join('; '));
  const wanted = new Set(approvedZones);
  const zones = fresh.zones.filter((zone) => wanted.has(zone.zone));
  if (zones.length !== wanted.size || fingerprintMissingZoneSheets(zones) !== expectedFingerprint) {
    throw new Error(
      'The master, Mapbox boundaries, or captain folder changed after preview. No files were created. Run a fresh preview.'
    );
  }

  const templateMeta = await google.getSpreadsheetMeta(templateSpreadsheetId);
  const templateTab = templateMeta.tabs[0] || '';
  if (!templateTab) throw new Error('The selected captain template has no readable tab.');
  const templateGrid = await readGrid(templateSpreadsheetId, templateTab);
  const templateHeaders = trimHeaders(templateGrid[0]);
  for (const required of ['resident_id', 'address_id', 'ZoneName', 'NC Name', 'NC Phone', 'NC Email']) {
    if (!templateHeaders.includes(required)) {
      throw new Error(`The captain template is missing required column "${required}".`);
    }
  }

  const created: Array<{ zone: string; fileId: string; fileName: string; webViewLink: string; residents: number }> = [];
  for (const zone of zones) {
    ctx.reportProgress({
      stage: 'creating',
      message: `Creating and populating ${zone.fileName}.`,
    });
    const operationToken = `${ctx.runId}:${randomUUID()}`;
    const createdRecord = db.run(
      `INSERT INTO run_created_files (run_id, file_id, file_name, web_view_link, modified_time)
       VALUES (?, ?, ?, ?, ?)`,
      [ctx.runId, `intent:${operationToken}`, zone.fileName, '', '']
    );
    let file: google.CreatedSpreadsheetFile;
    try {
      file = await google.copySpreadsheetToFolder(
        templateSpreadsheetId,
        folderId,
        zone.fileName,
        operationToken
      );
    } catch (copyError) {
      const recovered = await google.findSpreadsheetByOperationToken(folderId, operationToken);
      if (!recovered) throw copyError;
      file = recovered;
    }
    db.run(
      `UPDATE run_created_files
       SET file_id=?, file_name=?, web_view_link=?, modified_time=?
       WHERE id=?`,
      [file.id, file.name, file.webViewLink, file.modifiedTime, Number(createdRecord.lastInsertRowid)]
    );
    const copiedMeta = await google.getSpreadsheetMeta(file.id);
    const copiedTab = copiedMeta.tabs[0] || '';
    if (!copiedTab) throw new Error(`${file.name} was created without a readable tab.`);
    await google.clearValues(file.id, google.a1Range(copiedTab, 'A2:ZZ'));
    const currentFile = await google.getDriveFile(file.id);
    db.run('UPDATE run_created_files SET modified_time=? WHERE id=?', [
      currentFile.modifiedTime,
      Number(createdRecord.lastInsertRowid),
    ]);
    created.push({
      zone: zone.zone,
      fileId: file.id,
      fileName: file.name,
      webViewLink: file.webViewLink,
      residents: zone.residents.length,
    });
    ctx.log({
      spreadsheet: file.name,
      type: 'zone_sheet_create',
      incoming_value: zone.zone,
      message: `Created an empty formatted captain sheet. ${zone.residents.length} resident row(s) await reconciliation.`,
    });
  }

  return {
    previewRunId,
    sheetsCreated: created.length,
    addressesIncluded: zones.reduce((sum, zone) => sum + zone.addresses.length, 0),
    residentsPendingReconciliation: created.reduce((sum, file) => sum + file.residents, 0),
    created,
    revertAvailable: true,
  };
}

async function revertCreateZoneSheets(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const originalRunId = numberParam(ctx.params.originalRunId, 'originalRunId');
  const files = db.all<{
    id: number;
    file_id: string;
    file_name: string;
    modified_time: string;
  }>(
    `SELECT id, file_id, file_name, modified_time FROM run_created_files
     WHERE run_id=? AND reverted_by_run_id IS NULL ORDER BY id`,
    [originalRunId]
  );
  if (files.length === 0) throw new Error('This run has no remaining created zone sheets to undo.');
  let trashed = 0;
  let conflicts = 0;
  for (const file of files) {
    ctx.reportProgress({ stage: 'checking', message: `Checking ${file.file_name} before Undo.` });
    if (file.file_id.startsWith('intent:')) {
      const operationToken = file.file_id.slice('intent:'.length);
      const recovered = await google.findSpreadsheetByOperationToken('', operationToken);
      if (!recovered) {
        db.run('UPDATE run_created_files SET reverted_by_run_id=? WHERE id=?', [ctx.runId, file.id]);
        continue;
      }
      db.run(
        `UPDATE run_created_files
         SET file_id=?, file_name=?, web_view_link=?, modified_time=?
         WHERE id=?`,
        [recovered.id, recovered.name, recovered.webViewLink, recovered.modifiedTime, file.id]
      );
      conflicts++;
      ctx.log({
        spreadsheet: recovered.name,
        type: 'conflict',
        message:
          'SheetSmart recovered this file after an interrupted creation, but could not prove whether it was edited afterward. It was left in Drive for review.',
      });
      continue;
    }
    const current = await google.getDriveFile(file.file_id);
    if (current.trashed) {
      db.run('UPDATE run_created_files SET reverted_by_run_id=? WHERE id=?', [ctx.runId, file.id]);
      continue;
    }
    if (current.modifiedTime !== file.modified_time) {
      conflicts++;
      ctx.log({
        spreadsheet: file.file_name,
        type: 'conflict',
        message: 'This created sheet changed after the run, so SheetSmart left it in Drive.',
      });
      continue;
    }
    await google.trashDriveFile(file.file_id);
    db.run('UPDATE run_created_files SET reverted_by_run_id=? WHERE id=?', [ctx.runId, file.id]);
    trashed++;
  }
  return {
    revertedRunId: originalRunId,
    filesTrashed: trashed,
    conflicts,
    message:
      conflicts > 0
        ? 'Unchanged created sheets were moved to Trash; edited sheets were preserved.'
        : 'The created captain-zone sheets were moved to Trash.',
  };
}

async function applyDashboardDeletion(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const operationId = String(ctx.params.operationId || '').trim();
  if (!operationId) throw new Error('A deletion operation ID is required.');
  const operation = db.get<{
    operation_id: string;
    action: 'delete_person' | 'delete_address';
    actor: string;
    zone: string;
    address_id: string;
    requested_at: string;
  }>(
    `SELECT operation_id, action, actor, zone, address_id, requested_at
     FROM deletion_operations
     WHERE operation_id=? AND action IN ('delete_person','delete_address')`,
    [operationId]
  );
  if (!operation) throw new Error('That deletion operation is no longer available.');
  acquireLifecycleOperationLock(ctx.runId, operationId);
  const archiveIndex = db.all<{ resident_id: string; address_id: string }>(
    `SELECT resident_id, address_id FROM deletion_archive_index
     WHERE operation_id=? ORDER BY resident_id`,
    [operationId]
  );
  const residentIds = [...new Set(archiveIndex.map((row) => row.resident_id).filter(Boolean))];
  if (operation.action === 'delete_person' && residentIds.length !== 1) {
    throw new Error('A person deletion must identify exactly one resident.');
  }
  const producerRecords = await loadDeletedRecordsForOperation(operationId);

  const master = db.get<{ google_id: string; source_tab: string; name: string }>(
    "SELECT google_id, source_tab, name FROM connections WHERE type='master' ORDER BY id LIMIT 1"
  );
  const folder = db.get<{ google_id: string }>(
    "SELECT google_id FROM connections WHERE type='captain_folder' ORDER BY id LIMIT 1"
  );
  if (!master || !folder) throw new Error('Connect the master and captain folder before applying deletions.');

  ctx.reportProgress({ stage: 'reading', message: 'Finding every remaining copy of the deleted record.' });
  const masterMeta = await google.getSpreadsheetMeta(master.google_id);
  const masterTab = master.source_tab || masterMeta.tabs[0] || '';
  if (!masterTab) throw new Error('The master spreadsheet has no readable tab.');
  const masterGrid = await readGrid(master.google_id, masterTab);
  const captainSheets = await readCaptainFolder(folder.google_id, 10);
  const sheets: DeletionSheet[] = [
    {
      spreadsheetId: master.google_id,
      spreadsheetName: master.name,
      tabName: masterTab,
      zone: '',
      grid: masterGrid,
    },
    ...captainSheets,
  ];
  const plan =
    operation.action === 'delete_address'
      ? planAddressDeletion(sheets, operation.address_id)
      : planPersonDeletion(sheets, residentIds[0]);
  const meaningfulBlocks = plan.blocked.filter((block) => block.code !== 'not_found');
  if (meaningfulBlocks.length > 0) {
    throw new Error(meaningfulBlocks.map((block) => block.message).join(' '));
  }
  if (plan.deletions.length === 0) {
    db.run(
      `UPDATE deletion_operations
       SET status='applied', applied_run_id=?, error='', updated_at=datetime('now')
       WHERE operation_id=?`,
      [ctx.runId, operationId]
    );
    return { operationId, rowsDeleted: 0, message: 'No remaining live copies were found; the tombstone is active.' };
  }

  const affectedCaptainIds = [
    ...new Set(
      [...plan.deletions, ...plan.placeholders]
        .map((item) => item.spreadsheetId)
        .filter((id) => id !== master.google_id)
    ),
  ];
  const tabBySpreadsheet = new Map<string, string>([[master.google_id, masterTab]]);
  await mapLimit(affectedCaptainIds, 5, async (spreadsheetId) => {
    const meta = await google.getSpreadsheetMeta(spreadsheetId);
    const tab = meta.tabs[0] || '';
    if (!tab) throw new Error(`${meta.title || spreadsheetId} has no readable tab.`);
    tabBySpreadsheet.set(spreadsheetId, tab);
  });
  for (const item of [...plan.deletions, ...plan.placeholders]) {
    item.tabName = tabBySpreadsheet.get(item.spreadsheetId) || item.tabName;
    if ('archive' in item) item.archive.tabName = item.tabName;
  }
  return applySoftDashboardDeletion(ctx, operation, plan);
}

/*
 * Retained temporarily for migration reference only. Structural row deletion
 * is intentionally disabled in favor of reversible soft-delete markers.
  if (!operation) throw new Error('That deletion operation is no longer available.');
  const plannedArchiveKeys = new Set(
    plan.archives.map((archive) =>
      [archive.residentId, archive.addressId, archive.spreadsheetId, archive.tabName].join('\u0000')
    )
  );
  const producerPlaceholders =
    operation.action === 'delete_person'
      ? findProducerPlaceholders(sheets, producerRecords, operation.address_id)
      : [];
  await mapLimit(
    [...new Set(plan.deletions.map((item) => item.spreadsheetId))],
    5,
    async (spreadsheetId) => assertDeletionSheetLockable(spreadsheetId)
  );

  ctx.reportProgress({ stage: 'archiving', message: 'Archiving remaining sheet copies before deleting anything.' });
  await appendDeletionArchives(ctx, operation, plan.archives);

  const snapshots = db.transaction(() => {
    for (const record of producerRecords) {
      const key = [record.residentId, record.addressId, record.sourceSheetId, record.sourceSheetTab].join('\u0000');
      if (plannedArchiveKeys.has(key)) continue;
      const headers = Object.keys(record.fullRow);
      db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, ?, ?, 'row_delete', ?, '', ?, 'null', ?)`,
        [
          ctx.runId,
          record.sourceSheetId,
          record.sourceSheetId,
          record.sourceSheetTab,
          record.residentId,
          'null',
          JSON.stringify({
            kind: 'dashboard_source_deletion',
            operationId,
            addressId: record.addressId,
            headers,
          }),
        ]
      );
    }
    for (const placeholder of plan.placeholders) {
      const residentCol = placeholder.headers.indexOf('resident_id');
      const residentId = String(placeholder.row[residentCol] || '');
      db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, '', ?, 'row_append', ?, '', 'null', ?, ?)`,
        [
          ctx.runId,
          placeholder.spreadsheetId,
          placeholder.tabName,
          residentId,
          JSON.stringify(placeholder.row),
          JSON.stringify({
            kind: 'dashboard_deletion_placeholder',
            operationId,
            addressId: placeholder.addressId,
            headers: placeholder.headers,
          }),
        ]
      );
    }
    for (const placeholder of producerPlaceholders) {
      db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, ?, ?, 'row_append', ?, '', 'null', ?, ?)`,
        [
          ctx.runId,
          placeholder.spreadsheetId,
          placeholder.spreadsheetName,
          placeholder.tabName,
          placeholder.residentId,
          JSON.stringify(placeholder.row),
          JSON.stringify({
            kind: 'dashboard_source_placeholder',
            operationId,
            addressId: operation.address_id,
            headers: placeholder.headers,
          }),
        ]
      );
    }
  });
  snapshots();

  const placeholdersBySheet = groupBySheet(plan.placeholders);
  for (const group of placeholdersBySheet.values()) {
    ctx.assertLease();
    const rows = group.items.map((item) => item.row);
    const result = await google.appendValues(
      group.spreadsheetId,
      google.a1Range(group.tabName, 'A:ZZ'),
      rows
    );
    if (result.updatedRows !== rows.length) {
      throw new Error(`Google created ${result.updatedRows} of ${rows.length} required address placeholders.`);
    }
  }

  const deletionsBySheet = groupBySheet(plan.deletions);
  let rowsDeleted = 0;
  for (const group of deletionsBySheet.values()) {
    const properties = await google.getSheetProperties(group.spreadsheetId);
    const sheet = properties.find((item) => item.title === group.tabName);
    if (!sheet) throw new Error(`Tab "${group.tabName}" no longer exists.`);
    const protectedSheetId = sheet.sheetId;
    const clientEmail = (google.getClientEmail() || '').trim();
    if (!clientEmail) throw new Error('Google service-account identity is unavailable for the deletion safety lock.');
    await reconcileSheetSafetyLocks(group.spreadsheetId, ctx.runId);
    const protectionDescription = `SheetSmart deletion ${operationId} run ${ctx.runId}`;
    ctx.assertLease();
    let protectedRangeId: number | null = null;
    try {
      const protectionReplies = await google.batchUpdateSpreadsheet(group.spreadsheetId, [
        {
          addProtectedRange: {
            protectedRange: {
              range: { sheetId: protectedSheetId },
              description: protectionDescription,
              warningOnly: false,
              editors: { users: [clientEmail] },
            },
          },
        },
      ]);
      protectedRangeId =
        protectionReplies[0]?.addProtectedRange?.protectedRange?.protectedRangeId ?? null;
    } catch (error) {
      const committed = (await google.listProtectedRanges(group.spreadsheetId)).filter(
        (range) => range.description === protectionDescription
      );
      if (committed.length !== 1) throw error;
      protectedRangeId = committed[0].protectedRangeId;
    }
    if (protectedRangeId == null) {
      const committed = (await google.listProtectedRanges(group.spreadsheetId)).filter(
        (range) => range.description === protectionDescription
      );
      if (committed.length === 1) protectedRangeId = committed[0].protectedRangeId;
    }
    if (protectedRangeId == null) throw new Error(`Could not temporarily lock ${group.tabName} for safe deletion.`);
    const lockId = protectedRangeId;
    db.run(
      `INSERT OR REPLACE INTO sheet_safety_locks
         (spreadsheet_id, protected_range_id, operation_id, run_id)
       VALUES (?, ?, ?, ?)`,
      [group.spreadsheetId, lockId, operationId, ctx.runId]
    );
    try {
    const currentGrid = await readGrid(group.spreadsheetId, group.tabName);
    const currentSheet: DeletionSheet = {
      spreadsheetId: group.spreadsheetId,
      spreadsheetName: group.items[0]?.archive.spreadsheetName || group.spreadsheetId,
      tabName: group.tabName,
      zone: group.items[0]?.zone || '',
      grid: currentGrid,
    };
    const refreshed =
      operation.action === 'delete_address'
        ? planAddressDeletion([currentSheet], operation.address_id)
        : planPersonDeletion([currentSheet], residentIds[0]);
    const expectedByIdentity = new Map(
      group.items.map((item) => [
        `${item.residentId}\u0000${item.addressId}`,
        fingerprintArchivedPayload(
          Object.fromEntries(
            item.archive.headers.map((header, index) => [header, item.archive.row[index] ?? ''])
          )
        ),
      ])
    );
    if (refreshed.deletions.length !== group.items.length) {
      throw new Error(`Rows changed in ${currentSheet.spreadsheetName} after preview. No rows were deleted there.`);
    }
    for (const deletion of refreshed.deletions) {
      const key = `${deletion.residentId}\u0000${deletion.addressId}`;
      const currentFingerprint = fingerprintArchivedPayload(
        Object.fromEntries(
          deletion.archive.headers.map((header, index) => [header, deletion.archive.row[index] ?? ''])
        )
      );
      if (expectedByIdentity.get(key) !== currentFingerprint) {
        throw new Error(
          `A row changed in ${currentSheet.spreadsheetName} after it was archived. No rows were deleted there.`
        );
      }
    }
    db.transaction(() => {
      for (const deletion of refreshed.deletions) {
        db.run(
          `INSERT INTO run_snapshots
             (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
              range_a1, before_json, after_json, metadata_json)
           VALUES (?, ?, ?, ?, 'row_delete', ?, ?, ?, 'null', ?)`,
          [
            ctx.runId,
            deletion.spreadsheetId,
            deletion.archive.spreadsheetName,
            deletion.tabName,
            deletion.residentId,
            google.a1Range(deletion.tabName, `${deletion.rowNumber}:${deletion.rowNumber}`),
            'null',
            JSON.stringify({
              kind: 'dashboard_deletion',
              operationId,
              addressId: deletion.addressId,
              headers: deletion.archive.headers,
            }),
          ]
        );
      }
    })();
    const ordered = [...refreshed.deletions].sort((left, right) => right.rowNumber - left.rowNumber);
    ctx.assertLease();
    await google.batchUpdateSpreadsheet(
      group.spreadsheetId,
      ordered.map((deletion) => ({
        deleteDimension: {
          range: {
            sheetId: protectedSheetId,
            dimension: 'ROWS',
            startIndex: deletion.rowNumber - 1,
            endIndex: deletion.rowNumber,
          },
        },
      }))
    );
    rowsDeleted += ordered.length;
    } finally {
      await google.removeProtectedRangeCleanup(group.spreadsheetId, lockId);
      db.run(
        'DELETE FROM sheet_safety_locks WHERE spreadsheet_id=? AND protected_range_id=?',
        [group.spreadsheetId, lockId]
      );
    }
  }

  db.run(
    `UPDATE deletion_operations
     SET status='applied', applied_run_id=?, error='', updated_at=datetime('now')
     WHERE operation_id=?`,
    [ctx.runId, operationId]
  );
  ctx.log({
    type: 'dashboard_deletion',
    resident_id: operation.action === 'delete_person' ? residentIds[0] : '',
    message:
      operation.action === 'delete_address'
        ? `Applied an address deletion requested by ${operation.actor}.`
        : `Applied a person deletion requested by ${operation.actor}.`,
  });
  return {
    operationId,
    action: operation.action,
    rowsDeleted,
    placeholdersCreated: plan.placeholders.length,
    sheetsChanged: deletionsBySheet.size + placeholdersBySheet.size,
    revertAvailable: true,
  };
}

*/
async function applySoftDashboardDeletion(
  ctx: JobContext,
  operation: {
    operation_id: string;
    action: 'delete_person' | 'delete_address';
    actor: string;
    zone: string;
    address_id: string;
    requested_at: string;
  },
  plan: DeletionPlan
): Promise<unknown> {
  ctx.reportProgress({ stage: 'archiving', message: 'Verifying the private archive before marking records deleted.' });
  await appendDeletionArchives(ctx, operation, plan.archives);
  const groups = groupBySheet(plan.deletions);
  let rowsMarked = 0;
  for (const group of groups.values()) {
    ctx.assertLease();
    let grid = await readGrid(group.spreadsheetId, group.tabName);
    let headers = (grid[0] || []).map((value) => String(value ?? '').trim());
    let markerCol = headers.indexOf('Deleted Record');
    if (markerCol === -1) {
      markerCol = headers.length;
      await google.updateValuesChunked(group.spreadsheetId, [
        {
          range: google.a1Range(group.tabName, `${google.columnLetter(markerCol)}1`),
          values: [['Deleted Record']],
        },
      ]);
      grid = grid.map((row, index) => (index === 0 ? [...row, 'Deleted Record'] : [...row, '']));
      headers = [...headers, 'Deleted Record'];
    }
    const currentSheet: DeletionSheet = {
      spreadsheetId: group.spreadsheetId,
      spreadsheetName: group.items[0]?.archive.spreadsheetName || group.spreadsheetId,
      tabName: group.tabName,
      zone: group.items[0]?.zone || '',
      grid,
    };
    const residentIds = [...new Set(group.items.map((item) => item.residentId).filter(Boolean))];
    const refreshed =
      operation.action === 'delete_address'
        ? planAddressDeletion([currentSheet], operation.address_id)
        : planPersonDeletion([currentSheet], residentIds[0]);
    const expected = new Map(
      group.items.map((item) => [
        `${item.residentId}\u0000${item.addressId}`,
        fingerprintArchivedPayload(
          Object.fromEntries(
            item.archive.headers.map((header, index) => [header, item.archive.row[index] ?? ''])
          )
        ),
      ])
    );
    if (refreshed.deletions.length !== group.items.length) {
      throw new Error(`Rows changed in ${currentSheet.spreadsheetName}. Nothing was marked deleted there.`);
    }
    const pending = refreshed.deletions.filter((deletion) => {
      const current = String(grid[deletion.rowNumber - 1]?.[markerCol] ?? '').trim();
      if (current && current !== operation.operation_id) {
        throw new Error(`A record in ${currentSheet.spreadsheetName} is already marked by another deletion.`);
      }
      const key = `${deletion.residentId}\u0000${deletion.addressId}`;
      const fingerprint = fingerprintArchivedPayload(
        Object.fromEntries(
          deletion.archive.headers.map((header, index) => [header, deletion.archive.row[index] ?? ''])
        )
      );
      if (expected.get(key) !== fingerprint) {
        throw new Error(`A record changed in ${currentSheet.spreadsheetName}. Nothing was marked deleted there.`);
      }
      return current !== operation.operation_id;
    });
    db.transaction(() => {
      for (const deletion of pending) {
        db.run(
          `INSERT INTO run_snapshots
             (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
              range_a1, before_json, after_json, metadata_json)
           VALUES (?, ?, ?, ?, 'cell_update', ?, ?, ?, ?, ?)`,
          [
            ctx.runId,
            deletion.spreadsheetId,
            deletion.archive.spreadsheetName,
            deletion.tabName,
            deletion.residentId,
            google.a1Range(
              deletion.tabName,
              `${google.columnLetter(markerCol)}${deletion.rowNumber}`
            ),
            JSON.stringify(grid[deletion.rowNumber - 1]?.[markerCol] ?? ''),
            JSON.stringify(operation.operation_id),
            JSON.stringify({
              kind: 'dashboard_soft_deletion',
              operationId: operation.operation_id,
              addressId: deletion.addressId,
              column: 'Deleted Record',
            }),
          ]
        );
      }
    })();
    if (pending.length > 0) {
      ctx.assertLease();
      await google.updateValuesChunked(
        group.spreadsheetId,
        pending.map((deletion) => ({
          range: google.a1Range(
            deletion.tabName,
            `${google.columnLetter(markerCol)}${deletion.rowNumber}`
          ),
          values: [[operation.operation_id]],
        }))
      );
    }
    const verified = await readGrid(group.spreadsheetId, group.tabName);
    const verifiedHeaders = (verified[0] || []).map((value) => String(value ?? '').trim());
    const residentCol = verifiedHeaders.indexOf('resident_id');
    const addressCol = verifiedHeaders.indexOf('address_id');
    const verifiedMarkerCol = verifiedHeaders.indexOf('Deleted Record');
    if (residentCol === -1 || addressCol === -1 || verifiedMarkerCol === -1) {
      throw new Error(`Required identity or deletion columns disappeared from ${currentSheet.spreadsheetName}.`);
    }
    const expectedKeys = new Set(expected.keys());
    const markedRows = verified
      .slice(1)
      .map((row, index) => ({ row, rowNumber: index + 2 }))
      .filter(({ row }) => String(row[verifiedMarkerCol] ?? '').trim() === operation.operation_id);
    const wrongRows = markedRows.filter(({ row }) => {
      const key = `${String(row[residentCol] ?? '').trim()}\u0000${String(row[addressCol] ?? '').trim()}`;
      return !expectedKeys.has(key);
    });
    const actualKeys = new Set(
      markedRows.map(({ row }) =>
        `${String(row[residentCol] ?? '').trim()}\u0000${String(row[addressCol] ?? '').trim()}`
      )
    );
    if (wrongRows.length > 0 || [...expectedKeys].some((key) => !actualKeys.has(key))) {
      if (wrongRows.length > 0) {
        await google.updateValuesChunked(
          group.spreadsheetId,
          wrongRows.map(({ rowNumber }) => ({
            range: google.a1Range(
              group.tabName,
              `${google.columnLetter(verifiedMarkerCol)}${rowNumber}`
            ),
            values: [['']],
          }))
        );
      }
      throw new Error(
        `Rows moved while ${currentSheet.spreadsheetName} was being updated. The unsafe marks were removed; retry after edits stop.`
      );
    }
    rowsMarked += pending.length;
  }
  db.run(
    `UPDATE deletion_operations
     SET status='applied', applied_run_id=?, error='', updated_at=datetime('now')
     WHERE operation_id=?`,
    [ctx.runId, operation.operation_id]
  );
  return {
    operationId: operation.operation_id,
    action: operation.action,
    rowsMarked,
    sheetsChanged: groups.size,
    storage: 'soft_delete',
    revertAvailable: true,
  };
}

async function revertDashboardDeletion(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const originalRunId = numberParam(ctx.params.originalRunId, 'originalRunId');
  const operation = db.get<{ operation_id: string }>(
    `SELECT d.operation_id
     FROM deletion_operations d
     LEFT JOIN deletion_attempt_runs a ON a.operation_id=d.operation_id
     WHERE d.applied_run_id=? OR a.run_id=?
     LIMIT 1`,
    [originalRunId, originalRunId]
  );
  if (!operation) throw new Error('The deletion operation could not be found.');
  acquireLifecycleOperationLock(ctx.runId, operation.operation_id);
  const newerResidentDeletion = db.get(
    `SELECT 1
     FROM resident_tombstones current
     JOIN deletion_archive_index original ON original.resident_id=current.resident_id
     WHERE original.operation_id=? AND current.active=1 AND current.operation_id<>?
     LIMIT 1`,
    [operation.operation_id, operation.operation_id]
  );
  const newerAddressDeletion = db.get(
    `SELECT 1
     FROM address_tombstones current
     JOIN deletion_archive_index original ON original.address_id=current.address_id
     WHERE original.operation_id=? AND current.active=1 AND current.operation_id<>?
     LIMIT 1`,
    [operation.operation_id, operation.operation_id]
  );
  if (newerResidentDeletion || newerAddressDeletion) {
    throw new Error('Undo is blocked because one of these records was deleted again later.');
  }
  const attemptRunIds = db
    .all<{ run_id: number }>(
      `SELECT run_id FROM deletion_attempt_runs WHERE operation_id=? ORDER BY run_id DESC`,
      [operation.operation_id]
    )
    .map((row) => row.run_id);
  if (attemptRunIds.length === 0) attemptRunIds.push(originalRunId);
  const restorableAttemptIds = attemptRunIds.filter(
    (runId) =>
      (db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM run_snapshots
         WHERE run_id=? AND operation IN ('row_append','row_delete','cell_update')
           AND reverted_by_run_id IS NULL`,
        [runId]
      )?.n || 0) > 0
  );
  let conflicts = 0;
  let skipped = 0;
  let deletedFromDest = 0;
  let restoredToSource = 0;
  let restoredCells = 0;
  for (const attemptRunId of restorableAttemptIds) {
    const counts = db.get<{ row_changes: number; cell_changes: number }>(
      `SELECT
         SUM(CASE WHEN operation IN ('row_append','row_delete') THEN 1 ELSE 0 END) AS row_changes,
         SUM(CASE WHEN operation='cell_update' THEN 1 ELSE 0 END) AS cell_changes
       FROM run_snapshots WHERE run_id=? AND reverted_by_run_id IS NULL`,
      [attemptRunId]
    );
    if ((counts?.row_changes || 0) > 0) {
      const result = (await revertMoveCopy({
        ...ctx,
        params: { ...ctx.params, originalRunId: attemptRunId, allowProductionMaster: true },
      })) as {
        conflicts?: number;
        skipped?: number;
        deletedFromDest?: number;
        restoredToSource?: number;
      };
      conflicts += result.conflicts || 0;
      skipped += result.skipped || 0;
      deletedFromDest += result.deletedFromDest || 0;
      restoredToSource += result.restoredToSource || 0;
    }
    if ((counts?.cell_changes || 0) > 0) {
      const result = (await revertCellCopy({
        ...ctx,
        params: { ...ctx.params, originalRunId: attemptRunId },
      })) as { conflicts?: number; skipped?: number; restored?: number };
      conflicts += result.conflicts || 0;
      skipped += result.skipped || 0;
      restoredCells += result.restored || 0;
    }
  }
  const placeholders = attemptRunIds.map(() => '?').join(',');
  const remaining =
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM run_snapshots
       WHERE run_id IN (${placeholders})
         AND operation IN ('row_append','row_delete','cell_update')
         AND reverted_by_run_id IS NULL`,
      attemptRunIds
    )?.n || 0;
  if (remaining === 0 && conflicts === 0) {
    db.transaction(() => {
      db.run(
        `UPDATE resident_tombstones SET active=0, restored_at=datetime('now')
         WHERE operation_id=?`,
        [operation.operation_id]
      );
      db.run(
        `UPDATE address_tombstones SET active=0, restored_at=datetime('now')
         WHERE operation_id=?`,
        [operation.operation_id]
      );
      db.run(
        `UPDATE deletion_operations SET status='restored', updated_at=datetime('now')
         WHERE operation_id=?`,
        [operation.operation_id]
      );
    })();
  }
  return {
    conflicts,
    skipped,
    deletedFromDest,
    restoredToSource,
    restoredCells,
    operationId: operation.operation_id,
    attemptsRestored: attemptRunIds.length,
    tombstoneCleared: remaining === 0 && conflicts === 0,
    nextStep:
      'If Mapbox boundaries changed since the deletion, run the boundary-change workflow to move the restored address to its current zone.',
  };
}

async function appendDeletionArchives(
  ctx: JobContext,
  operation: {
    operation_id: string;
    action: string;
    actor: string;
    zone: string;
    requested_at: string;
    address_id: string;
  },
  archives: ArchivedDeletionRow[]
): Promise<void> {
  const config = operationsConfig();
  if (!config.spreadsheetId) throw new Error('Set the private operations spreadsheet before applying deletions.');
  await assertOperationsWorkbookPrivate(config);
  const prepared = archives.map((archive) => {
    const fullRow = Object.fromEntries(
      archive.headers.map((header, index) => [header, archive.row[index] ?? ''])
    );
    return { archive, fullRow, payloadFingerprint: fingerprintArchivedPayload(fullRow) };
  });
  const missing = prepared.filter((item) => {
    const existing = db.get<{ archive_fingerprint: string }>(
        `SELECT archive_fingerprint FROM deletion_archive_index
         WHERE operation_id=? AND resident_id=? AND address_id=? AND source_sheet_id=? AND source_sheet_tab=?`,
      [
          operation.operation_id,
          item.archive.residentId,
          item.archive.addressId,
          item.archive.spreadsheetId,
          item.archive.tabName,
      ]
    );
    if (!existing) return true;
    if (existing.archive_fingerprint !== item.payloadFingerprint) {
      throw new Error(
        `Archived evidence for ${item.archive.residentId || item.archive.addressId} no longer matches the live row. No deletion was attempted.`
      );
    }
    return false;
  });
  if (missing.length === 0) return;
  const rows = missing.map(({ archive, fullRow }) => {
    const nameIndex = archive.headers.indexOf('Resident Name');
    const addressIndex = archive.headers.indexOf('Address');
    return [
      operation.operation_id,
      OPERATIONS_SCHEMA_VERSION,
      operation.action,
      operation.actor,
      archive.zone || operation.zone,
      operation.requested_at,
      archive.residentId,
      archive.addressId,
      String(archive.row[nameIndex] || ''),
      addressIndex === -1 ? '' : String(archive.row[addressIndex] || ''),
      archive.spreadsheetId,
      archive.tabName,
      JSON.stringify(fullRow),
    ];
  });
  try {
    ctx.assertLease();
    const result = await google.appendValues(
      config.spreadsheetId,
      google.a1Range(config.deletedRecordsTab, 'A:M'),
      rows
    );
    if (result.updatedRows !== rows.length) {
      throw new Error(`The archive saved ${result.updatedRows} of ${rows.length} rows.`);
    }
  } catch (error) {
    const parsed = parseDeletedRecords(
      await google.readValues(config.spreadsheetId, google.a1Range(config.deletedRecordsTab, 'A:M'))
    );
    const committed = parsed.errors.length === 0 && missing.every((item) =>
      parsed.records.some(
        (record) =>
          record.operationId === operation.operation_id &&
          record.residentId === item.archive.residentId &&
          record.addressId === item.archive.addressId &&
          record.sourceSheetId === item.archive.spreadsheetId &&
          record.sourceSheetTab === item.archive.tabName &&
          fingerprintArchivedPayload(record.fullRow) === item.payloadFingerprint
      )
    );
    if (!committed) throw error;
  }
  db.transaction(() => {
    for (const item of missing) {
      const archive = item.archive;
      db.run(
        `INSERT OR IGNORE INTO deletion_archive_index
           (operation_id, resident_id, address_id, source_sheet_id, source_sheet_tab, archive_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          operation.operation_id,
          archive.residentId,
          archive.addressId,
          archive.spreadsheetId,
          archive.tabName,
          item.payloadFingerprint,
        ]
      );
    }
  })();
}

function operationsConfig(): {
  spreadsheetId: string;
  deletedRecordsTab: string;
  activityEventsTab: string;
  allowedWriterEmails: string[];
} {
  const fallback = {
    spreadsheetId: '',
    deletedRecordsTab: 'Deleted Records',
    activityEventsTab: 'Activity Events',
    allowedWriterEmails: [] as string[],
  };
  try {
    return { ...fallback, ...JSON.parse(db.getSetting('operations_workbook_v1', '{}')) };
  } catch {
    return fallback;
  }
}

async function loadDeletedRecordsForOperation(operationId: string): Promise<DeletedRecord[]> {
  const config = operationsConfig();
  if (!config.spreadsheetId) throw new Error('Set the private operations spreadsheet before applying deletions.');
  await assertOperationsWorkbookPrivate(config);
  const grid = await google.readValues(
    config.spreadsheetId,
    google.a1Range(config.deletedRecordsTab, 'A:M')
  );
  const parsed = parseDeletedRecords(grid);
  if (parsed.errors.length > 0) {
    throw new Error('The Deleted Records archive contains invalid rows. Refresh activity to see what needs fixing.');
  }
  const records = parsed.records.filter((record) => record.operationId === operationId);
  if (records.length === 0) throw new Error('The deletion archive no longer contains this operation.');
  const indexedRows = db.all<{
    resident_id: string;
    address_id: string;
    source_sheet_id: string;
    source_sheet_tab: string;
    archive_fingerprint: string;
  }>(
    `SELECT resident_id, address_id, source_sheet_id, source_sheet_tab, archive_fingerprint
     FROM deletion_archive_index WHERE operation_id=?`,
    [operationId]
  );
  const recordByKey = new Map(
    records.map((record) => [
      [record.residentId, record.addressId, record.sourceSheetId, record.sourceSheetTab].join('\u0000'),
      record,
    ])
  );
  for (const indexed of indexedRows) {
    const key = [
      indexed.resident_id,
      indexed.address_id,
      indexed.source_sheet_id,
      indexed.source_sheet_tab,
    ].join('\u0000');
    const record = recordByKey.get(key);
    if (!record || indexed.archive_fingerprint !== fingerprintArchivedPayload(record.fullRow)) {
      throw new Error('A required deletion archive row is missing or changed. No live sheets were changed.');
    }
  }
  if (indexedRows.length !== records.length) {
    throw new Error('The deletion archive and its private index no longer agree. No live sheets were changed.');
  }
  for (const record of records) {
    const indexed = db.get<{ archive_fingerprint: string }>(
      `SELECT archive_fingerprint FROM deletion_archive_index
       WHERE operation_id=? AND resident_id=? AND address_id=? AND source_sheet_id=? AND source_sheet_tab=?`,
      [
        record.operationId,
        record.residentId,
        record.addressId,
        record.sourceSheetId,
        record.sourceSheetTab,
      ]
    );
    if (!indexed || indexed.archive_fingerprint !== fingerprintArchivedPayload(record.fullRow)) {
      throw new Error('A deletion archive row was changed after ingestion. No live sheets were changed.');
    }
  }
  return records;
}

async function hydrateArchivedDeletionSnapshots(
  snapshots: Array<SnapshotRow & { before_json: string }>
): Promise<Array<SnapshotRow & { before_json: string }>> {
  const cache = new Map<string, DeletedRecord[]>();
  const hydrated: Array<SnapshotRow & { before_json: string }> = [];
  for (const snapshot of snapshots) {
    if (snapshot.before_json && snapshot.before_json !== 'null') {
      hydrated.push(snapshot);
      continue;
    }
    let metadata: { kind?: string; operationId?: string; addressId?: string; headers?: string[] } = {};
    try {
      metadata = JSON.parse(snapshot.metadata_json || '{}');
    } catch {
      /* validated below */
    }
    if (!String(metadata.kind || '').startsWith('dashboard_') || !metadata.operationId) {
      throw new Error('A deletion snapshot is missing its protected archive reference.');
    }
    let records = cache.get(metadata.operationId);
    if (!records) {
      records = await loadDeletedRecordsForOperation(metadata.operationId);
      cache.set(metadata.operationId, records);
    }
    const record = records.find(
      (item) =>
        item.sourceSheetId === snapshot.spreadsheet_id &&
        item.sourceSheetTab === snapshot.tab_name &&
        item.residentId === snapshot.resident_id &&
        (!metadata.addressId || item.addressId === metadata.addressId)
    );
    if (!record) throw new Error('The private archive no longer contains a row required for Undo.');
    const headers = metadata.headers || Object.keys(record.fullRow);
    hydrated.push({
      ...snapshot,
      before_json: JSON.stringify(headers.map((header) => record.fullRow[header] as CellValue)),
    });
  }
  return hydrated;
}

async function assertOperationsWorkbookPrivate(config: ReturnType<typeof operationsConfig>): Promise<void> {
  const allowed = new Set([
    (google.getClientEmail() || '').toLowerCase(),
    ...config.allowedWriterEmails.map((email) => email.toLowerCase()),
  ]);
  const unsafe = (await google.listDrivePermissions(config.spreadsheetId)).some(
    (permission) =>
      permission.type !== 'user' ||
      (permission.role !== 'owner' && !allowed.has(permission.emailAddress.toLowerCase()))
  );
  if (unsafe) {
    throw new Error(
      'The operations workbook is no longer private. No deletion was attempted; fix its Drive sharing first.'
    );
  }
}

async function assertDeletionSheetLockable(spreadsheetId: string): Promise<void> {
  const clientEmail = (google.getClientEmail() || '').trim().toLowerCase();
  const owners = (await google.listDrivePermissions(spreadsheetId)).filter(
    (permission) => permission.role === 'owner'
  );
  if (!clientEmail || owners.length !== 1 || owners[0].emailAddress.toLowerCase() !== clientEmail) {
    throw new Error(
      'Automatic row deletion is paused for safety: Google Sheets cannot prevent a human file owner from moving rows during deletion. No sheet rows were changed.'
    );
  }
}

async function reconcileSheetSafetyLocks(
  spreadsheetId: string,
  currentRunId?: number
): Promise<void> {
  const indexed = db.all<{ protected_range_id: number; run_id: number }>(
    'SELECT protected_range_id, run_id FROM sheet_safety_locks WHERE spreadsheet_id=?',
    [spreadsheetId]
  );
  const activeIds = new Set<number>();
  for (const lock of indexed) {
    const run = db.get<{ status: string }>('SELECT status FROM runs WHERE id=?', [lock.run_id]);
    if (lock.run_id !== currentRunId && run && ['queued', 'running'].includes(run.status)) {
      activeIds.add(lock.protected_range_id);
    }
  }
  if (activeIds.size > 0) {
    throw new Error('Another SheetSmart deletion still holds this sheet safety lock.');
  }
  const remote = (await google.listProtectedRanges(spreadsheetId)).filter((range) =>
    range.description.startsWith('SheetSmart deletion ')
  );
  for (const range of remote) {
    await google.removeProtectedRangeCleanup(spreadsheetId, range.protectedRangeId);
    db.run(
      'DELETE FROM sheet_safety_locks WHERE spreadsheet_id=? AND protected_range_id=?',
      [spreadsheetId, range.protectedRangeId]
    );
  }
  db.run(
    `DELETE FROM sheet_safety_locks
     WHERE spreadsheet_id=? AND protected_range_id NOT IN (${remote.map(() => '?').join(',') || 'NULL'})`,
    [spreadsheetId, ...remote.map((range) => range.protectedRangeId)]
  );
}

export async function reconcileOrphanedSheetSafetyLocks(): Promise<void> {
  const spreadsheetIds = db
    .all<{ spreadsheet_id: string }>('SELECT DISTINCT spreadsheet_id FROM sheet_safety_locks')
    .map((row) => row.spreadsheet_id);
  for (const spreadsheetId of spreadsheetIds) {
    try {
      await reconcileSheetSafetyLocks(spreadsheetId);
    } catch {
      // An active run owns the lock, or Google is temporarily unavailable.
      // The next startup or deletion retry will try again.
    }
  }
}

function findProducerPlaceholders(
  sheets: DeletionSheet[],
  records: DeletedRecord[],
  addressId: string
): Array<{
  spreadsheetId: string;
  spreadsheetName: string;
  tabName: string;
  residentId: string;
  headers: string[];
  row: CellValue[];
}> {
  const placeholderId = `__address_placeholder__:${addressId}`;
  const bySource = new Map(records.map((record) => [record.sourceSheetId, record]));
  const found: Array<{
    spreadsheetId: string;
    spreadsheetName: string;
    tabName: string;
    residentId: string;
    headers: string[];
    row: CellValue[];
  }> = [];
  for (const sheet of sheets) {
    const source = bySource.get(sheet.spreadsheetId);
    if (!source) continue;
    const headers = trimHeaders(sheet.grid[0]);
    const residentCol = headers.indexOf('resident_id');
    const row = sheet.grid.slice(1).find(
      (candidate) => String(candidate?.[residentCol] ?? '').trim() === placeholderId
    );
    if (!row) continue;
    found.push({
      spreadsheetId: sheet.spreadsheetId,
      spreadsheetName: sheet.spreadsheetName || sheet.spreadsheetId,
      tabName: source.sourceSheetTab,
      residentId: placeholderId,
      headers,
      row: headers.map((_header, index) => row[index] ?? ''),
    });
  }
  return found;
}

function groupBySheet<T extends { spreadsheetId: string; tabName: string }>(
  items: T[]
): Map<string, { spreadsheetId: string; tabName: string; items: T[] }> {
  const groups = new Map<string, { spreadsheetId: string; tabName: string; items: T[] }>();
  for (const item of items) {
    const key = `${item.spreadsheetId}\u0000${item.tabName}`;
    const group = groups.get(key) || {
      spreadsheetId: item.spreadsheetId,
      tabName: item.tabName,
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  return groups;
}

const ADDRESS_INTAKE_HEADERS: Partial<AddressHeaders> = {
  addressId: 'address_id',
  apn: 'APN',
  house: '_SitusHouseNo',
  direction: '_SitusDirection',
  street: '_SitusStreet',
  unit: '_SitusUnit',
  city: 'City',
  state: 'State',
  zip: 'Zip',
  latitude: 'Latitude',
  longitude: 'Longitude',
};

interface ApprovedIntakeAddress extends AddressPlaceholder {
  resident_id: string;
  zoneFields: Record<string, string>;
  captainSpreadsheetId: string;
  captainSpreadsheetName: string;
}

async function applyAddressIntake(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const sourceConnectionId = numberParam(ctx.params.sourceConnectionId, 'sourceConnectionId');
  const expectedFingerprint = String(ctx.params.expectedFingerprint || '').trim();
  const approved = Array.isArray(ctx.params.addresses)
    ? (ctx.params.addresses as ApprovedIntakeAddress[])
    : [];
  if (!expectedFingerprint || approved.length < 1 || approved.length > 250) {
    throw new Error('The approved address intake plan is incomplete.');
  }
  const source = db.get<{ google_id: string; source_tab: string }>(
    "SELECT google_id, source_tab FROM connections WHERE id=? AND type='external'",
    [sourceConnectionId]
  );
  const master = db.get<{ google_id: string; source_tab: string; name: string }>(
    "SELECT google_id, source_tab, name FROM connections WHERE type='master' ORDER BY id LIMIT 1"
  );
  const folder = db.get<{ google_id: string }>(
    "SELECT google_id FROM connections WHERE type='captain_folder' ORDER BY id LIMIT 1"
  );
  if (!source || !master || !folder) throw new Error('The source, master, or captain folder is no longer connected.');

  ctx.reportProgress({ stage: 'reading', message: 'Rechecking the address source, master, captains, and Mapbox.' });
  const dictionary = loadDictionaryAliases();
  const sourceMeta = await google.getSpreadsheetMeta(source.google_id);
  const sourceTab = source.source_tab || sourceMeta.tabs[0] || '';
  const masterMeta = await google.getSpreadsheetMeta(master.google_id);
  const masterTab = master.source_tab || masterMeta.tabs[0] || '';
  if (!sourceTab || !masterTab) throw new Error('The source or master has no readable tab.');
  const sourceRaw = await readGrid(source.google_id, sourceTab);
  const masterRaw = await readGrid(master.google_id, masterTab);
  const sourceHeaders = canonicalizeHeaders(sourceRaw[0] || [], dictionary);
  const masterHeaders = canonicalizeHeaders(masterRaw[0] || [], dictionary);
  if (sourceHeaders.errors.length || masterHeaders.errors.length) {
    throw new Error([...sourceHeaders.errors, ...masterHeaders.errors].join(' '));
  }
  const sourceGrid: Grid = [sourceHeaders.headers, ...sourceRaw.slice(1)];
  const masterGrid: Grid = [masterHeaders.headers, ...masterRaw.slice(1)];
  const captainSheets = (await readCaptainFolder(folder.google_id, 10)).map((sheet) => {
    const canonical = canonicalizeHeaders(sheet.grid[0] || [], dictionary);
    if (canonical.errors.length) throw new Error(`${sheet.spreadsheetName}: ${canonical.errors.join(' ')}`);
    const grid = [canonical.headers, ...sheet.grid.slice(1)] as Grid;
    return {
      ...sheet,
      zone: detectSheetZoneWithName(canonical.headers, grid.slice(1), sheet.spreadsheetName),
      grid,
    };
  });
  const captainRows: AddressRow[] = [];
  for (const sheet of captainSheets) {
    captainRows.push(...gridToAddressObjects(sheet.grid));
  }
  const deletedAddresses = await activeDeletedAddressEvidence();
  const fresh = planAddressIntake(
    gridToAddressObjects(sourceGrid),
    [...gridToAddressObjects(masterGrid), ...deletedAddresses.rows],
    captainRows,
    {
      externalHeaders: addressHeadersForGrid(sourceGrid[0] || []),
      masterHeaders: addressHeadersForGrid(masterGrid[0] || []),
      captainHeaders: ADDRESS_INTAKE_HEADERS,
      requiredFields: ['house', 'street', 'city', 'state', 'zip'],
      maxBatchSize: 250,
      placeholderIdPrefix: 'addr_',
    }
  );
  if (fresh.errors.length || fresh.fingerprint !== expectedFingerprint) {
    throw new Error('The source, master, or captain sheets changed after preview. Run a fresh address scan.');
  }

  const freshById = new Map(fresh.placeholders.map((row) => [row.address_id, row]));
  let mapboxAvailable = false;
  let intakeFeatures: Awaited<ReturnType<typeof fetchZoneFeatures>> = {
    type: 'FeatureCollection',
    features: [],
  };
  if (isMapboxConfigured()) {
    try {
      intakeFeatures = await fetchZoneFeatures(loadZoneSource());
      mapboxAvailable = true;
    } catch {
      // Zone classification is optional for intake. A transient Mapbox failure
      // must not prevent a valid address from entering the master.
    }
  }
  const spatial = buildSpatialIndex(intakeFeatures);
  let zoneAssignmentsDeferred = 0;
  let captainPublishingDeferred = 0;
  for (const expected of approved) {
    const current = freshById.get(expected.address_id);
    if (!current || current.fingerprint !== expected.fingerprint) {
      throw new Error(`Address ${expected.address_id} no longer matches the approved preview.`);
    }
    if (deletedAddresses.addressIds.has(expected.address_id)) {
      throw new Error(`Address ${expected.address_id} is tombstoned and must be restored instead of imported.`);
    }
    let currentZoneFields: Record<string, string> = {};
    if (
      mapboxAvailable &&
      current.latitude !== '' &&
      current.longitude !== ''
    ) {
      const matches = findContainingFeatures(spatial, [Number(current.longitude), Number(current.latitude)]);
      if (matches.length === 1 && String(matches[0].properties?.ZoneName ?? '').trim()) {
        currentZoneFields = Object.fromEntries(
          ZONE_OUTPUT_FIELDS.map((field) => [
            field.canonical,
            String(matches[0].properties?.[field.property] ?? '').trim(),
          ])
        );
      }
    }
    if (JSON.stringify(currentZoneFields) !== JSON.stringify(expected.zoneFields)) {
      // Master admission is authoritative for this workflow; stale or
      // unavailable derived zoning falls back to an unzoned master row.
      expected.zoneFields = {};
      expected.captainSpreadsheetId = '';
      expected.captainSpreadsheetName = '';
      zoneAssignmentsDeferred++;
      continue;
    }
    const currentDestinationSheets = currentZoneFields.ZoneName
      ? captainSheets.filter((sheet) => sheet.zone === currentZoneFields.ZoneName)
      : [];
    const currentDestinationId =
      currentDestinationSheets.length === 1 ? currentDestinationSheets[0].spreadsheetId : '';
    if (currentDestinationId !== String(expected.captainSpreadsheetId || '')) {
      expected.captainSpreadsheetId = '';
      expected.captainSpreadsheetName = '';
      captainPublishingDeferred++;
    }
  }

  const canonicalHeaders = masterHeaders.headers;
  const rows = approved.map((address) => intakeRow(canonicalHeaders, address));
  const guarded = planGuardedAppends(masterGrid, rows);
  if (guarded.errors.length || guarded.appends.length !== rows.length) {
    throw new Error(
      guarded.errors.join('; ') ||
        'One or more addresses now collide with an existing master identity. No addresses were added.'
    );
  }
  const plannedMasterGrid: Grid = [
    masterGrid[0],
    ...masterGrid.slice(1),
    ...rows,
  ];
  const candidatePublishMoves: AddressMoveCandidate[] = [];
  let zonedWithoutCaptainSheet = 0;
  for (let index = 0; index < approved.length; index++) {
    const address = approved[index];
    const toZone = String(address.zoneFields.ZoneName || '').trim();
    if (!toZone) continue;
    const destination = captainSheets.find(
      (sheet) => sheet.spreadsheetId === String(address.captainSpreadsheetId || '')
    );
    if (!destination) {
      zonedWithoutCaptainSheet++;
      continue;
    }
    candidatePublishMoves.push({
      kind: 'assign',
      addressId: address.address_id,
      displayAddress: [address.house, address.direction, address.street, address.unit].filter(Boolean).join(' '),
      fromZone: '',
      toZone,
      fromSpreadsheetId: '',
      fromSpreadsheetName: '',
      fromTabName: '',
      toSpreadsheetId: destination.spreadsheetId,
      toSpreadsheetName: destination.spreadsheetName,
      toTabName: '',
      destinationFields: address.zoneFields,
      residents: [
        {
          residentId: address.resident_id,
          residentName: '',
          sourcePresent: false,
          destinationPresent: false,
          sensitiveData: [],
          sourceRowHash: createHash('sha256')
            .update(JSON.stringify(rows[index].map((value) => String(value ?? ''))))
            .digest('hex'),
        },
      ],
    });
  }
  const publishMoves: AddressMoveCandidate[] = [];
  const movesByDestination = new Map<string, AddressMoveCandidate[]>();
  for (const move of candidatePublishMoves) {
    movesByDestination.set(move.toSpreadsheetId, [
      ...(movesByDestination.get(move.toSpreadsheetId) || []),
      move,
    ]);
  }
  for (const destinationMoves of movesByDestination.values()) {
    try {
      await hydrateMoveTabs(destinationMoves);
      await preflightFolderZoneWrites(destinationMoves, plannedMasterGrid);
      publishMoves.push(...destinationMoves);
    } catch {
      captainPublishingDeferred += destinationMoves.length;
      ctx.log({
        spreadsheet: destinationMoves[0].toSpreadsheetName,
        type: 'address_intake_publish_deferred',
        message: 'Addresses will enter the master, but this captain sheet was not safe to update.',
      });
    }
  }
  const snapshot = db.transaction(() => {
    for (const append of guarded.appends) {
      db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, ?, ?, 'row_append', ?, '', 'null', ?, ?)`,
        [
          ctx.runId,
          master.google_id,
          master.name,
          masterTab,
          append.residentId,
          JSON.stringify(append.row),
          JSON.stringify({ kind: 'address_intake', headers: trimHeaders(masterRaw[0]) }),
        ]
      );
    }
  });
  snapshot();
  const result = await google.appendValues(
    master.google_id,
    google.a1Range(masterTab, 'A:ZZ'),
    guarded.appends.map((append) => append.row)
  );
  if (result.updatedRows !== guarded.appends.length) {
    throw new Error(`Google added ${result.updatedRows} of ${guarded.appends.length} approved addresses.`);
  }
  const captainRowsAdded = await appendNewlyZonedResidents(ctx, publishMoves, plannedMasterGrid);
  ctx.log({
    spreadsheet: master.name,
    type: 'address_intake',
    message: `Added ${guarded.appends.length} address-only records from the approved external intake.`,
  });
  return {
    previewRunId: ctx.params.previewRunId,
    addressesAdded: guarded.appends.length,
    captainRowsAdded,
    zonedWithoutCaptainSheet,
    zoneAssignmentsDeferred,
    captainPublishingDeferred,
    updatedRange: result.updatedRange,
    nextStep:
      zonedWithoutCaptainSheet > 0 || zoneAssignmentsDeferred > 0 || captainPublishingDeferred > 0
        ? 'The addresses are in the master. Run the Mapbox boundary workflow later for any zone assignment or captain-sheet publication that was deferred.'
        : 'Every selected address with an existing captain zone was also added to that captain sheet.',
    revertAvailable: true,
  };
}

async function activeDeletedAddressEvidence(): Promise<{
  rows: AddressRow[];
  addressIds: Set<string>;
}> {
  const addressIds = new Set(
    db.all<{ address_id: string }>('SELECT address_id FROM address_tombstones WHERE active=1').map((row) => row.address_id)
  );
  if (addressIds.size === 0) return { rows: [], addressIds };
  const config = operationsConfig();
  if (!config.spreadsheetId) {
    throw new Error('Deleted-address evidence is active, but the private operations workbook is not configured.');
  }
  await assertOperationsWorkbookPrivate(config);
  const parsed = parseDeletedRecords(
    await google.readValues(config.spreadsheetId, google.a1Range(config.deletedRecordsTab, 'A:M'))
  );
  if (parsed.errors.length > 0) throw new Error('Fix the private Deleted Records archive before importing addresses.');
  const archivedAddressIds = new Set(parsed.records.map((record) => record.addressId));
  const missingEvidence = [...addressIds].filter((addressId) => !archivedAddressIds.has(addressId));
  if (missingEvidence.length > 0) {
    throw new Error('Address intake stopped because one or more active deleted addresses are missing archive evidence.');
  }
  return {
    rows: parsed.records
      .filter((record) => addressIds.has(record.addressId))
      .map((record) => record.fullRow as AddressRow),
    addressIds,
  };
}

function gridToAddressObjects(grid: Grid): AddressRow[] {
  const headers = trimHeaders(grid[0]);
  return grid.slice(1).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']))
  );
}

function addressHeadersForGrid(headers: CellValue[]): Partial<AddressHeaders> {
  const values = headers.map((value) => String(value ?? '').trim());
  const resolve = (candidates: string[]) => findColumn(values, candidates) || candidates[0];
  return {
    addressId: resolve(['address_id', 'Address ID']),
    apn: resolve(['APN', 'Parcel Number']),
    house: resolve(['_SitusHouseNo', 'Situs House Number', 'House Number', 'House']),
    direction: resolve(['_SitusDirection', 'Situs Direction', 'Direction']),
    street: resolve(['_SitusStreet', 'Situs Street', 'Street']),
    unit: resolve(['_SitusUnit', 'Situs Unit', 'Unit']),
    city: resolve(['City', 'Situs City']),
    state: resolve(['State', 'Situs State']),
    zip: resolve(['Zip', 'ZIP', 'Zip Code', 'Postal Code']),
    latitude: resolve(['Latitude', 'Lat']),
    longitude: resolve(['Longitude', 'Lon', 'Lng']),
  };
}

function intakeRow(headers: string[], address: ApprovedIntakeAddress): CellValue[] {
  const values: Record<string, CellValue> = {
    address_id: address.address_id,
    resident_id: address.resident_id,
    APN: address.apn,
    _SitusHouseNo: address.house,
    _SitusDirection: address.direction,
    _SitusStreet: address.street,
    _SitusUnit: address.unit,
    House: [address.house, address.direction].filter(Boolean).join(' '),
    Street: address.street,
    City: address.city,
    State: address.state,
    Zip: address.zip,
    Latitude: address.latitude,
    Longitude: address.longitude,
    ...address.zoneFields,
  };
  return headers.map((header) => values[header] ?? '');
}

async function folderCaptainImport(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const previewRunId = numberParam(ctx.params.previewRunId, 'previewRunId');
  const masterSpreadsheetId = String(ctx.params.masterSpreadsheetId || '').trim();
  const masterName = String(ctx.params.masterName || 'Master').trim();
  const masterTab = String(ctx.params.masterTab || '').trim();
  const folderId = String(ctx.params.folderId || '').trim();
  const expectedFingerprint = String(ctx.params.fingerprint || '').trim();
  const expectedDictionaryFingerprint = String(ctx.params.dictionaryFingerprint || '').trim();
  const approvedAddressIds = stringArray(ctx.params.addressIds);
  if (!masterSpreadsheetId || !masterTab || !folderId || !expectedFingerprint || !expectedDictionaryFingerprint) {
    throw new Error('The approved captain import plan is incomplete.');
  }
  if (approvedAddressIds.length === 0 || approvedAddressIds.length > 500) {
    throw new Error('One captain import run requires between 1 and 500 addresses.');
  }

  ctx.reportProgress({
    stage: 'reading',
    message: 'Rechecking the master and every captain sheet before adding approved residents.',
  });
  const masterGrid = await readGrid(masterSpreadsheetId, masterTab);
  const dictionary = loadDictionaryAliases();
  const tombstones = loadActiveTombstones(db);
  if (fingerprintDictionaryAliases(dictionary) !== expectedDictionaryFingerprint) {
    throw new Error('The Fields settings changed after preview. Nobody was added. Run a fresh scan.');
  }
  const masterHeaderResult = canonicalizeHeaders(masterGrid[0] || [], dictionary);
  if (masterHeaderResult.errors.length > 0) {
    throw new Error(`Master columns are ambiguous: ${masterHeaderResult.errors.join(' ')}`);
  }
  const canonicalMaster = filterGridByTombstones(
    [masterHeaderResult.headers, ...masterGrid.slice(1)] as Grid,
    tombstones
  );
  const captainSheets = (await readCaptainFolder(folderId, 10)).map((sheet) => {
    const headerResult = canonicalizeHeaders(sheet.grid[0] || [], dictionary);
    if (headerResult.errors.length > 0) {
      throw new Error(`${sheet.spreadsheetName}: ${headerResult.errors.join(' ')}`);
    }
    return {
      ...sheet,
      grid: filterGridByTombstones([headerResult.headers, ...sheet.grid.slice(1)] as Grid, tombstones),
    };
  });
  const fresh = planPullNewResidentsFromFolder(canonicalMaster, captainSheets, {
    requiredColumns: [],
    forbiddenColumns: db.zoneDashboardSalesHeaders(),
  });
  if (fresh.errors.length > 0) throw new Error(fresh.errors.join('; '));
  const approvedSet = new Set(approvedAddressIds);
  const addresses = fresh.addresses.filter((address) => approvedSet.has(address.addressId));
  if (
    addresses.length !== approvedAddressIds.length ||
    folderNewResidentsFingerprint(addresses) !== expectedFingerprint
  ) {
    throw new Error(
      'The master or captain folder changed after preview. Nobody was added. Run a fresh preview and approve that result.'
    );
  }

  const residents = addresses.flatMap((address) => address.residents);
  const guarded = planGuardedAppends(
    canonicalMaster,
    residents.map((resident) => resident.row)
  );
  if (guarded.errors.length > 0 || guarded.appends.length !== residents.length) {
    throw new Error(
      guarded.errors.join('; ') ||
        `Only ${guarded.appends.length} of ${residents.length} approved residents still pass the write guard. Nobody was added.`
    );
  }

  const candidateById = new Map<string, FolderNewResident>(
    residents.map((resident) => [resident.residentId, resident])
  );
  const headers = trimHeaders(masterGrid[0]);
  const snapshotIds: number[] = [];
  const snapshot = db.transaction(() => {
    for (const append of guarded.appends) {
      const resident = candidateById.get(append.residentId);
      const result = db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, ?, ?, 'row_append', ?, '', 'null', ?, ?)`,
        [
          ctx.runId,
          masterSpreadsheetId,
          masterName,
          masterTab,
          append.residentId,
          JSON.stringify(append.row),
          JSON.stringify({
            kind: 'folder_captain_import',
            previewRunId,
            headers,
            addressId: resident?.addressId || '',
            sourceSpreadsheetId: resident?.sourceSpreadsheetId || '',
            sourceSheet: resident?.sourceSpreadsheetName || '',
            captainRow: resident?.captainRow || null,
            risk: resident?.risk || 'none',
          }),
        ]
      );
      snapshotIds.push(Number(result.lastInsertRowid));
    }
  });
  snapshot();

  ctx.reportProgress({
    stage: 'writing',
    message: `Adding ${guarded.appends.length} approved captain-created resident row(s) to the master.`,
  });
  const result = await google.appendValues(
    masterSpreadsheetId,
    google.a1Range(masterTab, 'A:ZZ'),
    guarded.appends.map((append) => append.row)
  );
  if (result.updatedRows !== guarded.appends.length) {
    throw new Error(`Google appended ${result.updatedRows} of ${guarded.appends.length} approved rows.`);
  }
  if (snapshotIds.length > 0) {
    db.run(`UPDATE run_snapshots SET range_a1=? WHERE id IN (${snapshotIds.map(() => '?').join(',')})`, [
      result.updatedRange,
      ...snapshotIds,
    ]);
  }

  for (const append of guarded.appends) {
    const resident = candidateById.get(append.residentId);
    ctx.log({
      spreadsheet: masterName,
      row: result.updatedRange,
      resident_id: append.residentId,
      type: 'folder_captain_import',
      incoming_value: resident?.residentName || '',
      message: `Added from ${resident?.sourceSpreadsheetName || 'a captain sheet'} as part of approved address ${
        resident?.addressId || ''
      }.`,
    });
  }

  return {
    previewRunId,
    addressesImported: addresses.length,
    newAddresses: addresses.filter((address) => address.kind === 'new_address').length,
    existingAddresses: addresses.filter((address) => address.kind === 'existing_address').length,
    residentsImported: guarded.appends.length,
    warnedAddresses: addresses.filter((address) => address.risk !== 'none').length,
    updatedRange: result.updatedRange,
    revertAvailable: true,
  };
}

async function folderZoneReconcile(ctx: JobContext): Promise<unknown> {
  requireLive(ctx);
  const masterSpreadsheetId = String(ctx.params.masterSpreadsheetId || '').trim();
  const masterName = String(ctx.params.masterName || 'Master').trim();
  const masterTab = String(ctx.params.masterTab || '').trim();
  const folderId = String(ctx.params.folderId || '').trim();
  const expectedFingerprint = String(ctx.params.fingerprint || '').trim();
  const approvedAddressIds = stringArray(ctx.params.addressIds);
  if (!masterSpreadsheetId || !masterTab || !folderId || !expectedFingerprint) {
    throw new Error('The approved folder reconciliation plan is incomplete.');
  }
  if (approvedAddressIds.length > 500) {
    throw new Error('One reconciliation run is capped at 500 addresses.');
  }

  ctx.reportProgress({ stage: 'reading', message: 'Rechecking the master, captain folder, and Mapbox boundaries.' });
  const masterGrid = await readGrid(masterSpreadsheetId, masterTab);
  const captainSheets = await readCaptainFolder(folderId);
  const features = await fetchZoneFeatures(loadZoneSource());
  const cfg = resolveZoneConfig(trimHeaders(masterGrid[0]));
  const tombstones = loadActiveTombstones(db);
  const filteredMaster = filterGridByTombstones(masterGrid, tombstones, {
    residentHeader: cfg.identityHeader,
    addressHeader: findColumn(trimHeaders(masterGrid[0]), ['address_id', 'Address ID']),
  });
  const filteredCaptainSheets = captainSheets.map((sheet) => ({
    ...sheet,
    grid: filterGridByTombstones(sheet.grid, tombstones),
  }));
  const sensitiveFields = db
    .all<{ id: number; canonical_name: string }>(
      'SELECT id, canonical_name FROM dictionary_fields WHERE is_sensitive=1 ORDER BY sort_order'
    )
    .filter((field) => !['NC Name', 'NC Phone', 'NC Email', 'ZoneName'].includes(field.canonical_name))
    .map((field) => ({
      canonicalName: field.canonical_name,
      aliases: db
        .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id=? ORDER BY alias', [field.id])
        .map((row) => row.alias),
    }));
  const fresh = planFolderZoneReconciliation(filteredMaster, filteredCaptainSheets, features, cfg, {
    sensitiveFields,
  });
  if (fresh.registryErrors.length > 0) throw new Error(fresh.registryErrors.join('; '));
  const approvedSet = new Set(approvedAddressIds);
  const moves = fresh.moves.filter((move) => approvedSet.has(move.addressId));
  if (moves.length !== approvedAddressIds.length || fingerprintFolderZoneMoves(moves) !== expectedFingerprint) {
    throw new Error(
      'The master, captain folder, or Mapbox boundaries changed after preview. Nothing was written. Run a fresh preview.'
    );
  }
  await hydrateMoveTabs(moves);

  const selectedResidents = moves.flatMap((move) =>
    move.residents.map((resident) => ({
      residentId: resident.residentId,
      fields: move.destinationFields,
    }))
  );
  const allColumns = [...new Set(moves.flatMap((move) => Object.keys(move.destinationFields)))];
  const { headers, added, addedIndexes } = ensureHeaderColumns(masterGrid, allColumns);
  const masterWrites = planGuardedCellWrites(
    masterGrid,
    selectedResidents.flatMap((resident) =>
      Object.entries(resident.fields).map(([column, value]) => ({
        residentId: resident.residentId,
        column,
        value,
        policy: 'overwrite' as const,
      }))
    )
  );
  if (masterWrites.errors.length > 0) throw new Error(masterWrites.errors.join('; '));
  await preflightFolderZoneWrites(moves, masterGrid);

  const assignedResidents = await appendNewlyZonedResidents(
    ctx,
    moves.filter((move) => move.kind === 'assign'),
    masterGrid
  );
  let movedResidents = assignedResidents;
  const groups = groupAddressMoves(moves.filter((move) => move.kind === 'move'));
  for (const group of groups.values()) {
    ctx.reportProgress({
      stage: 'moving',
      message: `Moving ${group.residentIds.length} resident row(s): ${group.fromZone} → ${group.toZone}.`,
    });
    const [fromGrid, toGrid] = await Promise.all([
      readGrid(group.fromSpreadsheetId, group.fromTabName),
      readGrid(group.toSpreadsheetId, group.toTabName),
    ]);
    const guarded = planGuardedMoves(fromGrid, toGrid, group.residentIds, group.destinationFields);
    if (guarded.errors.length > 0 || guarded.moves.length !== group.residentIds.length) {
      throw new Error(
        guarded.errors.join('; ') ||
          `Only ${guarded.moves.length} of ${group.residentIds.length} residents could still move safely.`
      );
    }

    const appendSnapshotIds: number[] = [];
    const snapshotAppends = db.transaction(() => {
      for (const move of guarded.moves) {
        const result = db.run(
          `INSERT INTO run_snapshots
             (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
              range_a1, before_json, after_json, metadata_json)
           VALUES (?, ?, ?, ?, 'row_append', ?, '', 'null', ?, ?)`,
          [
            ctx.runId,
            group.toSpreadsheetId,
            group.toSpreadsheetName,
            group.toTabName,
            move.residentId,
            JSON.stringify(move.appendRow),
            JSON.stringify({
              kind: 'folder_zone_append',
              fromZone: group.fromZone,
              toZone: group.toZone,
              headers: trimHeaders(toGrid[0]),
            }),
          ]
        );
        appendSnapshotIds.push(Number(result.lastInsertRowid));
      }
    });
    snapshotAppends();
    const appendResult = await google.appendValues(
      group.toSpreadsheetId,
      google.a1Range(group.toTabName, 'A:ZZ'),
      guarded.moves.map((move) => move.appendRow)
    );
    if (appendResult.updatedRows !== guarded.moves.length) {
      throw new Error(`Google appended ${appendResult.updatedRows} of ${guarded.moves.length} approved rows.`);
    }
    if (appendSnapshotIds.length > 0) {
      db.run(
        `UPDATE run_snapshots SET range_a1=? WHERE id IN (${appendSnapshotIds.map(() => '?').join(',')})`,
        [appendResult.updatedRange, ...appendSnapshotIds]
      );
    }

    const currentSource = await readGrid(group.fromSpreadsheetId, group.fromTabName);
    const deletions = planGuardedDeletes(currentSource, group.residentIds);
    if (deletions.errors.length > 0 || deletions.deletions.length !== group.residentIds.length) {
      throw new Error(
        `Rows were added to ${group.toSpreadsheetName}, but not all source rows could be removed. Use Undo on this run.`
      );
    }
    const sourceSheet = (await google.getSheetProperties(group.fromSpreadsheetId)).find(
      (sheet) => sheet.title === group.fromTabName
    );
    if (!sourceSheet) throw new Error(`Source tab "${group.fromTabName}" no longer exists.`);
    const snapshotDeletes = db.transaction(() => {
      for (const deletion of deletions.deletions) {
        db.run(
          `INSERT INTO run_snapshots
             (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
              range_a1, before_json, after_json, metadata_json)
           VALUES (?, ?, ?, ?, 'row_delete', ?, ?, ?, 'null', ?)`,
          [
            ctx.runId,
            group.fromSpreadsheetId,
            group.fromSpreadsheetName,
            group.fromTabName,
            deletion.residentId,
            `${deletion.rowIndex + 1}:${deletion.rowIndex + 1}`,
            JSON.stringify(deletion.row),
            JSON.stringify({
              kind: 'folder_zone_delete',
              fromZone: group.fromZone,
              toZone: group.toZone,
              headers: trimHeaders(currentSource[0]),
            }),
          ]
        );
      }
    });
    snapshotDeletes();
    await google.batchUpdateSpreadsheet(
      group.fromSpreadsheetId,
      deletions.deletions.map((deletion) => ({
        deleteDimension: {
          range: {
            sheetId: sourceSheet.sheetId,
            dimension: 'ROWS',
            startIndex: deletion.rowIndex,
            endIndex: deletion.rowIndex + 1,
          },
        },
      }))
    );
    movedResidents += guarded.moves.length;
    for (const move of guarded.moves) {
      ctx.log({
        spreadsheet: `${group.fromSpreadsheetName} → ${group.toSpreadsheetName}`,
        resident_id: move.residentId,
        type: 'folder_zone_move',
        existing_value: group.fromZone,
        incoming_value: group.toZone,
        message: `Moved as part of an approved address-level Mapbox reconciliation.`,
      });
    }
  }

  // Captain-sheet membership changes happen first. If a destination/source
  // guard fails, the master remains untouched and does not claim a move that
  // never completed.
  if (added.length > 0) {
    const sheet = (await google.getSheetProperties(masterSpreadsheetId)).find((candidate) => candidate.title === masterTab);
    if (!sheet) throw new Error(`Master tab "${masterTab}" no longer exists.`);
    const columnsNeeded = headers.length - sheet.columnCount;
    if (columnsNeeded > 0) {
      await google.batchUpdateSpreadsheet(masterSpreadsheetId, [
        { appendDimension: { sheetId: sheet.sheetId, dimension: 'COLUMNS', length: columnsNeeded } },
      ]);
    }
    const updates = added.map((column, index) => ({
      range: google.a1Range(masterTab, `${google.columnLetter(addedIndexes[index] - 1)}1`),
      values: [[column]],
    }));
    const snapshotHeaders = db.transaction(() => {
      for (let index = 0; index < added.length; index++) {
        db.run(
          `INSERT INTO run_snapshots
             (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
              range_a1, before_json, after_json, metadata_json)
           VALUES (?, ?, ?, ?, 'cell_update', '', ?, '""', ?, ?)`,
          [
            ctx.runId,
            masterSpreadsheetId,
            masterName,
            masterTab,
            updates[index].range,
            JSON.stringify(added[index]),
            JSON.stringify({ kind: 'folder_zone_header', column: added[index] }),
          ]
        );
      }
    });
    snapshotHeaders();
    await google.updateValues(masterSpreadsheetId, updates);
  }

  const snapshotMaster = db.transaction(() => {
    for (const write of masterWrites.writes) {
      const range = google.a1Range(masterTab, `${google.columnLetter(write.col - 1)}${write.row}`);
      db.run(
        `INSERT INTO run_snapshots
           (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
            range_a1, before_json, after_json, metadata_json)
         VALUES (?, ?, ?, ?, 'cell_update', ?, ?, ?, ?, ?)`,
        [
          ctx.runId,
          masterSpreadsheetId,
          masterName,
          masterTab,
          write.residentId,
          range,
          JSON.stringify(write.before ?? ''),
          JSON.stringify(write.after ?? ''),
          JSON.stringify({ kind: 'folder_zone_master', column: write.column }),
        ]
      );
    }
  });
  snapshotMaster();
  ctx.reportProgress({ stage: 'writing_master', message: `Updating ${masterWrites.writes.length} master cells.` });
  await google.updateValuesChunked(
    masterSpreadsheetId,
    masterWrites.writes.map((write) => ({
      range: google.a1Range(masterTab, `${google.columnLetter(write.col - 1)}${write.row}`),
      values: [[write.after]],
    }))
  );

  return {
    addressesChanged: moves.length,
    addressesAssigned: moves.filter((move) => move.kind === 'assign').length,
    addressesMoved: moves.filter((move) => move.kind === 'move').length,
    residentsMoved: movedResidents,
    masterCellsUpdated: masterWrites.writes.length,
    revertAvailable: true,
  };
}

async function revertFolderZoneReconcile(ctx: JobContext): Promise<unknown> {
  const originalRunId = numberParam(ctx.params.originalRunId, 'originalRunId');
  const rowCount =
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM run_snapshots
       WHERE run_id=? AND operation IN ('row_append','row_delete') AND reverted_by_run_id IS NULL`,
      [originalRunId]
    )?.n || 0;
  const cellCount =
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM run_snapshots
       WHERE run_id=? AND operation='cell_update' AND reverted_by_run_id IS NULL`,
      [originalRunId]
    )?.n || 0;
  const moveResult = rowCount > 0 ? await revertMoveCopy(ctx) : null;
  const cellResult = cellCount > 0 ? await revertCellCopy(ctx) : null;
  return { moveResult, cellResult, message: 'The folder reconciliation was undone for every unchanged row and cell.' };
}

async function readCaptainFolder(folderId: string, concurrency = 5): Promise<CaptainSheetInput[]> {
  const files = await google.listSpreadsheetsInFolder(folderId);
  const sheets: CaptainSheetInput[] = [];
  await mapLimit(files, concurrency, async (file) => {
    const grid = (await google.readValues(file.id, 'A:ZZ')) as Grid;
    sheets.push({
      spreadsheetId: file.id,
      spreadsheetName: file.name,
      tabName: '',
      zone: detectSheetZoneWithName(trimHeaders(grid[0]), grid.slice(1), file.name),
      grid,
    });
  });
  sheets.sort(
    (left, right) =>
      left.spreadsheetId.localeCompare(right.spreadsheetId) ||
      left.spreadsheetName.localeCompare(right.spreadsheetName)
  );
  return sheets;
}

async function hydrateMoveTabs(moves: AddressMoveCandidate[]): Promise<void> {
  const tabBySpreadsheet = new Map<string, string>();
  const spreadsheetIds = [
    ...new Set(moves.flatMap((move) => [move.fromSpreadsheetId, move.toSpreadsheetId]).filter(Boolean)),
  ];
  for (const spreadsheetId of spreadsheetIds) {
    const meta = await google.getSpreadsheetMeta(spreadsheetId);
    const tab = meta.tabs[0] || '';
    if (!tab) throw new Error(`${meta.title || spreadsheetId} has no tab.`);
    tabBySpreadsheet.set(spreadsheetId, tab);
  }
  for (const move of moves) {
    move.fromTabName = move.fromSpreadsheetId ? tabBySpreadsheet.get(move.fromSpreadsheetId) || '' : '';
    move.toTabName = tabBySpreadsheet.get(move.toSpreadsheetId) || '';
  }
}

async function appendNewlyZonedResidents(
  ctx: JobContext,
  moves: AddressMoveCandidate[],
  masterGrid: Grid
): Promise<number> {
  if (moves.length === 0) return 0;
  const masterHeaders = trimHeaders(masterGrid[0]);
  const masterIdIndex = masterHeaders.indexOf('resident_id');
  if (masterIdIndex === -1) throw new Error('Master has no resident_id column.');
  const masterById = new Map<string, Grid[number]>();
  for (let index = 1; index < masterGrid.length; index++) {
    const residentId = String(masterGrid[index]?.[masterIdIndex] ?? '').trim();
    if (residentId && !masterById.has(residentId)) masterById.set(residentId, masterGrid[index]);
  }

  const byDestination = new Map<string, AddressMoveCandidate[]>();
  for (const move of moves) {
    const list = byDestination.get(move.toSpreadsheetId) || [];
    list.push(move);
    byDestination.set(move.toSpreadsheetId, list);
  }

  let appended = 0;
  for (const destinationMoves of byDestination.values()) {
    const destination = destinationMoves[0];
    const rawDestinationGrid = await readGrid(destination.toSpreadsheetId, destination.toTabName);
    const canonical = canonicalizeHeaders(rawDestinationGrid[0] || [], loadDictionaryAliases());
    if (canonical.errors.length > 0) {
      throw new Error(`${destination.toSpreadsheetName}: ${canonical.errors.join(' ')}`);
    }
    const destinationGrid = [canonical.headers, ...rawDestinationGrid.slice(1)] as Grid;
    const destinationHeaders = trimHeaders(canonical.headers);
    const distributedColumns = new Set(captainDistributedHeaders(destinationHeaders));
    for (const column of Object.keys(destination.destinationFields)) {
      if (!destinationHeaders.includes(column)) {
        throw new Error(`${destination.toSpreadsheetName} is missing required destination column "${column}".`);
      }
    }
    const rows: Grid = [];
    for (const move of destinationMoves) {
      for (const resident of move.residents) {
        const masterRow = masterById.get(resident.residentId);
        if (!masterRow) throw new Error(`Resident ${resident.residentId} disappeared from the master.`);
        const row = remapRowByHeaders(masterHeaders, masterRow, destinationHeaders, distributedColumns);
        for (const [column, value] of Object.entries(move.destinationFields)) {
          row[destinationHeaders.indexOf(column)] = value;
        }
        rows.push(row);
      }
    }
    const guarded = planGuardedAppends(destinationGrid, rows);
    if (guarded.errors.length > 0 || guarded.appends.length !== rows.length) {
      throw new Error(
        guarded.errors.join('; ') ||
          `Only ${guarded.appends.length} of ${rows.length} newly zoned resident rows can still be added safely.`
      );
    }

    const snapshotIds: number[] = [];
    const snapshot = db.transaction(() => {
      for (const row of guarded.appends) {
        const result = db.run(
          `INSERT INTO run_snapshots
             (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
              range_a1, before_json, after_json, metadata_json)
           VALUES (?, ?, ?, ?, 'row_append', ?, '', 'null', ?, ?)`,
          [
            ctx.runId,
            destination.toSpreadsheetId,
            destination.toSpreadsheetName,
            destination.toTabName,
            row.residentId,
            JSON.stringify(row.row),
            JSON.stringify({
              kind: 'folder_zone_assign',
              toZone: destination.toZone,
              headers: trimHeaders(rawDestinationGrid[0]),
            }),
          ]
        );
        snapshotIds.push(Number(result.lastInsertRowid));
      }
    });
    snapshot();
    ctx.reportProgress({
      stage: 'assigning',
      message: `Adding ${guarded.appends.length} newly zoned resident row(s) to ${destination.toSpreadsheetName}.`,
    });
    const result = await google.appendValues(
      destination.toSpreadsheetId,
      google.a1Range(destination.toTabName, 'A:ZZ'),
      guarded.appends.map((row) => row.row)
    );
    if (result.updatedRows !== guarded.appends.length) {
      throw new Error(`Google appended ${result.updatedRows} of ${guarded.appends.length} newly zoned rows.`);
    }
    if (snapshotIds.length > 0) {
      db.run(`UPDATE run_snapshots SET range_a1=? WHERE id IN (${snapshotIds.map(() => '?').join(',')})`, [
        result.updatedRange,
        ...snapshotIds,
      ]);
    }
    for (const row of guarded.appends) {
      ctx.log({
        spreadsheet: destination.toSpreadsheetName,
        resident_id: row.residentId,
        type: 'folder_zone_assign',
        incoming_value: destination.toZone,
        message: 'Added to a captain sheet because Mapbox now assigns this address to the zone.',
      });
    }
    appended += guarded.appends.length;
  }
  return appended;
}

async function preflightFolderZoneWrites(moves: AddressMoveCandidate[], masterGrid: Grid): Promise<void> {
  const masterHeaders = trimHeaders(masterGrid[0]);
  const masterIdIndex = masterHeaders.indexOf('resident_id');
  if (masterIdIndex === -1) throw new Error('Master has no resident_id column.');
  const masterById = new Map<string, Grid[number]>();
  for (let index = 1; index < masterGrid.length; index++) {
    const residentId = String(masterGrid[index]?.[masterIdIndex] ?? '').trim();
    if (residentId && !masterById.has(residentId)) masterById.set(residentId, masterGrid[index]);
  }

  const assignmentGroups = new Map<string, AddressMoveCandidate[]>();
  for (const move of moves.filter((candidate) => candidate.kind === 'assign')) {
    assignmentGroups.set(move.toSpreadsheetId, [...(assignmentGroups.get(move.toSpreadsheetId) || []), move]);
  }
  for (const destinationMoves of assignmentGroups.values()) {
    const destination = destinationMoves[0];
    const rawDestinationGrid = await readGrid(destination.toSpreadsheetId, destination.toTabName);
    const canonical = canonicalizeHeaders(rawDestinationGrid[0] || [], loadDictionaryAliases());
    if (canonical.errors.length > 0) {
      throw new Error(`${destination.toSpreadsheetName}: ${canonical.errors.join(' ')}`);
    }
    const destinationGrid = [canonical.headers, ...rawDestinationGrid.slice(1)] as Grid;
    const destinationHeaders = trimHeaders(canonical.headers);
    const distributedColumns = new Set(captainDistributedHeaders(destinationHeaders));
    const rows: Grid = [];
    for (const move of destinationMoves) {
      for (const resident of move.residents) {
        const masterRow = masterById.get(resident.residentId);
        if (!masterRow) throw new Error(`Resident ${resident.residentId} disappeared from the master.`);
        const row = remapRowByHeaders(masterHeaders, masterRow, destinationHeaders, distributedColumns);
        for (const [column, value] of Object.entries(move.destinationFields)) {
          const index = destinationHeaders.indexOf(column);
          if (index === -1) {
            throw new Error(`${destination.toSpreadsheetName} is missing required destination column "${column}".`);
          }
          row[index] = value;
        }
        rows.push(row);
      }
    }
    const guarded = planGuardedAppends(destinationGrid, rows);
    if (guarded.errors.length > 0 || guarded.appends.length !== rows.length) {
      throw new Error(
        guarded.errors.join('; ') ||
          `${destination.toSpreadsheetName} cannot safely receive every selected resident. Run a fresh scan after removing duplicates.`
      );
    }
  }

  for (const group of groupAddressMoves(moves.filter((move) => move.kind === 'move')).values()) {
    const [fromGrid, toGrid] = await Promise.all([
      readGrid(group.fromSpreadsheetId, group.fromTabName),
      readGrid(group.toSpreadsheetId, group.toTabName),
    ]);
    const guarded = planGuardedMoves(fromGrid, toGrid, group.residentIds, group.destinationFields);
    if (guarded.errors.length > 0 || guarded.moves.length !== group.residentIds.length) {
      const skipped = guarded.skipped.map((item) => `${item.residentId}: ${item.reason}`).join('; ');
      throw new Error(
        guarded.errors.join('; ') ||
          skipped ||
          `${group.toSpreadsheetName} cannot safely receive every selected resident.`
      );
    }
  }
}

function groupAddressMoves(moves: AddressMoveCandidate[]): Map<
  string,
  {
    fromZone: string;
    toZone: string;
    fromSpreadsheetId: string;
    fromSpreadsheetName: string;
    fromTabName: string;
    toSpreadsheetId: string;
    toSpreadsheetName: string;
    toTabName: string;
    destinationFields: Record<string, string>;
    residentIds: string[];
  }
> {
  const groups = new Map<
    string,
    {
      fromZone: string;
      toZone: string;
      fromSpreadsheetId: string;
      fromSpreadsheetName: string;
      fromTabName: string;
      toSpreadsheetId: string;
      toSpreadsheetName: string;
      toTabName: string;
      destinationFields: Record<string, string>;
      residentIds: string[];
    }
  >();
  for (const move of moves) {
    const key = `${move.fromSpreadsheetId}\u0000${move.toSpreadsheetId}`;
    const group = groups.get(key) || {
      fromZone: move.fromZone,
      toZone: move.toZone,
      fromSpreadsheetId: move.fromSpreadsheetId,
      fromSpreadsheetName: move.fromSpreadsheetName,
      fromTabName: move.fromTabName,
      toSpreadsheetId: move.toSpreadsheetId,
      toSpreadsheetName: move.toSpreadsheetName,
      toTabName: move.toTabName,
      destinationFields: move.destinationFields,
      residentIds: [],
    };
    group.residentIds.push(...move.residents.map((resident) => resident.residentId));
    groups.set(key, group);
  }
  return groups;
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function requireLive(ctx: JobContext): void {
  if (ctx.mode !== 'live') throw new Error('Execution tasks may run only in live mode.');
}

function assertCopyMaster(spreadsheetId: string): void {
  if (spreadsheetId === PRODUCTION_MASTER_SPREADSHEET_ID) {
    throw new Error('Blocked: this practice workflow can only use a copy of the master sheet.');
  }
}

function assertNotProductionSheet(spreadsheetId: string, label: string): void {
  if (spreadsheetId === PRODUCTION_MASTER_SPREADSHEET_ID) {
    throw new Error(`Blocked: the live master cannot be used as the ${label} practice sheet.`);
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

function loadDictionaryAliases(): DictionaryAliasSpec[] {
  return db
    .all<{ id: number; canonical_name: string }>(
      'SELECT id, canonical_name FROM dictionary_fields ORDER BY sort_order, id'
    )
    .map((field) => ({
      canonicalName: field.canonical_name,
      aliases: db
        .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id=? ORDER BY alias', [field.id])
        .map((row) => row.alias),
    }));
}

function captainDistributedHeaders(headers: string[]): string[] {
  return db
    .all<{ id: number; canonical_name: string }>(
      `SELECT id, canonical_name FROM dictionary_fields
       WHERE distribute_to_captain=1 ORDER BY sort_order, id`
    )
    .map((field) => {
      const aliases = db
        .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id=?', [field.id])
        .map((row) => row.alias);
      return findColumn(headers, [field.canonical_name, ...aliases]);
    })
    .filter((header): header is string => Boolean(header));
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

function metadataHeaders(json?: string): string[] | undefined {
  try {
    const value = JSON.parse(json || '{}') as { headers?: unknown };
    return Array.isArray(value.headers) ? value.headers.map((header) => String(header ?? '').trim()) : undefined;
  } catch {
    return undefined;
  }
}

function acquireLifecycleOperationLock(runId: number, operationId: string): void {
  db.transaction(() => {
    db.run(
      `DELETE FROM lifecycle_operation_locks
       WHERE run_id IN (SELECT id FROM runs WHERE status NOT IN ('queued','running'))`
    );
    const active = db.get<{ run_id: number }>(
      'SELECT run_id FROM lifecycle_operation_locks WHERE run_id<>? LIMIT 1',
      [runId]
    );
    if (active) {
      throw new Error('Another deletion or restoration is already changing resident lifecycle records.');
    }
    db.run(
      `INSERT OR IGNORE INTO lifecycle_operation_locks (run_id, operation_id) VALUES (?, ?)`,
      [runId, operationId]
    );
  })();
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

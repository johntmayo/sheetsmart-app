import type { Request, Response, Router } from 'express';
import type { Deps } from '../types';
import * as google from '../google';
import * as jobs from '../jobs';
import {
  APPLY_CONFLICT_COPY_TASK,
  DEFAULT_ENRICHMENT_TAB,
  ENRICH_ZONES_COPY_TASK,
  MOVE_RESIDENTS_COPY_TASK,
  PRODUCTION_MASTER_SPREADSHEET_ID,
  PULL_NEW_RESIDENTS_COPY_TASK,
  PULL_TO_MASTER_COPY_TASK,
  PUSH_MISSING_COPY_TASK,
  REVERT_APPEND_COPY_TASK,
  REVERT_CELL_COPY_TASK,
  REVERT_MOVE_COPY_TASK,
  pullCellKeys,
  pullPoliciesForHeaders,
  type EnrichZonesPreviewPlan,
  type MoveCopyTarget,
  type MoveResidentsPreviewPlan,
  type NewResidentsPreviewPlan,
  type PullToMasterPreviewPlan,
  type PushMissingPreviewPlan,
  type SafeCopyTarget,
} from '../executionTasks';
import { planPushMissingResidents, trimHeaders, type Grid } from '../lib/mergeEngine';
import { planGuardedAppends, planGuardedMoves } from '../lib/liveWriteEngine';
import {
  fingerprintPullCells,
  newResidentCellKeys,
  planPullNewResidents,
  planPullToMaster,
  type PullCellChange,
} from '../lib/pullEngine';
import { summarizePushMissing } from '../lib/previewEngine';
import {
  fingerprintCaptainMoves,
  planCaptainSheetMoves,
  planZoneEnrichment,
  type ZoneReconcileConfig,
} from '../lib/zoneEngine';
import {
  DEFAULT_MAPBOX_DATASET_ID,
  DEFAULT_MAPBOX_USERNAME,
  fetchZoneFeatures,
  isMapboxConfigured,
} from '../mapbox';
import { detectSheetZone, findColumn } from '../lib/columns';

const SAFE_COPY_TARGET_KEY = 'safe_copy_execution_target';
const SAFE_COPY_MOVE_TARGET_KEY = 'safe_copy_move_target';
const ZONE_SOURCE_KEY = 'zone_source_config';

interface RunRow {
  id: number;
  type: string;
  mode: string;
  status: string;
  summary_json: string;
}

interface CopyTargetInput {
  masterSpreadsheetId: string;
  masterTab: string;
  captainSpreadsheetId: string;
  captainTab: string;
  folderId: string;
}

interface MoveTargetInput {
  masterSpreadsheetId: string;
  masterTab: string;
  fromCaptainSpreadsheetId: string;
  fromCaptainTab: string;
  toCaptainSpreadsheetId: string;
  toCaptainTab: string;
  folderId: string;
  fromZoneOverride?: string;
  toZoneOverride?: string;
}

export default function registerSafeExecutionRoutes(api: Router, { db }: Deps): void {
  api.get('/execution/copy-target', (_req: Request, res: Response) => {
    res.json({ target: loadTarget(db), configured: Boolean(db.getSetting(SAFE_COPY_TARGET_KEY, '')) });
  });

  api.put('/execution/copy-target', async (req: Request, res: Response) => {
    try {
      const input = parseTargetInput(req.body);
      const target = await validateCopyTarget(input);
      db.setSetting(SAFE_COPY_TARGET_KEY, JSON.stringify(target));
      res.json({ target, configured: true });
    } catch (error) {
      res.status(400).json({ error: friendlyError(error) });
    }
  });

  api.post('/execution/push-missing/preview', async (_req: Request, res: Response) => {
    const target = loadTarget(db);
    if (!target) return res.status(400).json({ error: 'Set up the safe copy target before running this preview.' });

    const runInsert = db.run(
      `INSERT INTO runs (workflow_name, type, mode, status, started_at)
       VALUES (?, 'preview_push_missing_copy', 'dry', 'running', datetime('now'))`,
      ['Safe copy: add missing residents']
    );
    const runId = Number(runInsert.lastInsertRowid);

    try {
      const [masterGrid, captainGrid] = await Promise.all([
        readGrid(target.masterSpreadsheetId, target.masterTab),
        readGrid(target.captainSpreadsheetId, target.captainTab),
      ]);
      const sensitive = db
        .all<{ canonical_name: string }>('SELECT canonical_name FROM dictionary_fields WHERE is_sensitive = 1')
        .map((row) => row.canonical_name);
      const plan = planPushMissingResidents(captainGrid, masterGrid, { sensitiveColumns: sensitive });
      if (plan.errors.length > 0) throw new Error(plan.errors.map((error) => error.message).join('; '));
      const guarded = planGuardedAppends(captainGrid, plan.newRows);
      if (guarded.errors.length > 0) throw new Error(guarded.errors.join('; '));

      const expectedIds = guarded.appends.map((append) => append.residentId);
      const approvedIds = new Set(expectedIds);
      const residents = plan.appended
        .filter((resident) => approvedIds.has(resident.residentId))
        .map((resident) => ({
          residentId: resident.residentId,
          residentName: resident.residentName,
          masterRow: resident.masterRow,
          flagged: plan.flagged.some((flag) => flag.residentId === resident.residentId),
        }));
      const impact = summarizePushMissing([{ ...plan, newRows: guarded.appends.map((append) => append.row) }]);
      const executionPlan: PushMissingPreviewPlan = {
        kind: 'push_missing_copy_preview',
        target,
        expectedResidentIds: expectedIds,
        appended: expectedIds.length,
        flagged: residents.filter((resident) => resident.flagged).length,
        detectedZone: plan.detectedZone,
        generatedAt: new Date().toISOString(),
      };
      const summary = { ...executionPlan, impact };
      db.run("UPDATE runs SET status='succeeded', finished_at=datetime('now'), summary_json=? WHERE id=?", [
        JSON.stringify(summary),
        runId,
      ]);
      res.json({
        runId,
        target,
        impact,
        detectedZone: plan.detectedZone,
        residents,
        canApply: expectedIds.length > 0,
      });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: friendlyError(error) });
    }
  });

  api.post('/execution/push-missing/apply', (req: Request, res: Response) => {
    const previewRunId = Number(req.body?.previewRunId);
    if (!Number.isInteger(previewRunId) || previewRunId <= 0) {
      return res.status(400).json({ error: 'A valid preview run is required.' });
    }
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'Please confirm the preview before running it live.' });
    }

    const preview = db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [previewRunId]);
    if (!preview || preview.type !== 'preview_push_missing_copy' || preview.mode !== 'dry' || preview.status !== 'succeeded') {
      return res.status(400).json({ error: 'That preview is not available for a live run.' });
    }
    const plan = parsePreviewPlan(preview.summary_json);
    if (!plan) return res.status(400).json({ error: 'That preview does not contain a valid execution plan.' });
    if (plan.appliedRunId) {
      return res.status(409).json({ error: `That preview was already approved as live run #${plan.appliedRunId}.` });
    }
    if (plan.expectedResidentIds.length === 0) {
      return res.status(400).json({ error: 'The preview found no rows to add.' });
    }

    const queued = jobs.enqueue({
      workflowName: 'Safe copy: add missing residents',
      type: PUSH_MISSING_COPY_TASK,
      mode: 'live',
      params: {
        previewRunId,
        target: plan.target,
        expectedResidentIds: plan.expectedResidentIds,
      },
    });
    plan.appliedRunId = queued.runId;
    const stored = { ...safeJson(preview.summary_json), ...plan };
    db.run('UPDATE runs SET summary_json = ? WHERE id = ?', [JSON.stringify(stored), previewRunId]);
    res.status(202).json({ ...queued, status: 'queued' });
  });

  api.post('/execution/enrich-zones/preview', async (_req: Request, res: Response) => {
    const target = loadTarget(db);
    if (!target) return res.status(400).json({ error: 'Set up the safe copy target before running this preview.' });
    if (target.masterSpreadsheetId === PRODUCTION_MASTER_SPREADSHEET_ID) {
      return res.status(400).json({ error: 'This playbook only runs on the master copy, not the production master.' });
    }
    if (!isMapboxConfigured()) {
      return res.status(400).json({
        error: 'Mapbox is not configured yet. Add MAPBOX_TOKEN to your .env and restart.',
      });
    }

    const enrichmentTab = DEFAULT_ENRICHMENT_TAB;
    const runInsert = db.run(
      `INSERT INTO runs (workflow_name, type, mode, status, started_at)
       VALUES (?, 'preview_enrich_zones_copy', 'dry', 'running', datetime('now'))`,
      ['Safe copy: enrich zones on master']
    );
    const runId = Number(runInsert.lastInsertRowid);

    try {
      const masterGrid = await readGrid(target.masterSpreadsheetId, enrichmentTab);
      const cfg = resolveZoneConfig(db, trimHeaders(masterGrid[0]));
      const source = loadZoneSource(db);
      const features = await fetchZoneFeatures(source);
      const enrichment = planZoneEnrichment(masterGrid, features, cfg);
      if (enrichment.report.configError) throw new Error(enrichment.report.configError);

      const sample = enrichment.report.rows
        .filter((row) => row.outcome === 'fill' && row.outputValues.length > 0)
        .slice(0, 25)
        .map((row) => ({
          residentId: row.residentId,
          residentName: row.residentName,
          masterRow: row.masterRow,
          computedZone: row.computedZone,
          values: Object.fromEntries(row.outputValues.map((value) => [value.field, value.computed])),
        }));

      const impact = {
        headline:
          enrichment.cellsToFill > 0
            ? `This would add ${enrichment.columnsToAdd.length} column(s) and fill ${enrichment.cellsToFill.toLocaleString()} blank zone/captain cell(s) for ${enrichment.residentsTouched.toLocaleString()} residents.`
            : 'No blank zone/captain cells need filling on this master copy tab.',
        detail:
          'Only blank cells are filled. Existing values are never overwritten. This writes only to the master copy — not production.',
        columnsToAdd: enrichment.columnsToAdd.length,
        cellsToFill: enrichment.cellsToFill,
        residentsTouched: enrichment.residentsTouched,
        wouldChangeZone: enrichment.report.summary.wouldChangeZone,
        unassigned: enrichment.report.summary.unassigned,
      };

      const executionPlan: EnrichZonesPreviewPlan = {
        kind: 'enrich_zones_copy_preview',
        target,
        enrichmentTab,
        columnsToAdd: enrichment.columnsToAdd,
        fingerprint: enrichment.fingerprint,
        cellsToFill: enrichment.cellsToFill,
        residentsTouched: enrichment.residentsTouched,
        generatedAt: new Date().toISOString(),
      };
      db.run("UPDATE runs SET status='succeeded', finished_at=datetime('now'), summary_json=? WHERE id=?", [
        JSON.stringify({ ...executionPlan, impact }),
        runId,
      ]);
      res.json({
        runId,
        target,
        enrichmentTab,
        impact,
        columnsToAdd: enrichment.columnsToAdd,
        sample,
        canApply: enrichment.cellsToFill > 0 || enrichment.columnsToAdd.length > 0,
      });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: friendlyError(error) });
    }
  });

  api.post('/execution/pull-to-master/preview', async (_req: Request, res: Response) => {
    const target = loadTarget(db);
    if (!target) return res.status(400).json({ error: 'Set up the safe copy target before running this preview.' });
    if (target.masterSpreadsheetId === PRODUCTION_MASTER_SPREADSHEET_ID) {
      return res.status(400).json({ error: 'This playbook only runs on the master copy, not the production master.' });
    }

    const runInsert = db.run(
      `INSERT INTO runs (workflow_name, type, mode, status, started_at)
       VALUES (?, 'preview_pull_to_master_copy', 'dry', 'running', datetime('now'))`,
      ['Safe copy: pull captain edits into master']
    );
    const runId = Number(runInsert.lastInsertRowid);

    try {
      const [masterGrid, captainGrid] = await Promise.all([
        readGrid(target.masterSpreadsheetId, target.masterTab),
        readGrid(target.captainSpreadsheetId, target.captainTab),
      ]);
      const policies = pullPoliciesForHeaders(trimHeaders(masterGrid[0]));
      const plan = planPullToMaster(masterGrid, captainGrid, { policies });
      if (plan.errors.length > 0) throw new Error(plan.errors.join('; '));

      const changes = [...plan.fills, ...plan.overwrites];
      const expectedCells = pullCellKeys(changes);
      const fingerprint = fingerprintPullCells(expectedCells);
      const impact = {
        headline:
          changes.length > 0
            ? `This would bring ${changes.length.toLocaleString()} captain value(s) into ${target.masterName} for ${
                new Set(changes.map((change) => change.residentId)).size
              } resident(s).`
            : 'No captain values are ready to write into the master copy.',
        detail: `${plan.conflicts.length.toLocaleString()} disagreement(s) will be logged to the Conflict inbox instead of overwriting the master. Writes go to the master copy only — never production.`,
        cellsToWrite: changes.length,
        fills: plan.fills.length,
        overwrites: plan.overwrites.length,
        conflicts: plan.conflicts.length,
        unmatchedResidents: plan.unmatchedResidents.length,
        columnsCompared: plan.columnsCompared.length,
      };

      const executionPlan: PullToMasterPreviewPlan = {
        kind: 'pull_to_master_copy_preview',
        target,
        expectedCells,
        fingerprint,
        conflicts: plan.conflicts.length,
        generatedAt: new Date().toISOString(),
      };
      db.run("UPDATE runs SET status='succeeded', finished_at=datetime('now'), summary_json=? WHERE id=?", [
        JSON.stringify({ ...executionPlan, impact }),
        runId,
      ]);
      res.json({
        runId,
        target,
        impact,
        cells: changes.map(describePullChange),
        conflicts: plan.conflicts.slice(0, 100).map(describePullChange),
        unmatchedResidents: plan.unmatchedResidents.slice(0, 50),
        columnsCompared: plan.columnsCompared,
        canApply: changes.length > 0 || plan.conflicts.length > 0,
      });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: friendlyError(error) });
    }
  });

  api.post('/execution/pull-to-master/apply', (req: Request, res: Response) => {
    const previewRunId = Number(req.body?.previewRunId);
    if (!Number.isInteger(previewRunId) || previewRunId <= 0) {
      return res.status(400).json({ error: 'A valid preview run is required.' });
    }
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'Please confirm the preview before running it live.' });
    }

    const preview = db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [previewRunId]);
    if (
      !preview ||
      preview.type !== 'preview_pull_to_master_copy' ||
      preview.mode !== 'dry' ||
      preview.status !== 'succeeded'
    ) {
      return res.status(400).json({ error: 'That preview is not available for a live run.' });
    }
    const plan = parsePullPreviewPlan(preview.summary_json);
    if (!plan) return res.status(400).json({ error: 'That preview does not contain a valid pull plan.' });
    if (plan.appliedRunId) {
      return res.status(409).json({ error: `That preview was already approved as live run #${plan.appliedRunId}.` });
    }
    if (plan.target.masterSpreadsheetId === PRODUCTION_MASTER_SPREADSHEET_ID) {
      return res.status(400).json({ error: 'Refusing to write to the production master.' });
    }

    const approvedKeys = Array.isArray(req.body?.cells)
      ? (req.body.cells as unknown[]).map((cell) => {
          const raw = (cell || {}) as { residentId?: unknown; column?: unknown };
          return `${String(raw.residentId || '').trim()}\u0000${String(raw.column || '').trim()}`;
        })
      : plan.expectedCells.map((cell) => `${cell.residentId}\u0000${cell.column}`);
    const wanted = new Set(approvedKeys);
    const approvedCells = plan.expectedCells.filter((cell) => wanted.has(`${cell.residentId}\u0000${cell.column}`));
    if (approvedCells.length !== wanted.size) {
      return res.status(400).json({ error: 'One or more selected cells were not part of this preview.' });
    }
    if (approvedCells.length === 0 && plan.conflicts === 0) {
      return res.status(400).json({ error: 'The preview found nothing to write or log.' });
    }

    const fingerprint = fingerprintPullCells(approvedCells);
    const queued = jobs.enqueue({
      workflowName: 'Safe copy: pull captain edits into master',
      type: PULL_TO_MASTER_COPY_TASK,
      mode: 'live',
      params: {
        previewRunId,
        target: plan.target,
        approvedCells,
        fingerprint,
      },
    });
    plan.appliedRunId = queued.runId;
    plan.expectedCells = approvedCells;
    plan.fingerprint = fingerprint;
    const stored = { ...safeJson(preview.summary_json), ...plan };
    db.run('UPDATE runs SET summary_json = ? WHERE id = ?', [JSON.stringify(stored), previewRunId]);
    res.status(202).json({ ...queued, status: 'queued' });
  });

  api.post('/execution/new-residents/preview', async (_req: Request, res: Response) => {
    const target = loadTarget(db);
    if (!target) return res.status(400).json({ error: 'Set up the safe copy target before running this preview.' });
    if (target.masterSpreadsheetId === PRODUCTION_MASTER_SPREADSHEET_ID) {
      return res.status(400).json({ error: 'This playbook only runs on the master copy, not the production master.' });
    }

    const runInsert = db.run(
      `INSERT INTO runs (workflow_name, type, mode, status, started_at)
       VALUES (?, 'preview_pull_new_residents_copy', 'dry', 'running', datetime('now'))`,
      ['Safe copy: add captain-created residents to master']
    );
    const runId = Number(runInsert.lastInsertRowid);

    try {
      const [masterGrid, captainGrid] = await Promise.all([
        readGrid(target.masterSpreadsheetId, target.masterTab),
        readGrid(target.captainSpreadsheetId, target.captainTab),
      ]);
      const plan = planPullNewResidents(masterGrid, captainGrid);
      if (plan.errors.length > 0) throw new Error(plan.errors.join('; '));

      const flagged = plan.candidates.filter((candidate) => candidate.risk !== 'none');
      const clean = plan.candidates.length - flagged.length;
      const impact = {
        headline:
          plan.candidates.length > 0
            ? `${plan.candidates.length} resident(s) on ${target.captainName} are not on the master copy. ${clean} look new; ${flagged.length} may already exist under a different resident_id.`
            : `Every resident on ${target.captainName} already has a row on the master copy.`,
        detail:
          'Sharing an address (APN) is normal and is never treated as a duplicate. A row is flagged when the same person appears again: the same name at the same parcel, or a re-used email. Flagged rows start unticked.',
        candidates: plan.candidates.length,
        clean,
        likelyDuplicates: plan.candidates.filter((candidate) => candidate.risk === 'likely').length,
        possibleDuplicates: plan.candidates.filter((candidate) => candidate.risk === 'possible').length,
        droppedColumns: plan.columnsOnlyOnCaptain.length,
      };

      const executionPlan: NewResidentsPreviewPlan = {
        kind: 'pull_new_residents_copy_preview',
        target,
        expectedRows: newResidentCellKeys(plan.candidates),
        fingerprint: plan.fingerprint,
        flaggedCount: flagged.length,
        generatedAt: new Date().toISOString(),
      };
      db.run("UPDATE runs SET status='succeeded', finished_at=datetime('now'), summary_json=? WHERE id=?", [
        JSON.stringify({ ...executionPlan, impact }),
        runId,
      ]);
      res.json({
        runId,
        target,
        impact,
        residents: plan.candidates.map((candidate) => ({
          residentId: candidate.residentId,
          residentName: candidate.residentName,
          captainRow: candidate.captainRow,
          property: candidate.property,
          filledColumns: candidate.filledColumns,
          risk: candidate.risk,
          riskReason: candidate.riskReason,
          matchedResidentId: candidate.matchedResidentId,
          missingRequired: candidate.missingRequired,
        })),
        skipped: plan.skipped,
        columnsOnlyOnCaptain: plan.columnsOnlyOnCaptain,
        canApply: plan.candidates.length > 0,
      });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: friendlyError(error) });
    }
  });

  api.post('/execution/new-residents/apply', (req: Request, res: Response) => {
    const previewRunId = Number(req.body?.previewRunId);
    if (!Number.isInteger(previewRunId) || previewRunId <= 0) {
      return res.status(400).json({ error: 'A valid preview run is required.' });
    }
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'Please confirm the preview before running it live.' });
    }

    const preview = db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [previewRunId]);
    if (
      !preview ||
      preview.type !== 'preview_pull_new_residents_copy' ||
      preview.mode !== 'dry' ||
      preview.status !== 'succeeded'
    ) {
      return res.status(400).json({ error: 'That preview is not available for a live run.' });
    }
    const plan = parseNewResidentsPreviewPlan(preview.summary_json);
    if (!plan) return res.status(400).json({ error: 'That preview does not contain a valid plan.' });
    if (plan.appliedRunId) {
      return res.status(409).json({ error: `That preview was already approved as live run #${plan.appliedRunId}.` });
    }
    if (plan.target.masterSpreadsheetId === PRODUCTION_MASTER_SPREADSHEET_ID) {
      return res.status(400).json({ error: 'Refusing to write to the production master.' });
    }

    const approvedIds = Array.isArray(req.body?.residentIds)
      ? (req.body.residentIds as unknown[]).map((id) => String(id).trim()).filter(Boolean)
      : [];
    if (approvedIds.length === 0) {
      return res.status(400).json({ error: 'Tick at least one resident to add.' });
    }
    const wanted = new Set(approvedIds);
    const approvedRows = plan.expectedRows.filter((row) => wanted.has(row.residentId));
    if (approvedRows.length !== wanted.size) {
      return res.status(400).json({ error: 'One or more selected residents were not part of this preview.' });
    }

    const fingerprint = fingerprintPullCells(approvedRows);
    const queued = jobs.enqueue({
      workflowName: 'Safe copy: add captain-created residents to master',
      type: PULL_NEW_RESIDENTS_COPY_TASK,
      mode: 'live',
      params: {
        previewRunId,
        target: plan.target,
        expectedResidentIds: approvedRows.map((row) => row.residentId),
        fingerprint,
      },
    });
    plan.appliedRunId = queued.runId;
    plan.expectedRows = approvedRows;
    plan.fingerprint = fingerprint;
    const stored = { ...safeJson(preview.summary_json), ...plan };
    db.run('UPDATE runs SET summary_json = ? WHERE id = ?', [JSON.stringify(stored), previewRunId]);
    res.status(202).json({ ...queued, status: 'queued' });
  });

  api.post('/conflicts/apply', (req: Request, res: Response) => {
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'Please confirm before writing captain values to the master copy.' });
    }
    const conflictIds = Array.isArray(req.body?.conflictIds)
      ? (req.body.conflictIds as unknown[]).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    if (conflictIds.length === 0) return res.status(400).json({ error: 'Select at least one conflict to apply.' });

    const placeholders = conflictIds.map(() => '?').join(',');
    const open = db.all<{ id: number }>(
      `SELECT id FROM conflicts WHERE id IN (${placeholders}) AND status = 'open'`,
      conflictIds
    );
    if (open.length === 0) return res.status(409).json({ error: 'Those conflicts are no longer open.' });

    const queued = jobs.enqueue({
      workflowName: 'Conflict inbox: apply captain values',
      type: APPLY_CONFLICT_COPY_TASK,
      mode: 'live',
      params: { conflictIds: open.map((conflict) => conflict.id) },
    });
    res.status(202).json({ ...queued, status: 'queued' });
  });

  api.get('/execution/move-target', (_req: Request, res: Response) => {
    const moveTarget = loadMoveTarget(db);
    const appendTarget = loadTarget(db);
    res.json({
      target: moveTarget,
      configured: Boolean(moveTarget),
      suggested: appendTarget
        ? {
            masterSpreadsheetId: appendTarget.masterSpreadsheetId,
            masterTab: appendTarget.masterTab,
            fromCaptainSpreadsheetId: appendTarget.captainSpreadsheetId,
            fromCaptainTab: appendTarget.captainTab,
            folderId: appendTarget.folderId,
          }
        : null,
    });
  });

  api.put('/execution/move-target', async (req: Request, res: Response) => {
    try {
      const input = parseMoveTargetInput(req.body);
      const target = await validateMoveTarget(input);
      db.setSetting(SAFE_COPY_MOVE_TARGET_KEY, JSON.stringify(target));
      res.json({ target, configured: true });
    } catch (error) {
      res.status(400).json({ error: friendlyError(error) });
    }
  });

  api.post('/execution/move-residents/preview', async (req: Request, res: Response) => {
    const target = loadMoveTarget(db);
    if (!target) {
      return res.status(400).json({ error: 'Set up the move copies (source + destination) before running this preview.' });
    }
    if (!isMapboxConfigured()) {
      return res.status(400).json({
        error: 'Mapbox is not configured yet. Add MAPBOX_TOKEN to your .env and restart.',
      });
    }

    const runInsert = db.run(
      `INSERT INTO runs (workflow_name, type, mode, status, started_at)
       VALUES (?, 'preview_move_residents_copy', 'dry', 'running', datetime('now'))`,
      ['Safe copy: move residents between captain sheets']
    );
    const runId = Number(runInsert.lastInsertRowid);

    try {
      const fromGrid = await readGrid(target.fromCaptainSpreadsheetId, target.fromCaptainTab);
      const toGrid = await readGrid(target.toCaptainSpreadsheetId, target.toCaptainTab);
      const masterGrid =
        target.masterSpreadsheetId && target.masterTab
          ? await readGrid(target.masterSpreadsheetId, target.masterTab)
          : [trimHeaders(fromGrid[0])];
      const fromZone = target.fromZoneOverride || detectSheetZone(trimHeaders(fromGrid[0]), fromGrid.slice(1));
      const toZone = target.toZoneOverride || detectSheetZone(trimHeaders(toGrid[0]), toGrid.slice(1));
      const cfg = resolveZoneConfig(db, trimHeaders(masterGrid[0]?.length ? masterGrid[0] : fromGrid[0]));
      const features = await fetchZoneFeatures(loadZoneSource(db));
      const proposal = planCaptainSheetMoves(fromGrid, masterGrid, features, cfg, fromZone, toZone);
      if (proposal.errors.length > 0) throw new Error(proposal.errors.join('; '));

      const selectedIds = Array.isArray(req.body?.residentIds)
        ? (req.body.residentIds as unknown[]).map((id) => String(id).trim()).filter(Boolean)
        : proposal.candidates.map((candidate) => candidate.residentId);
      const selectedSet = new Set(selectedIds);
      const selected = proposal.candidates.filter((candidate) => selectedSet.has(candidate.residentId));
      const guarded = planGuardedMoves(
        fromGrid,
        toGrid,
        selected.map((candidate) => candidate.residentId),
        proposal.destinationFields
      );
      if (guarded.errors.length > 0) throw new Error(guarded.errors.join('; '));

      const moveableIds = new Set(guarded.moves.map((move) => move.residentId));
      const residents = selected
        .filter((candidate) => moveableIds.has(candidate.residentId))
        .map((candidate) => ({
          residentId: candidate.residentId,
          residentName: candidate.residentName,
          fromZone: candidate.fromZone,
          toZone: candidate.toZone,
          currentZoneOnSheet: candidate.currentZoneOnSheet,
          computedZone: candidate.computedZone,
          destinationFields: candidate.destinationFields,
          fromSheet: target.fromCaptainName,
          toSheet: target.toCaptainName,
        }));
      const fingerprint = fingerprintCaptainMoves(residents, proposal.fromZone, proposal.toZone);
      const impact = {
        headline:
          residents.length > 0
            ? `This would move ${residents.length} resident(s) from ${target.fromCaptainName} (${proposal.fromZone}) to ${target.toCaptainName} (${proposal.toZone}), updating ZoneName and captain contact fields.`
            : `No residents on ${target.fromCaptainName} currently compute to zone ${proposal.toZone}.`,
        detail: `Each move copies the row to the destination sheet with ${proposal.toZone}'s zone/captain fields from Mapbox, then removes it from the source by resident_id. Copies only.`,
        moved: residents.length,
        skipped: proposal.skipped.length + guarded.skipped.length,
        fromZone: proposal.fromZone,
        toZone: proposal.toZone,
        destinationFields: proposal.destinationFields,
      };

      const executionPlan: MoveResidentsPreviewPlan = {
        kind: 'move_residents_copy_preview',
        target,
        fromZone: proposal.fromZone,
        toZone: proposal.toZone,
        destinationFields: proposal.destinationFields,
        expectedResidentIds: residents.map((resident) => resident.residentId),
        fingerprint,
        generatedAt: new Date().toISOString(),
      };
      db.run("UPDATE runs SET status='succeeded', finished_at=datetime('now'), summary_json=? WHERE id=?", [
        JSON.stringify({ ...executionPlan, impact, residents }),
        runId,
      ]);
      res.json({
        runId,
        target,
        impact,
        fromZone: proposal.fromZone,
        toZone: proposal.toZone,
        destinationFields: proposal.destinationFields,
        residents,
        skipped: [...proposal.skipped, ...guarded.skipped],
        canApply: residents.length > 0,
      });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: friendlyError(error) });
    }
  });

  api.post('/execution/move-residents/apply', (req: Request, res: Response) => {
    const previewRunId = Number(req.body?.previewRunId);
    if (!Number.isInteger(previewRunId) || previewRunId <= 0) {
      return res.status(400).json({ error: 'A valid preview run is required.' });
    }
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'Please confirm the preview before running it live.' });
    }

    const preview = db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [previewRunId]);
    if (
      !preview ||
      preview.type !== 'preview_move_residents_copy' ||
      preview.mode !== 'dry' ||
      preview.status !== 'succeeded'
    ) {
      return res.status(400).json({ error: 'That preview is not available for a live run.' });
    }
    const plan = parseMovePreviewPlan(preview.summary_json);
    if (!plan) return res.status(400).json({ error: 'That preview does not contain a valid move plan.' });
    if (plan.appliedRunId) {
      return res.status(409).json({ error: `That preview was already approved as live run #${plan.appliedRunId}.` });
    }

    const approvedIds = Array.isArray(req.body?.residentIds)
      ? (req.body.residentIds as unknown[]).map((id) => String(id).trim()).filter(Boolean)
      : plan.expectedResidentIds;
    if (approvedIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one resident to move.' });
    }
    const allowed = new Set(plan.expectedResidentIds);
    if (approvedIds.some((id) => !allowed.has(id))) {
      return res.status(400).json({ error: 'One or more selected residents were not part of this preview.' });
    }

    const fingerprint = fingerprintCaptainMoves(
      approvedIds.map((residentId) => ({ residentId })),
      plan.fromZone,
      plan.toZone
    );

    const destinationFields = plan.destinationFields?.ZoneName
      ? plan.destinationFields
      : { ZoneName: plan.toZone };

    const queued = jobs.enqueue({
      workflowName: 'Safe copy: move residents between captain sheets',
      type: MOVE_RESIDENTS_COPY_TASK,
      mode: 'live',
      params: {
        previewRunId,
        target: plan.target,
        expectedResidentIds: approvedIds,
        fingerprint,
        fromZone: plan.fromZone,
        toZone: plan.toZone,
        destinationFields,
      },
    });
    plan.appliedRunId = queued.runId;
    plan.expectedResidentIds = approvedIds;
    plan.fingerprint = fingerprint;
    plan.destinationFields = destinationFields;
    const stored = { ...safeJson(preview.summary_json), ...plan };
    db.run('UPDATE runs SET summary_json = ? WHERE id = ?', [JSON.stringify(stored), previewRunId]);
    res.status(202).json({ ...queued, status: 'queued' });
  });

  api.post('/execution/enrich-zones/apply', (req: Request, res: Response) => {
    const previewRunId = Number(req.body?.previewRunId);
    if (!Number.isInteger(previewRunId) || previewRunId <= 0) {
      return res.status(400).json({ error: 'A valid preview run is required.' });
    }
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'Please confirm the preview before running it live.' });
    }

    const preview = db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [previewRunId]);
    if (!preview || preview.type !== 'preview_enrich_zones_copy' || preview.mode !== 'dry' || preview.status !== 'succeeded') {
      return res.status(400).json({ error: 'That preview is not available for a live run.' });
    }
    const plan = parseEnrichPreviewPlan(preview.summary_json);
    if (!plan) return res.status(400).json({ error: 'That preview does not contain a valid enrichment plan.' });
    if (plan.appliedRunId) {
      return res.status(409).json({ error: `That preview was already approved as live run #${plan.appliedRunId}.` });
    }
    if (plan.target.masterSpreadsheetId === PRODUCTION_MASTER_SPREADSHEET_ID) {
      return res.status(400).json({ error: 'Refusing to enrich the production master.' });
    }
    if (plan.cellsToFill === 0 && plan.columnsToAdd.length === 0) {
      return res.status(400).json({ error: 'The preview found nothing to write.' });
    }

    const queued = jobs.enqueue({
      workflowName: 'Safe copy: enrich zones on master',
      type: ENRICH_ZONES_COPY_TASK,
      mode: 'live',
      params: {
        previewRunId,
        target: plan.target,
        enrichmentTab: plan.enrichmentTab,
        fingerprint: plan.fingerprint,
        columnsToAdd: plan.columnsToAdd,
      },
    });
    plan.appliedRunId = queued.runId;
    const stored = { ...safeJson(preview.summary_json), ...plan };
    db.run('UPDATE runs SET summary_json = ? WHERE id = ?', [JSON.stringify(stored), previewRunId]);
    res.status(202).json({ ...queued, status: 'queued' });
  });

  api.post('/runs/:id/revert', (req: Request, res: Response) => {
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'Please confirm before reverting this run.' });
    }
    const originalRunId = Number(req.params.id);
    const original = db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [originalRunId]);
    if (!original || original.mode !== 'live') {
      return res.status(400).json({ error: 'Only a live safe-copy run can be reverted here.' });
    }
    let revertType = '';
    let remaining = 0;
    if (original.type === PUSH_MISSING_COPY_TASK || original.type === PULL_NEW_RESIDENTS_COPY_TASK) {
      if (original.status !== 'succeeded') {
        return res.status(409).json({ error: 'Wait for the live run to finish before reverting it.' });
      }
      revertType = REVERT_APPEND_COPY_TASK;
      remaining =
        db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM run_snapshots
           WHERE run_id = ? AND operation = 'row_append' AND reverted_by_run_id IS NULL`,
          [originalRunId]
        )?.n || 0;
    } else if (original.type === ENRICH_ZONES_COPY_TASK) {
      // Failed enrichments may still have written headers/partial cells; allow undo.
      if (original.status !== 'succeeded' && original.status !== 'failed') {
        return res.status(409).json({ error: 'Wait for the live run to finish before reverting it.' });
      }
      revertType = REVERT_CELL_COPY_TASK;
      remaining =
        db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM run_snapshots
           WHERE run_id = ? AND operation = 'cell_update' AND reverted_by_run_id IS NULL`,
          [originalRunId]
        )?.n || 0;
    } else if (original.type === PULL_TO_MASTER_COPY_TASK || original.type === APPLY_CONFLICT_COPY_TASK) {
      if (original.status !== 'succeeded' && original.status !== 'failed') {
        return res.status(409).json({ error: 'Wait for the live run to finish before reverting it.' });
      }
      revertType = REVERT_CELL_COPY_TASK;
      remaining =
        db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM run_snapshots
           WHERE run_id = ? AND operation = 'cell_update' AND reverted_by_run_id IS NULL`,
          [originalRunId]
        )?.n || 0;
    } else if (original.type === MOVE_RESIDENTS_COPY_TASK) {
      if (original.status !== 'succeeded' && original.status !== 'failed') {
        return res.status(409).json({ error: 'Wait for the live run to finish before reverting it.' });
      }
      revertType = REVERT_MOVE_COPY_TASK;
      remaining =
        db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM run_snapshots
           WHERE run_id = ? AND operation IN ('row_append', 'row_delete') AND reverted_by_run_id IS NULL`,
          [originalRunId]
        )?.n || 0;
    } else {
      return res.status(400).json({
        error:
          'Only safe-copy append, zone-enrichment, resident-move, pull, or conflict-resolution runs can be reverted here.',
      });
    }

    if (!remaining) return res.status(409).json({ error: 'This run has already been reverted.' });

    const originalSummary = safeJson(original.summary_json);
    const priorRevertId = Number(originalSummary.revertRunId);
    if (priorRevertId > 0) {
      const prior = db.get<RunRow>('SELECT * FROM runs WHERE id = ?', [priorRevertId]);
      if (prior && ['queued', 'running'].includes(prior.status)) {
        return res.status(409).json({ error: `Revert run #${priorRevertId} already exists.` });
      }
    }

    const queued = jobs.enqueue({
      workflowName: `Revert live run #${originalRunId}`,
      type: revertType,
      mode: 'live',
      params: { originalRunId },
    });
    db.run('UPDATE runs SET summary_json = ? WHERE id = ?', [
      JSON.stringify({ ...originalSummary, revertRunId: queued.runId }),
      originalRunId,
    ]);
    res.status(202).json({ ...queued, status: 'queued' });
  });
}

function loadTarget(db: Deps['db']): SafeCopyTarget | null {
  const raw = db.getSetting(SAFE_COPY_TARGET_KEY, '');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SafeCopyTarget;
  } catch {
    return null;
  }
}

function parseTargetInput(body: unknown): CopyTargetInput {
  const raw = (body || {}) as Partial<CopyTargetInput>;
  const value: CopyTargetInput = {
    masterSpreadsheetId: String(raw.masterSpreadsheetId || '').trim(),
    masterTab: String(raw.masterTab || '').trim(),
    captainSpreadsheetId: String(raw.captainSpreadsheetId || '').trim(),
    captainTab: String(raw.captainTab || '').trim(),
    folderId: String(raw.folderId || '').trim(),
  };
  if (
    !value.masterSpreadsheetId ||
    !value.masterTab ||
    !value.captainSpreadsheetId ||
    !value.captainTab ||
    !value.folderId
  ) {
    throw new Error('Master copy, source tab, captain copy, captain tab, and testing folder are all required.');
  }
  if (value.masterSpreadsheetId === value.captainSpreadsheetId) {
    throw new Error('The master copy and captain copy must be different spreadsheets.');
  }
  return value;
}

async function validateCopyTarget(input: CopyTargetInput): Promise<SafeCopyTarget> {
  if (!google.isConfigured()) throw new Error('Google is not configured.');
  const [master, captain, files, masterHeaders, captainHeaders] = await Promise.all([
    google.getSpreadsheetMeta(input.masterSpreadsheetId),
    google.getSpreadsheetMeta(input.captainSpreadsheetId),
    google.listSpreadsheetsInFolder(input.folderId),
    google.readHeaders(input.masterSpreadsheetId, input.masterTab),
    google.readHeaders(input.captainSpreadsheetId, input.captainTab),
  ]);
  if (!master.tabs.includes(input.masterTab)) throw new Error(`The master copy has no tab named "${input.masterTab}".`);
  if (!captain.tabs.includes(input.captainTab)) throw new Error(`The captain copy has no tab named "${input.captainTab}".`);
  if (!files.some((file) => file.id === input.captainSpreadsheetId)) {
    throw new Error('The captain copy is not inside the selected testing folder.');
  }
  for (const required of ['resident_id', 'ZoneName']) {
    if (!masterHeaders.includes(required)) throw new Error(`The source tab is missing the required "${required}" column.`);
    if (!captainHeaders.includes(required)) throw new Error(`The captain copy is missing the required "${required}" column.`);
  }
  return {
    ...input,
    masterName: master.title,
    captainName: captain.title,
  };
}

async function readGrid(spreadsheetId: string, tabName: string): Promise<Grid> {
  return (await google.readValues(spreadsheetId, google.a1Range(tabName, 'A:ZZ'))) as Grid;
}

function parsePreviewPlan(json: string): PushMissingPreviewPlan | null {
  const value = safeJson(json);
  if (value.kind !== 'push_missing_copy_preview' || !Array.isArray(value.expectedResidentIds) || !value.target) {
    return null;
  }
  return value as unknown as PushMissingPreviewPlan;
}

function parseEnrichPreviewPlan(json: string): EnrichZonesPreviewPlan | null {
  const value = safeJson(json);
  if (
    value.kind !== 'enrich_zones_copy_preview' ||
    !value.target ||
    typeof value.fingerprint !== 'string' ||
    !Array.isArray(value.columnsToAdd)
  ) {
    return null;
  }
  return value as unknown as EnrichZonesPreviewPlan;
}

function parsePullPreviewPlan(json: string): PullToMasterPreviewPlan | null {
  const value = safeJson(json);
  if (
    value.kind !== 'pull_to_master_copy_preview' ||
    !value.target ||
    typeof value.fingerprint !== 'string' ||
    !Array.isArray(value.expectedCells)
  ) {
    return null;
  }
  return value as unknown as PullToMasterPreviewPlan;
}

function parseNewResidentsPreviewPlan(json: string): NewResidentsPreviewPlan | null {
  const value = safeJson(json);
  if (
    value.kind !== 'pull_new_residents_copy_preview' ||
    !value.target ||
    typeof value.fingerprint !== 'string' ||
    !Array.isArray(value.expectedRows)
  ) {
    return null;
  }
  return value as unknown as NewResidentsPreviewPlan;
}

function describePullChange(change: PullCellChange) {
  return {
    residentId: change.residentId,
    residentName: change.residentName,
    column: change.column,
    masterRow: change.masterRow,
    masterValue: String(change.masterValue ?? ''),
    captainValue: String(change.captainValue ?? ''),
    policy: change.policy,
  };
}

function loadMoveTarget(db: Deps['db']): MoveCopyTarget | null {
  const raw = db.getSetting(SAFE_COPY_MOVE_TARGET_KEY, '');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MoveCopyTarget;
  } catch {
    return null;
  }
}

function parseMoveTargetInput(body: unknown): MoveTargetInput {
  const raw = (body || {}) as Partial<MoveTargetInput>;
  const value: MoveTargetInput = {
    masterSpreadsheetId: String(raw.masterSpreadsheetId || '').trim(),
    masterTab: String(raw.masterTab || '').trim(),
    fromCaptainSpreadsheetId: String(raw.fromCaptainSpreadsheetId || '').trim(),
    fromCaptainTab: String(raw.fromCaptainTab || '').trim(),
    toCaptainSpreadsheetId: String(raw.toCaptainSpreadsheetId || '').trim(),
    toCaptainTab: String(raw.toCaptainTab || '').trim(),
    folderId: String(raw.folderId || '').trim(),
    fromZoneOverride: String(raw.fromZoneOverride || '').trim(),
    toZoneOverride: String(raw.toZoneOverride || '').trim(),
  };
  if (
    !value.fromCaptainSpreadsheetId ||
    !value.fromCaptainTab ||
    !value.toCaptainSpreadsheetId ||
    !value.toCaptainTab ||
    !value.folderId
  ) {
    throw new Error('Both captain copies, their tabs, and the testing folder are required.');
  }
  if (value.masterSpreadsheetId && !value.masterTab) {
    throw new Error('If you include a master copy, also set the master tab.');
  }
  if (value.fromCaptainSpreadsheetId === value.toCaptainSpreadsheetId) {
    throw new Error('Source and destination captain copies must be different spreadsheets.');
  }
  if (value.masterSpreadsheetId === PRODUCTION_MASTER_SPREADSHEET_ID) {
    throw new Error('Use the master copy, not the production master.');
  }
  return value;
}

async function validateMoveTarget(input: MoveTargetInput): Promise<MoveCopyTarget> {
  if (!google.isConfigured()) throw new Error('Google is not configured.');
  const [fromCaptain, toCaptain, files, fromHeaders, toHeaders] = await Promise.all([
    google.getSpreadsheetMeta(input.fromCaptainSpreadsheetId),
    google.getSpreadsheetMeta(input.toCaptainSpreadsheetId),
    google.listSpreadsheetsInFolder(input.folderId),
    google.readHeaders(input.fromCaptainSpreadsheetId, input.fromCaptainTab),
    google.readHeaders(input.toCaptainSpreadsheetId, input.toCaptainTab),
  ]);
  if (!fromCaptain.tabs.includes(input.fromCaptainTab)) {
    throw new Error(`The source captain copy has no tab named "${input.fromCaptainTab}".`);
  }
  if (!toCaptain.tabs.includes(input.toCaptainTab)) {
    throw new Error(`The destination captain copy has no tab named "${input.toCaptainTab}".`);
  }
  if (!files.some((file) => file.id === input.fromCaptainSpreadsheetId)) {
    throw new Error('The source captain copy is not inside the selected testing folder.');
  }
  if (!files.some((file) => file.id === input.toCaptainSpreadsheetId)) {
    throw new Error('The destination captain copy is not inside the selected testing folder.');
  }
  for (const required of ['resident_id', 'ZoneName']) {
    if (!fromHeaders.includes(required)) throw new Error(`The source captain copy is missing "${required}".`);
    if (!toHeaders.includes(required)) throw new Error(`The destination captain copy is missing "${required}".`);
  }

  let masterName = '';
  if (input.masterSpreadsheetId && input.masterTab) {
    const [master, masterHeaders] = await Promise.all([
      google.getSpreadsheetMeta(input.masterSpreadsheetId),
      google.readHeaders(input.masterSpreadsheetId, input.masterTab),
    ]);
    if (!master.tabs.includes(input.masterTab)) {
      throw new Error(`The master copy has no tab named "${input.masterTab}".`);
    }
    for (const required of ['resident_id', 'Latitude', 'Longitude']) {
      if (!masterHeaders.includes(required)) {
        throw new Error(`The master source tab is missing the required "${required}" column.`);
      }
    }
    masterName = master.title;
  } else {
    for (const required of ['Latitude', 'Longitude']) {
      if (!fromHeaders.includes(required)) {
        throw new Error(
          `No master copy was provided, so the source captain copy needs "${required}" (used to decide the new zone).`
        );
      }
    }
  }

  return {
    masterSpreadsheetId: input.masterSpreadsheetId,
    masterTab: input.masterTab,
    fromCaptainSpreadsheetId: input.fromCaptainSpreadsheetId,
    fromCaptainTab: input.fromCaptainTab,
    toCaptainSpreadsheetId: input.toCaptainSpreadsheetId,
    toCaptainTab: input.toCaptainTab,
    folderId: input.folderId,
    masterName,
    fromCaptainName: fromCaptain.title,
    toCaptainName: toCaptain.title,
    fromZoneOverride: input.fromZoneOverride || '',
    toZoneOverride: input.toZoneOverride || '',
  };
}

function parseMovePreviewPlan(json: string): MoveResidentsPreviewPlan | null {
  const value = safeJson(json);
  if (
    value.kind !== 'move_residents_copy_preview' ||
    !value.target ||
    typeof value.fingerprint !== 'string' ||
    !Array.isArray(value.expectedResidentIds)
  ) {
    return null;
  }
  return value as unknown as MoveResidentsPreviewPlan;
}

function resolveZoneConfig(db: Deps['db'], masterHeaders: string[]): ZoneReconcileConfig {
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

function loadZoneSource(db: Deps['db']): { username: string; datasetId: string } {
  const raw = db.getSetting(ZONE_SOURCE_KEY, '');
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

function safeJson(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|forbidden|403/i.test(message)) {
    return `Google denied access. Confirm both copies and the testing folder are shared with the SheetSmart bot as Editor. Details: ${message}`;
  }
  return message;
}

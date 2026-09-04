import type { Request, Response, Router } from 'express';
import type { Deps } from '../types';
import * as google from '../google';
import * as jobs from '../jobs';
import { FOLDER_CLEANUP_TASK } from '../cleanupTasks';
import { planFolderCleanup, type CleanupSheet } from '../lib/folderCleanupEngine';

interface ConnectionRow {
  id: number;
  name: string;
  type: string;
  google_id: string;
  source_tab: string;
}

interface StoredCleanupPreview {
  kind: 'folder_cleanup_preview';
  masterSpreadsheetId: string;
  masterName: string;
  masterTab: string;
  folderId: string;
  fingerprint: string;
  canApply: boolean;
  appliedRunId?: number;
}

export default function registerFolderCleanupRoutes(api: Router, { db }: Deps): void {
  api.post('/folder-cleanup/preview', async (_req: Request, res: Response) => {
    if (!google.isConfigured()) return res.status(400).json({ error: 'Google is not configured.' });
    const master = db.get<ConnectionRow>("SELECT * FROM connections WHERE type='master' ORDER BY id LIMIT 1");
    const folder = db.get<ConnectionRow>("SELECT * FROM connections WHERE type='captain_folder' ORDER BY id LIMIT 1");
    if (!master || !folder) {
      return res.status(400).json({ error: 'Configure the master and captain folder under Sources first.' });
    }
    const inserted = db.run(
      `INSERT INTO runs (workflow_name, type, mode, status, started_at)
       VALUES ('Folder-wide data cleanup', 'preview_folder_wide_cleanup', 'dry', 'running', datetime('now'))`
    );
    const runId = Number(inserted.lastInsertRowid);
    try {
      const files = await google.listSpreadsheetsInFolder(folder.google_id);
      if (files.some((file) => file.id === master.google_id)) {
        throw new Error('The master spreadsheet cannot also be inside the captain folder.');
      }
      const masterSheet = await google.readCleanupSheet(master.google_id, master.source_tab || undefined, master.name);
      const captains: CleanupSheet[] = [];
      const readErrors: Array<{ spreadsheet: string; reason: string }> = [];
      await mapLimit(files, 4, async (file) => {
        try {
          captains.push(await google.readCleanupSheet(file.id, undefined, file.name));
        } catch (error) {
          readErrors.push({ spreadsheet: file.name, reason: friendly(error) });
        }
      });
      const plan = planFolderCleanup(masterSheet, captains);
      const canApply = plan.canApply && readErrors.length === 0 && captains.length === files.length;
      const summary = {
        kind: 'folder_cleanup_preview' as const,
        masterSpreadsheetId: master.google_id,
        masterName: masterSheet.spreadsheetName,
        masterTab: masterSheet.tabName,
        folderId: folder.google_id,
        fingerprint: plan.fingerprint,
        generatedAt: new Date().toISOString(),
        totals: plan.totals,
        readErrors,
        sheets: plan.sheets.map((sheet) => ({
          spreadsheetName: sheet.spreadsheetName,
          role: sheet.role,
          tabName: sheet.tabName,
          columnsToDelete: sheet.deleteColumns.map((column) => column.header),
          booleansToStandardize: sheet.booleanChanges.length,
          unitsToRepair: sheet.unitChanges.length,
          cellChanges: [
            ...sheet.booleanChanges.map((change) => ({
              row: change.row,
              column: change.column,
              action: `set to boolean ${change.afterValue === true ? 'true' : 'false'}`,
            })),
            ...sheet.unitChanges.map((change) => ({
              row: change.row,
              column: change.column,
              action: 'replace with master value for address_id',
            })),
          ],
          formatUnitAsText: sheet.formatUnitColumn !== null,
          blocks: sheet.blocks,
          canApply: sheet.canApply,
        })),
        canApply,
      };
      db.run("UPDATE runs SET status='succeeded', finished_at=datetime('now'), summary_json=? WHERE id=?", [
        JSON.stringify(summary),
        runId,
      ]);
      return res.json({ runId, ...summary });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now'), summary_json=? WHERE id=?", [
        JSON.stringify({ error: friendly(error) }),
        runId,
      ]);
      return res.status(502).json({ error: friendly(error) });
    }
  });

  api.post('/folder-cleanup/apply', (req: Request, res: Response) => {
    const previewRunId = Number(req.body?.previewRunId);
    if (!Number.isInteger(previewRunId) || previewRunId <= 0) {
      return res.status(400).json({ error: 'A valid cleanup preview is required.' });
    }
    if (req.body?.confirmation !== 'CLEANUP') {
      return res.status(400).json({ error: 'Type CLEANUP to approve these folder-wide changes.' });
    }
    const preview = db.get<{ type: string; mode: string; status: string; summary_json: string }>(
      'SELECT type, mode, status, summary_json FROM runs WHERE id=?',
      [previewRunId]
    );
    if (
      !preview ||
      preview.type !== 'preview_folder_wide_cleanup' ||
      preview.mode !== 'dry' ||
      preview.status !== 'succeeded'
    ) {
      return res.status(400).json({ error: 'That cleanup preview is not available.' });
    }
    const plan = parsePreview(preview.summary_json);
    if (!plan?.canApply) {
      return res.status(409).json({ error: 'Resolve every preview block and run a fresh scan before cleanup.' });
    }
    try {
      const queued = jobs.enqueueFromPreview(previewRunId, 'preview_folder_wide_cleanup', {
        workflowName: 'Folder-wide data cleanup',
        type: FOLDER_CLEANUP_TASK,
        mode: 'live',
        params: {
          masterSpreadsheetId: plan.masterSpreadsheetId,
          masterName: plan.masterName,
          masterTab: plan.masterTab,
          folderId: plan.folderId,
          fingerprint: plan.fingerprint,
        },
      });
      plan.appliedRunId = queued.runId;
      db.run('UPDATE runs SET summary_json=? WHERE id=?', [JSON.stringify({ ...JSON.parse(preview.summary_json), ...plan }), previewRunId]);
      return res.status(202).json({ ...queued, status: 'queued' });
    } catch (error) {
      if (error instanceof jobs.PreviewAlreadyClaimedError) return res.status(409).json({ error: error.message });
      if (error instanceof jobs.PreviewUnavailableError) return res.status(400).json({ error: error.message });
      throw error;
    }
  });
}

function parsePreview(json: string): StoredCleanupPreview | null {
  try {
    const value = JSON.parse(json) as StoredCleanupPreview;
    return value.kind === 'folder_cleanup_preview' &&
      value.masterSpreadsheetId &&
      value.masterTab &&
      value.folderId &&
      value.fingerprint
      ? value
      : null;
  } catch {
    return null;
  }
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await worker(items[cursor++]);
  });
  await Promise.all(runners);
}

function friendly(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

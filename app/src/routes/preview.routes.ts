import type { Router, Request, Response } from 'express';
import * as google from '../google';
import type { Deps } from '../types';
import { buildSourceLookup, planCellFill, planPushMissingResidents, trimHeaders, type Grid } from '../lib/mergeEngine';
import {
  buildCellFillConfig,
  summarizeCellFill,
  summarizePushMissing,
  type DictField,
} from '../lib/previewEngine';

interface ConnectionRow {
  id: number;
  name: string;
  type: string;
  google_id: string;
  source_tab: string;
}

interface DictFieldRow {
  id: number;
  canonical_name: string;
  is_identity: number;
  is_sensitive: number;
  default_policy: string;
}

// The guided playbooks that currently support a dry-run preview. Each maps onto
// a tested pure planner in mergeEngine (SHEETSMART_VISION_AND_ROADMAP.md §5.2).
export const PREVIEW_PLAYBOOKS = [
  {
    key: 'import_sales',
    title: 'Pull in the newest sales data',
    engine: 'import → master (cell-fill, matched by APN)',
    kind: 'cell_fill',
  },
  {
    key: 'push_master',
    title: 'Push the latest master data to captains',
    engine: 'push → folder (cell-fill, matched by resident_id)',
    kind: 'cell_fill',
  },
  {
    key: 'add_missing_residents',
    title: 'Add new residents to the right captain sheets',
    engine: 'push missing residents by detected zone',
    kind: 'push_missing',
  },
] as const;

type PlaybookKey = (typeof PREVIEW_PLAYBOOKS)[number]['key'];

async function readSheetGrid(spreadsheetId: string, tab?: string): Promise<Grid> {
  const range = tab ? google.a1Range(tab, 'A:ZZ') : 'A:ZZ';
  return (await google.readValues(spreadsheetId, range)) as Grid;
}

function friendlyGoogleError(e: unknown): string {
  const msg = String((e as Error)?.message || e);
  if (/permission|not have access|forbidden|403/i.test(msg)) {
    return 'Google returned a permission error. Make sure the sheet/folder is shared with the service account as Editor. Details: ' + msg;
  }
  if (/not found|404/i.test(msg)) return 'Google could not find that ID. Details: ' + msg;
  return msg;
}

// Read-only Preview (dry run). Reads the relevant sources, runs a tested pure
// planner, and returns a plain-language impact summary plus a per-sheet
// breakdown. It records a durable dry run, but writes NOTHING to any sheet.
export default function registerPreviewRoutes(api: Router, { db }: Deps): void {
  api.get('/preview/playbooks', (_req: Request, res: Response) => {
    res.json(PREVIEW_PLAYBOOKS);
  });

  api.post('/preview', async (req: Request, res: Response) => {
    const playbook = String(req.body?.playbook || '') as PlaybookKey;
    if (!PREVIEW_PLAYBOOKS.some((p) => p.key === playbook)) {
      return res.status(400).json({ error: `Unknown playbook "${playbook}".` });
    }
    if (!google.isConfigured()) {
      return res.status(400).json({ error: 'Google is not configured yet (README Section A).' });
    }

    const master = db.get<ConnectionRow>("SELECT * FROM connections WHERE type = 'master' ORDER BY id LIMIT 1");
    const folder = db.get<ConnectionRow>("SELECT * FROM connections WHERE type = 'captain_folder' ORDER BY id LIMIT 1");
    const external = db.get<ConnectionRow>("SELECT * FROM connections WHERE type = 'external' ORDER BY id LIMIT 1");

    if (!master) return res.status(400).json({ error: 'No master connection is configured (Sources).' });
    if (playbook === 'import_sales' && !external) {
      return res.status(400).json({ error: 'No external source (sales tracker) is configured (Sources).' });
    }
    if ((playbook === 'push_master' || playbook === 'add_missing_residents') && !folder) {
      return res.status(400).json({ error: 'No captain folder is configured (Sources).' });
    }

    const dict = loadDictionary(db);

    const runInsert = db.run(
      `INSERT INTO runs (workflow_name, type, mode, status, started_at)
       VALUES (?, ?, 'dry', 'running', datetime('now'))`,
      [PREVIEW_PLAYBOOKS.find((p) => p.key === playbook)!.title, `preview_${playbook}`]
    );
    const runId = Number(runInsert.lastInsertRowid);

    try {
      const masterGrid = await readSheetGrid(master.google_id, master.source_tab || undefined);
      let payload: unknown;

      if (playbook === 'import_sales') {
        payload = await previewImportSales(external!, masterGrid, dict);
      } else if (playbook === 'push_master') {
        payload = await previewPushMaster(folder!, masterGrid, dict);
      } else {
        payload = await previewAddMissing(folder!, masterGrid, dict);
      }

      const impact = (payload as { impact: unknown }).impact;
      db.run(`UPDATE runs SET status = 'succeeded', finished_at = datetime('now'), summary_json = ? WHERE id = ?`, [
        JSON.stringify(impact),
        runId,
      ]);
      return res.json({ runId, playbook, ...(payload as object) });
    } catch (e) {
      db.run(`UPDATE runs SET status = 'failed', finished_at = datetime('now') WHERE id = ?`, [runId]);
      return res.status(502).json({ error: friendlyGoogleError(e) });
    }
  });
}

function loadDictionary(db: Deps['db']): DictField[] {
  const rows = db.all<DictFieldRow>(
    'SELECT id, canonical_name, is_identity, is_sensitive, default_policy FROM dictionary_fields ORDER BY sort_order'
  );
  return rows.map((r) => ({
    canonical_name: r.canonical_name,
    is_identity: r.is_identity,
    is_sensitive: r.is_sensitive,
    default_policy: r.default_policy,
    aliases: db.all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id = ?', [r.id]).map((a) => a.alias),
  }));
}

function sensitiveNames(dict: DictField[]): string[] {
  return dict.filter((f) => f.is_sensitive === 1).map((f) => f.canonical_name);
}

// ---- Playbook implementations ----

async function previewImportSales(external: ConnectionRow, masterGrid: Grid, dict: DictField[]) {
  const salesGrid = await readSheetGrid(external.google_id, external.source_tab || undefined);
  const cfg = buildCellFillConfig(trimHeaders(salesGrid[0]), trimHeaders(masterGrid[0]), 'APN', dict);
  if (!cfg.matchSourceHeader) throw new Error('The sales tracker has no APN column to match on.');
  if (!cfg.matchTargetHeader) throw new Error('The master has no APN column to match on.');

  const { lookup } = buildSourceLookup(salesGrid, cfg.matchSourceHeader);
  const plan = planCellFill(masterGrid, lookup, cfg.matchTargetHeader, cfg.columnMap, {
    policies: cfg.policies,
    protectedColumns: cfg.protectedColumns,
    defaultPolicy: 'fill_blank',
  });

  const impact = summarizeCellFill([plan]);
  return {
    impact,
    unmatchedFields: cfg.unmatchedFields,
    target: 'master',
    sheets: [
      {
        name: 'Master Data File',
        url: '',
        filled: plan.filled.length,
        conflicts: plan.conflicts.length,
        overwritten: plan.overwritten.length,
        columnsToAdd: plan.columnsToAdd.length,
        errors: plan.errors.map((e) => e.message),
      },
    ],
  };
}

async function previewPushMaster(folder: ConnectionRow, masterGrid: Grid, dict: DictField[]) {
  const files = await google.listSpreadsheetsInFolder(folder.google_id);
  const masterHeaders = trimHeaders(masterGrid[0]);
  const plans = [];
  const sheets = [];

  // The master (source) side is constant across every captain sheet, so resolve
  // its resident_id header and build the lookup once.
  const masterField = dict.find((f) => f.canonical_name === 'resident_id');
  const masterMatchHeader = masterField
    ? buildCellFillConfig(masterHeaders, masterHeaders, 'resident_id', dict).matchSourceHeader
    : masterHeaders.includes('resident_id')
      ? 'resident_id'
      : null;
  if (!masterMatchHeader) throw new Error('The master has no resident_id column to match on.');
  const { lookup } = buildSourceLookup(masterGrid, masterMatchHeader);

  for (const f of files) {
    try {
      const captainGrid = await readSheetGrid(f.id);
      const cfg = buildCellFillConfig(masterHeaders, trimHeaders(captainGrid[0]), 'resident_id', dict);
      if (!cfg.matchTargetHeader) {
        sheets.push({ name: f.name, url: f.webViewLink, filled: 0, conflicts: 0, overwritten: 0, columnsToAdd: 0, errors: ['No resident_id column to match on'] });
        continue;
      }
      const plan = planCellFill(captainGrid, lookup, cfg.matchTargetHeader, cfg.columnMap, {
        policies: cfg.policies,
        protectedColumns: cfg.protectedColumns,
        defaultPolicy: 'fill_blank',
      });
      plans.push(plan);
      sheets.push({
        name: f.name,
        url: f.webViewLink,
        filled: plan.filled.length,
        conflicts: plan.conflicts.length,
        overwritten: plan.overwritten.length,
        columnsToAdd: plan.columnsToAdd.length,
        errors: plan.errors.map((e) => e.message),
      });
    } catch (e) {
      sheets.push({ name: f.name, url: f.webViewLink, filled: 0, conflicts: 0, overwritten: 0, columnsToAdd: 0, errors: [friendlyGoogleError(e)] });
    }
  }

  return { impact: summarizeCellFill(plans), target: 'folder', sheets };
}

async function previewAddMissing(folder: ConnectionRow, masterGrid: Grid, dict: DictField[]) {
  const files = await google.listSpreadsheetsInFolder(folder.google_id);
  const sensitive = sensitiveNames(dict);
  const plans = [];
  const sheets = [];

  for (const f of files) {
    try {
      const captainGrid = await readSheetGrid(f.id);
      const plan = planPushMissingResidents(captainGrid, masterGrid, { sensitiveColumns: sensitive });
      plans.push(plan);
      sheets.push({
        name: f.name,
        url: f.webViewLink,
        appended: plan.appended.length,
        flagged: plan.flagged.length,
        detectedZone: plan.detectedZone,
        errors: plan.errors.map((e) => e.message),
      });
    } catch (e) {
      sheets.push({ name: f.name, url: f.webViewLink, appended: 0, flagged: 0, detectedZone: '', errors: [friendlyGoogleError(e)] });
    }
  }

  return { impact: summarizePushMissing(plans), target: 'folder', sheets };
}

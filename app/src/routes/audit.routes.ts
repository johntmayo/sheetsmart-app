import type { Router, Request, Response } from 'express';
import * as google from '../google';
import type { Deps } from '../types';
import { runAudit, type SheetInput, type Grid } from '../lib/auditEngine';

interface ConnectionRow {
  id: number;
  name: string;
  type: string;
  google_id: string;
  source_tab: string;
}

const LAST_AUDIT_KEY = 'last_audit_report';

function queryTab(req: Request): string {
  return typeof req.query.tab === 'string' ? req.query.tab : '';
}

// Read a sheet's full first-tab grid (or a named tab). Mirrors the legacy audit,
// which reads getDataRange() of the spreadsheet's first sheet. A column-only A1
// range ("A:ZZ") returns every row; omitting the tab name targets the first tab.
async function readSheetGrid(spreadsheetId: string, tab?: string): Promise<Grid> {
  const range = tab ? google.a1Range(tab, 'A:ZZ') : 'A:ZZ';
  return (await google.readValues(spreadsheetId, range)) as Grid;
}

// Phase 0 read-only connection test + live-header lookups for the config forms.
// Nothing here writes to any sheet.
export default function registerAuditRoutes(api: Router, { db }: Deps): void {
  // Test a stored connection (or an ad-hoc one passed in the body).
  api.post('/test-connection', async (req: Request, res: Response) => {
    try {
      if (!google.isConfigured()) {
        return res.status(400).json({
          ok: false,
          error:
            'Google is not configured yet. Add GOOGLE_SERVICE_ACCOUNT_JSON_B64 to your .env (README Section A), then restart.',
        });
      }

      let { type, google_id, source_tab } = req.body || {};
      if (req.body && req.body.connectionId) {
        const conn = db.get<ConnectionRow>('SELECT * FROM connections WHERE id = ?', [req.body.connectionId]);
        if (!conn) return res.status(404).json({ ok: false, error: 'Connection not found' });
        type = conn.type;
        google_id = conn.google_id;
        source_tab = conn.source_tab;
      }
      if (!type || !google_id) {
        return res.status(400).json({ ok: false, error: 'type and google_id are required.' });
      }

      if (type === 'captain_folder') {
        const files = await google.listSpreadsheetsInFolder(google_id);
        return res.json({
          ok: true,
          kind: 'folder',
          count: files.length,
          spreadsheets: files.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime })),
        });
      }

      // master or external spreadsheet: return title, tabs, and first-tab headers.
      const meta = await google.getSpreadsheetMeta(google_id);
      const tab = source_tab || meta.tabs[0] || 'Sheet1';
      const headers = await google.readHeaders(google_id, tab);
      return res.json({
        ok: true,
        kind: 'spreadsheet',
        title: meta.title,
        tabs: meta.tabs,
        tabRead: tab,
        headerCount: headers.filter((h) => h !== '').length,
        headers,
      });
    } catch (e) {
      // Surface Google's message in plain terms; common cause is "not shared".
      res.status(502).json({
        ok: false,
        error: friendlyGoogleError(e),
      });
    }
  });

  // The ambient Health audit (SHEETSMART_VISION_AND_ROADMAP.md §5.4). Read-only:
  // reads the master + every captain sheet and runs the pure audit engine, which
  // ports the legacy Code.gs counting rules. Nothing is written to any sheet.
  api.post('/audit/run', async (_req: Request, res: Response) => {
    try {
      if (!google.isConfigured()) {
        return res.status(400).json({
          error:
            'Google is not configured yet. Add GOOGLE_SERVICE_ACCOUNT_JSON_B64 to your .env (README Section A), then restart.',
        });
      }

      const master = db.get<ConnectionRow>("SELECT * FROM connections WHERE type = 'master' ORDER BY id LIMIT 1");
      const folder = db.get<ConnectionRow>(
        "SELECT * FROM connections WHERE type = 'captain_folder' ORDER BY id LIMIT 1"
      );
      if (!master) return res.status(400).json({ error: 'No master connection is configured yet (Sources → add a master).' });
      if (!folder) {
        return res.status(400).json({ error: 'No captain folder connection is configured yet (Sources → add a captain folder).' });
      }

      // Record the run up front so an interrupted audit is still visible.
      const runInsert = db.run(
        `INSERT INTO runs (workflow_name, type, mode, status, started_at)
         VALUES (?, 'audit', 'dry', 'running', datetime('now'))`,
        ['Health audit']
      );
      const runId = Number(runInsert.lastInsertRowid);

      try {
        const masterGrid = await readSheetGrid(master.google_id, master.source_tab || undefined);

        const files = await google.listSpreadsheetsInFolder(folder.google_id);
        const sheets: SheetInput[] = [];
        for (const f of files) {
          try {
            const data = await readSheetGrid(f.id);
            sheets.push({ name: f.name, url: f.webViewLink, data });
          } catch (e) {
            // One bad sheet must never kill the whole run (legacy invariant).
            sheets.push({ name: f.name, url: f.webViewLink, error: friendlyGoogleError(e) });
          }
        }

        const report = runAudit(masterGrid, sheets);

        db.setSetting(LAST_AUDIT_KEY, JSON.stringify({ runId, report }));
        db.run(
          `UPDATE runs SET status = 'succeeded', finished_at = datetime('now'), summary_json = ? WHERE id = ?`,
          [JSON.stringify(report.summary), runId]
        );

        return res.json({ runId, report });
      } catch (e) {
        db.run(`UPDATE runs SET status = 'failed', finished_at = datetime('now') WHERE id = ?`, [runId]);
        throw e;
      }
    } catch (e) {
      res.status(502).json({ error: friendlyGoogleError(e) });
    }
  });

  // The last computed audit, so the Health screen can show alignment at a glance
  // without re-scanning every sheet on each visit.
  api.get('/audit/latest', (_req: Request, res: Response) => {
    const raw = db.getSetting(LAST_AUDIT_KEY, '');
    if (!raw) return res.json({ report: null, runId: null });
    try {
      const parsed = JSON.parse(raw) as { runId: number; report: unknown };
      return res.json({ report: parsed.report, runId: parsed.runId });
    } catch {
      return res.json({ report: null, runId: null });
    }
  });

  // Live headers for a stored connection — used to validate column mappings.
  api.get('/connections/:id/headers', async (req: Request, res: Response) => {
    try {
      const conn = db.get<ConnectionRow>('SELECT * FROM connections WHERE id = ?', [req.params.id]);
      if (!conn) return res.status(404).json({ error: 'Connection not found' });
      if (!google.isConfigured()) return res.status(400).json({ error: 'Google is not configured yet.' });

      if (conn.type === 'captain_folder') {
        // Read headers from the first spreadsheet in the folder as a sample.
        const files = await google.listSpreadsheetsInFolder(conn.google_id);
        if (files.length === 0) return res.json({ headers: [], sampleFrom: null });
        const headers = await google.readHeaders(files[0].id, queryTab(req));
        return res.json({ headers, sampleFrom: files[0].name });
      }
      const headers = await google.readHeaders(conn.google_id, queryTab(req) || conn.source_tab || '');
      res.json({ headers, sampleFrom: conn.name });
    } catch (e) {
      res.status(502).json({ error: friendlyGoogleError(e) });
    }
  });
}

function friendlyGoogleError(e: unknown): string {
  const msg = String((e as Error)?.message || e);
  if (/permission|not have access|forbidden|403/i.test(msg)) {
    return (
      'Google returned a permission error. Make sure the sheet/folder is shared with the service account as Editor (README Section B). Details: ' +
      msg
    );
  }
  if (/not found|404/i.test(msg)) {
    return 'Google could not find that ID. Double-check the spreadsheet/folder ID. Details: ' + msg;
  }
  return msg;
}

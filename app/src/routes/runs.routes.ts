import type { Router, Request, Response } from 'express';
import type { Deps } from '../types';

// Run history + run review (spec "Run Review"). For a live run, the run record
// and its detail rows ARE the permanent audit trail.
export default function registerRunRoutes(api: Router, { db }: Deps): void {
  api.get('/runs', (_req: Request, res: Response) => {
    res.json(
      db.all(
        `SELECT id, workflow_id, workflow_name, type, mode, status, actor,
                summary_json, started_at, finished_at, created_at,
                (SELECT COUNT(*) FROM run_snapshots s WHERE s.run_id = runs.id) AS snapshot_count,
                (SELECT COUNT(*) FROM run_snapshots s
                 WHERE s.run_id = runs.id AND s.operation = 'row_append'
                   AND s.reverted_by_run_id IS NULL) AS unreverted_append_count,
                (SELECT COUNT(*) FROM run_snapshots s
                 WHERE s.run_id = runs.id AND s.operation = 'cell_update'
                   AND s.reverted_by_run_id IS NULL) AS unreverted_cell_count,
                (SELECT COUNT(*) FROM run_snapshots s
                 WHERE s.run_id = runs.id AND s.operation = 'row_delete'
                   AND s.reverted_by_run_id IS NULL) AS unreverted_delete_count
         FROM runs ORDER BY id DESC LIMIT 200`
      )
    );
  });

  api.get('/runs/:id', (req: Request, res: Response) => {
    const run = db.get('SELECT * FROM runs WHERE id = ?', [req.params.id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const job = db.get('SELECT * FROM jobs WHERE run_id = ? ORDER BY id DESC LIMIT 1', [req.params.id]);
    // Counts by log-entry type for the summary panel.
    const typeCounts = db.all('SELECT type, COUNT(*) AS n FROM run_log_entries WHERE run_id = ? GROUP BY type', [
      req.params.id,
    ]);
    const snapshotCounts = db.all(
      `SELECT operation,
              COUNT(*) AS n,
              SUM(CASE WHEN reverted_by_run_id IS NULL THEN 1 ELSE 0 END) AS remaining
       FROM run_snapshots WHERE run_id = ? GROUP BY operation`,
      [req.params.id]
    );
    res.json({ run, job, typeCounts, snapshotCounts });
  });

  // Filterable/sortable detail rows. Supports ?type= & pagination.
  api.get('/runs/:id/log', (req: Request, res: Response) => {
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const limit = Math.min(parseInt(String(req.query.limit ?? ''), 10) || 500, 5000);
    const offset = parseInt(String(req.query.offset ?? ''), 10) || 0;
    const params: unknown[] = [req.params.id];
    let where = 'run_id = ?';
    if (type) {
      where += ' AND type = ?';
      params.push(type);
    }
    const rows = db.all(
      `SELECT id, spreadsheet, row, column, resident_id, type, existing_value, incoming_value, message
       FROM run_log_entries WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json(rows);
  });

  // Conflicts review (spec). Derived rows with open/resolved status.
  api.get('/conflicts', (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'open';
    res.json(
      db.all(
        `SELECT c.*, r.workflow_name, r.type AS run_type
         FROM conflicts c JOIN runs r ON r.id = c.run_id
         WHERE c.status = ? ORDER BY c.id DESC LIMIT 500`,
        [status]
      )
    );
  });

  api.put('/conflicts/:id', (req: Request, res: Response) => {
    const c = db.get('SELECT * FROM conflicts WHERE id = ?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Conflict not found' });
    const status = req.body && req.body.status === 'resolved' ? 'resolved' : 'open';
    const notes = String((req.body && req.body.resolution_notes) || '');
    db.run('UPDATE conflicts SET status = ?, resolution_notes = ? WHERE id = ?', [status, notes, req.params.id]);
    res.json(db.get('SELECT * FROM conflicts WHERE id = ?', [req.params.id]));
  });
}

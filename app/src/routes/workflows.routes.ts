import type { Router, Request, Response } from 'express';
import { VALID_POLICIES } from '../lib/writeGuard';
import type { Deps, Db } from '../types';

export interface WorkflowTypeInfo {
  type: string;
  label: string;
  category: 'cell_fill' | 'row_append' | 'pull_data' | 'schema';
  destructive: boolean;
}

// The workflow types SheetSmart supports (handoff Section 7). Kept here as the
// single source of truth for the UI's workflow-card catalog.
export const WORKFLOW_TYPES: WorkflowTypeInfo[] = [
  { type: 'import_to_master', label: 'Update Master From Sales Tracker', category: 'cell_fill', destructive: false },
  { type: 'push_one_captain', label: 'Push Dashboard Fields → One Captain Sheet', category: 'cell_fill', destructive: false },
  { type: 'push_folder', label: 'Push Dashboard Fields → Captain Sheets Folder', category: 'cell_fill', destructive: false },
  { type: 'push_missing_one', label: 'Push Missing Residents → One Captain Sheet', category: 'row_append', destructive: false },
  { type: 'push_missing_folder', label: 'Push Missing Residents → Captain Sheets Folder', category: 'row_append', destructive: false },
  { type: 'pull_missing_one', label: 'Pull Missing Rows ← One Captain Sheet', category: 'row_append', destructive: false },
  { type: 'pull_missing_folder', label: 'Pull Missing Rows ← Captain Sheets Folder', category: 'row_append', destructive: false },
  { type: 'pull_data_one', label: 'Pull Data ← One Captain Sheet', category: 'pull_data', destructive: false },
  { type: 'pull_data_folder', label: 'Pull Data ← Captain Sheets Folder', category: 'pull_data', destructive: false },
  { type: 'rename_column_folder', label: 'Rename Column Across Captain Sheets', category: 'schema', destructive: false },
  { type: 'delete_columns_one', label: 'Delete Columns from One Captain Sheet', category: 'schema', destructive: true },
  { type: 'delete_columns_folder', label: 'Delete Columns from Captain Sheets Folder', category: 'schema', destructive: true },
];
const VALID_WORKFLOW_TYPES = WORKFLOW_TYPES.map((w) => w.type);

interface WorkflowRow {
  id: number;
  name: string;
  type: string;
  source_connection_id: number | null;
  target_connection_id: number | null;
  match_column: string;
  source_tab: string;
  notes: string;
  column_mappings?: unknown[];
  column_policies?: unknown[];
}

function hydrate<T extends WorkflowRow | undefined>(db: Db, workflow: T): T {
  if (!workflow) return workflow;
  workflow.column_mappings = db.all(
    'SELECT id, source_column, target_column, sort_order FROM column_mappings WHERE workflow_id = ? ORDER BY sort_order, id',
    [workflow.id]
  );
  workflow.column_policies = db.all(
    'SELECT id, column_name, policy FROM column_policies WHERE workflow_id = ? ORDER BY id',
    [workflow.id]
  );
  return workflow;
}

export default function registerWorkflowRoutes(api: Router, { db }: Deps): void {
  // Catalog of supported workflow types for the UI.
  api.get('/workflow-types', (_req: Request, res: Response) => res.json(WORKFLOW_TYPES));

  api.get('/workflows', (_req: Request, res: Response) => {
    const rows = db.all<WorkflowRow>('SELECT * FROM workflows ORDER BY name');
    res.json(rows.map((w) => hydrate(db, w)));
  });

  api.get('/workflows/:id', (req: Request, res: Response) => {
    const row = db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Workflow not found' });
    res.json(hydrate(db, row));
  });

  api.post('/workflows', (req: Request, res: Response) => {
    const b = req.body || {};
    if (!b.name || !b.type) return res.status(400).json({ error: 'name and type are required.' });
    if (!VALID_WORKFLOW_TYPES.includes(b.type)) {
      return res.status(400).json({ error: 'Unknown workflow type.' });
    }
    const info = db.run(
      `INSERT INTO workflows (name, type, source_connection_id, target_connection_id, match_column, source_tab, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        b.name.trim(),
        b.type,
        b.source_connection_id || null,
        b.target_connection_id || null,
        (b.match_column || '').trim(),
        (b.source_tab || '').trim(),
        (b.notes || '').trim(),
      ]
    );
    res.status(201).json(hydrate(db, db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', [info.lastInsertRowid])));
  });

  api.put('/workflows/:id', (req: Request, res: Response) => {
    const existing = db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Workflow not found' });
    const b = req.body || {};
    db.run(
      `UPDATE workflows SET name = ?, source_connection_id = ?, target_connection_id = ?,
         match_column = ?, source_tab = ?, notes = ? WHERE id = ?`,
      [
        (b.name != null ? b.name : existing.name).trim(),
        b.source_connection_id !== undefined ? b.source_connection_id || null : existing.source_connection_id,
        b.target_connection_id !== undefined ? b.target_connection_id || null : existing.target_connection_id,
        (b.match_column != null ? b.match_column : existing.match_column).trim(),
        (b.source_tab != null ? b.source_tab : existing.source_tab).trim(),
        (b.notes != null ? b.notes : existing.notes).trim(),
        req.params.id,
      ]
    );
    res.json(hydrate(db, db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', [req.params.id])));
  });

  api.delete('/workflows/:id', (req: Request, res: Response) => {
    db.run('DELETE FROM workflows WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // Replace the full set of column mappings for a workflow.
  api.put('/workflows/:id/mappings', (req: Request, res: Response) => {
    const wf = db.get('SELECT id FROM workflows WHERE id = ?', [req.params.id]);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const mappings = Array.isArray(req.body && req.body.mappings) ? req.body.mappings : [];
    const tx = db.transaction(() => {
      db.run('DELETE FROM column_mappings WHERE workflow_id = ?', [req.params.id]);
      mappings.forEach((m: { source_column?: string; target_column?: string }, i: number) => {
        const src = String(m.source_column || '').trim();
        const tgt = String(m.target_column || '').trim();
        if (!src || !tgt) return;
        db.run(
          'INSERT INTO column_mappings (workflow_id, source_column, target_column, sort_order) VALUES (?, ?, ?, ?)',
          [req.params.id, src, tgt, i]
        );
      });
    });
    tx();
    res.json(hydrate(db, db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', [req.params.id])));
  });

  // Replace the full set of column policies for a workflow.
  api.put('/workflows/:id/policies', (req: Request, res: Response) => {
    const wf = db.get('SELECT id FROM workflows WHERE id = ?', [req.params.id]);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const policies = Array.isArray(req.body && req.body.policies) ? req.body.policies : [];
    for (const p of policies) {
      if (p.policy && !VALID_POLICIES.includes(p.policy)) {
        return res.status(400).json({ error: `Invalid policy "${p.policy}".` });
      }
    }
    const tx = db.transaction(() => {
      db.run('DELETE FROM column_policies WHERE workflow_id = ?', [req.params.id]);
      for (const p of policies) {
        const name = String(p.column_name || '').trim();
        if (!name || !p.policy) continue;
        db.run('INSERT INTO column_policies (workflow_id, column_name, policy) VALUES (?, ?, ?)', [
          req.params.id,
          name,
          p.policy,
        ]);
      }
    });
    tx();
    res.json(hydrate(db, db.get<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', [req.params.id])));
  });
}

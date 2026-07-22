import type { Router, Request, Response } from 'express';
import type { Deps } from '../types';

const VALID_TYPES = ['master', 'captain_folder', 'external'];

interface ConnectionRow {
  id: number;
  name: string;
  type: string;
  google_id: string;
  source_tab: string;
  notes: string;
  created_at: string;
}

// Connections CRUD (handoff Section 6). A connection is a named reference to a
// Google spreadsheet, Drive folder, or external source.
export default function registerConnectionRoutes(api: Router, { db }: Deps): void {
  api.get('/connections', (_req: Request, res: Response) => {
    res.json(db.all('SELECT * FROM connections ORDER BY type, name'));
  });

  api.get('/connections/:id', (req: Request, res: Response) => {
    const row = db.get('SELECT * FROM connections WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Connection not found' });
    res.json(row);
  });

  api.post('/connections', (req: Request, res: Response) => {
    const { name, type, google_id, source_tab, notes } = req.body || {};
    if (!name || !type || !google_id) {
      return res.status(400).json({ error: 'name, type, and google_id are required.' });
    }
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of ${VALID_TYPES.join(', ')}.` });
    }
    const info = db.run(
      'INSERT INTO connections (name, type, google_id, source_tab, notes) VALUES (?, ?, ?, ?, ?)',
      [name.trim(), type, google_id.trim(), (source_tab || '').trim(), (notes || '').trim()]
    );
    res.status(201).json(db.get('SELECT * FROM connections WHERE id = ?', [info.lastInsertRowid]));
  });

  api.put('/connections/:id', (req: Request, res: Response) => {
    const existing = db.get<ConnectionRow>('SELECT * FROM connections WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Connection not found' });
    const { name, type, google_id, source_tab, notes } = req.body || {};
    if (type && !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of ${VALID_TYPES.join(', ')}.` });
    }
    db.run(
      'UPDATE connections SET name = ?, type = ?, google_id = ?, source_tab = ?, notes = ? WHERE id = ?',
      [
        (name != null ? name : existing.name).trim(),
        type || existing.type,
        (google_id != null ? google_id : existing.google_id).trim(),
        (source_tab != null ? source_tab : existing.source_tab).trim(),
        (notes != null ? notes : existing.notes).trim(),
        req.params.id,
      ]
    );
    res.json(db.get('SELECT * FROM connections WHERE id = ?', [req.params.id]));
  });

  api.delete('/connections/:id', (req: Request, res: Response) => {
    db.run('DELETE FROM connections WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });
}

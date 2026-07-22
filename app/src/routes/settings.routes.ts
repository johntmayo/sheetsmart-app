import type { Router, Request, Response } from 'express';
import type { Deps } from '../types';

// Sensitive-columns list (handoff Section 6). These headers are flagged
// (informational only) when pushing missing residents to captain sheets.
export default function registerSettingsRoutes(api: Router, { db }: Deps): void {
  api.get('/sensitive-columns', (_req: Request, res: Response) => {
    res.json(db.all('SELECT id, column_name FROM sensitive_columns ORDER BY column_name'));
  });

  api.post('/sensitive-columns', (req: Request, res: Response) => {
    const name = String((req.body && req.body.column_name) || '').trim();
    if (!name) return res.status(400).json({ error: 'column_name is required.' });
    try {
      db.run('INSERT INTO sensitive_columns (column_name) VALUES (?)', [name]);
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'That column is already listed.' });
      }
      throw e;
    }
    res.status(201).json(db.get('SELECT id, column_name FROM sensitive_columns WHERE column_name = ?', [name]));
  });

  api.delete('/sensitive-columns/:id', (req: Request, res: Response) => {
    db.run('DELETE FROM sensitive_columns WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });
}

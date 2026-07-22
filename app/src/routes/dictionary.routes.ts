import type { Router, Request, Response } from 'express';
import type { Deps } from '../types';

const VALID_TYPES = ['text', 'number', 'date', 'checkbox'];
const VALID_POLICIES = ['fill_blank', 'overwrite', 'conflict', 'never'];

interface DictionaryFieldRow {
  id: number;
  canonical_name: string;
  data_type: string;
  is_identity: number;
  is_sensitive: number;
  is_text_safe: number;
  default_policy: string;
  notes: string;
  sort_order: number;
}

// Field Dictionary CRUD (vision §5.1). The canonical list of logical fields
// with their type, protection rules, default policy, and aliases. Read-only in
// behavior for now — later phases consume it for matching, audit, and syncs.
export default function registerDictionaryRoutes(api: Router, { db }: Deps): void {
  function withAliases(field: DictionaryFieldRow): DictionaryFieldRow & { aliases: string[] } {
    const aliases = db
      .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id = ? ORDER BY alias', [field.id])
      .map((r) => r.alias);
    return { ...field, aliases };
  }

  api.get('/dictionary', (_req: Request, res: Response) => {
    const fields = db.all<DictionaryFieldRow>('SELECT * FROM dictionary_fields ORDER BY sort_order, canonical_name');
    res.json(fields.map(withAliases));
  });

  api.get('/dictionary/:id', (req: Request, res: Response) => {
    const field = db.get<DictionaryFieldRow>('SELECT * FROM dictionary_fields WHERE id = ?', [req.params.id]);
    if (!field) return res.status(404).json({ error: 'Field not found' });
    res.json(withAliases(field));
  });

  api.post('/dictionary', (req: Request, res: Response) => {
    const body = req.body || {};
    const canonical = String(body.canonical_name || '').trim();
    if (!canonical) return res.status(400).json({ error: 'canonical_name is required.' });
    if (body.data_type && !VALID_TYPES.includes(body.data_type)) {
      return res.status(400).json({ error: `data_type must be one of ${VALID_TYPES.join(', ')}.` });
    }
    if (body.default_policy && !VALID_POLICIES.includes(body.default_policy)) {
      return res.status(400).json({ error: `default_policy must be one of ${VALID_POLICIES.join(', ')}.` });
    }
    const maxOrder = db.get<{ m: number }>('SELECT COALESCE(MAX(sort_order), -1) AS m FROM dictionary_fields')!.m;
    try {
      const info = db.run(
        `INSERT INTO dictionary_fields
           (canonical_name, data_type, is_identity, is_sensitive, is_text_safe, default_policy, notes, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          canonical,
          body.data_type || 'text',
          body.is_identity ? 1 : 0,
          body.is_sensitive ? 1 : 0,
          body.is_text_safe ? 1 : 0,
          body.default_policy || 'fill_blank',
          String(body.notes || ''),
          maxOrder + 1,
        ]
      );
      saveAliases(info.lastInsertRowid, body.aliases);
      const field = db.get<DictionaryFieldRow>('SELECT * FROM dictionary_fields WHERE id = ?', [info.lastInsertRowid]);
      res.status(201).json(withAliases(field!));
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'A field with that canonical name already exists.' });
      }
      throw e;
    }
  });

  api.put('/dictionary/:id', (req: Request, res: Response) => {
    const existing = db.get<DictionaryFieldRow>('SELECT * FROM dictionary_fields WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Field not found' });
    const body = req.body || {};
    if (body.data_type && !VALID_TYPES.includes(body.data_type)) {
      return res.status(400).json({ error: `data_type must be one of ${VALID_TYPES.join(', ')}.` });
    }
    if (body.default_policy && !VALID_POLICIES.includes(body.default_policy)) {
      return res.status(400).json({ error: `default_policy must be one of ${VALID_POLICIES.join(', ')}.` });
    }
    const canonical = body.canonical_name != null ? String(body.canonical_name).trim() : existing.canonical_name;
    if (!canonical) return res.status(400).json({ error: 'canonical_name cannot be blank.' });

    try {
      db.run(
        `UPDATE dictionary_fields SET
           canonical_name = ?, data_type = ?, is_identity = ?, is_sensitive = ?,
           is_text_safe = ?, default_policy = ?, notes = ?
         WHERE id = ?`,
        [
          canonical,
          body.data_type || existing.data_type,
          body.is_identity != null ? (body.is_identity ? 1 : 0) : existing.is_identity,
          body.is_sensitive != null ? (body.is_sensitive ? 1 : 0) : existing.is_sensitive,
          body.is_text_safe != null ? (body.is_text_safe ? 1 : 0) : existing.is_text_safe,
          body.default_policy || existing.default_policy,
          body.notes != null ? String(body.notes) : existing.notes,
          req.params.id,
        ]
      );
    } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'A field with that canonical name already exists.' });
      }
      throw e;
    }
    if (body.aliases !== undefined) saveAliases(req.params.id, body.aliases);
    const field = db.get<DictionaryFieldRow>('SELECT * FROM dictionary_fields WHERE id = ?', [req.params.id]);
    res.json(withAliases(field!));
  });

  api.delete('/dictionary/:id', (req: Request, res: Response) => {
    db.run('DELETE FROM dictionary_fields WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  // Replace the full alias set for a field. Aliases are deduplicated and blanks
  // are dropped; canonical name is always matched implicitly, so it need not be
  // listed here.
  function saveAliases(fieldId: number | bigint | string, aliases: unknown): void {
    if (!Array.isArray(aliases)) return;
    const clean = [...new Set(aliases.map((a) => String(a || '').trim()).filter(Boolean))];
    const tx = db.transaction(() => {
      db.run('DELETE FROM dictionary_aliases WHERE field_id = ?', [fieldId]);
      for (const a of clean) db.run('INSERT INTO dictionary_aliases (field_id, alias) VALUES (?, ?)', [fieldId, a]);
    });
    tx();
  }
}

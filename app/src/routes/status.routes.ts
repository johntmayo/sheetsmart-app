import type { Router, Request, Response } from 'express';
import * as google from '../google';
import type { Deps } from '../types';

interface ConnectionRow {
  id: number;
  name: string;
  type: string;
  google_id: string;
}

// Home dashboard status (handoff/spec "Home Dashboard"). Read-only summary of
// what is connected and what has run recently.
export default function registerStatusRoutes(api: Router, { db }: Deps): void {
  api.get('/status', (_req: Request, res: Response) => {
    const connections = db.all<ConnectionRow>('SELECT id, name, type, google_id FROM connections');
    const byType = (t: string) => connections.filter((c) => c.type === t);

    const recentRuns = db.all(
      `SELECT id, workflow_name, type, mode, status, started_at, finished_at, summary_json
       FROM runs ORDER BY id DESC LIMIT 10`
    );
    const openConflicts = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conflicts WHERE status = 'open'")!.n;

    res.json({
      google: {
        configured: google.isConfigured(),
        // Safe to surface for confirmation; never exposes the private key.
        clientEmail: google.isConfigured() ? google.getClientEmail() : null,
      },
      connections: {
        master: byType('master'),
        captain_folder: byType('captain_folder'),
        external: byType('external'),
        total: connections.length,
      },
      counts: {
        workflows: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM workflows')!.n,
        sensitiveColumns: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sensitive_columns')!.n,
        dictionaryFields: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM dictionary_fields')!.n,
        sensitiveFields: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM dictionary_fields WHERE is_sensitive = 1')!.n,
        openConflicts,
      },
      recentRuns,
    });
  });
}

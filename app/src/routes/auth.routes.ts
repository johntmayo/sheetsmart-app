import type { Express, Request, Response } from 'express';
import { checkPassword, issueSession, clearSession, isAuthenticated } from '../auth';
import type { Deps } from '../types';

// Public authentication routes. Registered before the auth gate.
export default function registerAuthRoutes(app: Express, _deps: Deps): void {
  app.post('/api/login', (req: Request, res: Response) => {
    const { password } = req.body || {};
    if (!checkPassword(password)) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    issueSession(res);
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req: Request, res: Response) => {
    clearSession(res);
    res.json({ ok: true });
  });

  // Lets the frontend know whether it already has a valid session.
  app.get('/api/session', (req: Request, res: Response) => {
    res.json({ authenticated: isAuthenticated(req) });
  });
}

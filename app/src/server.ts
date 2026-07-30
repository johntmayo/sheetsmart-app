import fs from 'fs';
import path from 'path';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';

import { config, warnings } from './config';
import * as db from './db';
import { requireAuth } from './auth';
import type { Deps } from './types';

import registerAuthRoutes from './routes/auth.routes';
import registerConnectionRoutes from './routes/connections.routes';
import registerWorkflowRoutes from './routes/workflows.routes';
import registerSettingsRoutes from './routes/settings.routes';
import registerStatusRoutes from './routes/status.routes';
import registerRunRoutes from './routes/runs.routes';
import registerAuditRoutes from './routes/audit.routes';
import registerPreviewRoutes from './routes/preview.routes';
import registerDictionaryRoutes from './routes/dictionary.routes';
import registerZoneRoutes from './routes/zones.routes';

export function createApp(): Express {
  db.init();

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  const deps: Deps = { db, config };

  // Public routes (login) — must be registered before the auth gate.
  registerAuthRoutes(app, deps);

  // Everything under /api (except the public auth routes above) requires auth.
  const api = express.Router();
  api.use(requireAuth);
  registerStatusRoutes(api, deps);
  registerConnectionRoutes(api, deps);
  registerWorkflowRoutes(api, deps);
  registerSettingsRoutes(api, deps);
  registerRunRoutes(api, deps);
  registerAuditRoutes(api, deps);
  registerPreviewRoutes(api, deps);
  registerDictionaryRoutes(api, deps);
  registerZoneRoutes(api, deps);
  app.use('/api', api);

  // Static frontend. Prefer the built React app (app/web/dist); fall back to the
  // legacy vanilla public/ folder if the build hasn't been produced yet (e.g. a
  // fresh checkout before `npm run build`). One service serves API + UI.
  const webDist = path.join(config.rootDir, 'web', 'dist');
  const frontendDir = fs.existsSync(path.join(webDist, 'index.html'))
    ? webDist
    : path.join(config.rootDir, 'public');
  app.use(express.static(frontendDir));

  // SPA fallback: serve the app shell for any non-API GET so client-side routes
  // (e.g. /sources, /dictionary) work on a hard refresh.
  app.get(/^(?!\/api).*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });

  // JSON error handler.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Request error:', err);
    res.status(err?.status || 500).json({ error: err?.message || 'Internal error' });
  });

  return app;
}

export function start(): ReturnType<Express['listen']> {
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`\nSheetSmart is running:  http://localhost:${config.port}\n`);
    for (const w of warnings()) {
      console.warn('  [config] ' + w);
    }
  });
  return server;
}

if (require.main === module) {
  start();
}

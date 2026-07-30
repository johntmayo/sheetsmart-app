import type { Router, Request, Response } from 'express';
import * as google from '../google';
import type { Deps } from '../types';
import { findColumn } from '../lib/columns';
import { reconcileZones, type Grid, type ZoneReconcileConfig } from '../lib/zoneEngine';
import {
  fetchZoneFeatures,
  isMapboxConfigured,
  DEFAULT_MAPBOX_USERNAME,
  DEFAULT_MAPBOX_DATASET_ID,
  type ZoneSourceConfig,
} from '../mapbox';

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
}

const LAST_ZONE_KEY = 'last_zone_report';
const ZONE_SOURCE_KEY = 'zone_source_config';

// The canonical master fields Workflow A reads/derives. Resolved to each sheet's
// real header through the Field Dictionary aliases, mirroring previewEngine so
// captain/master drift is handled and every match is explainable.
const CANONICAL_FIELDS = [
  'Latitude',
  'Longitude',
  'ZoneName',
  'NC Name',
  'NC Phone',
  'NC Email',
  'resident_id',
  'Resident Name',
] as const;

export default function registerZoneRoutes(api: Router, { db }: Deps): void {
  // Resolve the stored (or default) Mapbox zone source. Non-secret; the token
  // lives in env, never here.
  function getZoneSource(): ZoneSourceConfig {
    const raw = db.getSetting(ZONE_SOURCE_KEY, '');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<ZoneSourceConfig>;
        return {
          username: (parsed.username || DEFAULT_MAPBOX_USERNAME).trim(),
          datasetId: (parsed.datasetId || DEFAULT_MAPBOX_DATASET_ID).trim(),
        };
      } catch {
        /* fall through to defaults */
      }
    }
    return { username: DEFAULT_MAPBOX_USERNAME, datasetId: DEFAULT_MAPBOX_DATASET_ID };
  }

  // Build the header-resolution config from the Field Dictionary + the master's
  // real header row.
  function resolveConfig(masterHeaders: string[]): ZoneReconcileConfig {
    const resolve = (canonical: string): string | null => {
      const field = db.get<DictFieldRow>('SELECT id, canonical_name FROM dictionary_fields WHERE canonical_name = ?', [
        canonical,
      ]);
      const aliases = field
        ? db
            .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id = ?', [field.id])
            .map((r) => r.alias)
        : [];
      return findColumn(masterHeaders, [canonical, ...aliases]);
    };
    return {
      latHeader: resolve('Latitude'),
      lonHeader: resolve('Longitude'),
      zoneHeader: resolve('ZoneName'),
      ncNameHeader: resolve('NC Name'),
      ncPhoneHeader: resolve('NC Phone'),
      ncEmailHeader: resolve('NC Email'),
      identityHeader: resolve('resident_id'),
      nameHeader: resolve('Resident Name'),
    };
  }

  // Current zone-source + configuration status (for the UI to show what's set).
  api.get('/zones/source', (_req: Request, res: Response) => {
    const source = getZoneSource();
    res.json({
      username: source.username,
      datasetId: source.datasetId,
      tokenConfigured: isMapboxConfigured(),
      usingDefaults: !db.getSetting(ZONE_SOURCE_KEY, ''),
    });
  });

  // Save the (non-secret) Mapbox username + dataset id. The token stays in env.
  api.post('/zones/source', (req: Request, res: Response) => {
    const username = String(req.body?.username || '').trim();
    const datasetId = String(req.body?.datasetId || '').trim();
    if (!username || !datasetId) {
      return res.status(400).json({ error: 'username and datasetId are required.' });
    }
    db.setSetting(ZONE_SOURCE_KEY, JSON.stringify({ username, datasetId }));
    res.json({ username, datasetId, tokenConfigured: isMapboxConfigured() });
  });

  // The read-only Zone Health check (Workflow A, ZONE_PIPELINE_SPEC.md §3).
  // Reads the master, fetches the Mapbox polygons, and reports what a zone
  // refresh WOULD change — categorized (fill / change zone / unassigned /
  // missing coords / contact updates). Writes NOTHING to any sheet.
  api.post('/zones/check', async (_req: Request, res: Response) => {
    try {
      if (!google.isConfigured()) {
        return res.status(400).json({
          error:
            'Google is not configured yet. Add GOOGLE_SERVICE_ACCOUNT_JSON_B64 to your .env (README Section A), then restart.',
        });
      }
      if (!isMapboxConfigured()) {
        return res.status(400).json({
          error:
            'Mapbox is not configured yet. Add MAPBOX_TOKEN (a token with the datasets:read scope) to your .env, then restart.',
        });
      }

      const master = db.get<ConnectionRow>("SELECT * FROM connections WHERE type = 'master' ORDER BY id LIMIT 1");
      if (!master) {
        return res.status(400).json({ error: 'No master connection is configured yet (Sources → add a master).' });
      }

      const runInsert = db.run(
        `INSERT INTO runs (workflow_name, type, mode, status, started_at)
         VALUES (?, 'zone_assign', 'dry', 'running', datetime('now'))`,
        ['Zone Health check']
      );
      const runId = Number(runInsert.lastInsertRowid);

      try {
        const range = master.source_tab ? google.a1Range(master.source_tab, 'A:ZZ') : 'A:ZZ';
        const masterGrid = (await google.readValues(master.google_id, range)) as Grid;
        const headers = (masterGrid[0] || []).map((h) => String(h == null ? '' : h).trim());
        const cfg = resolveConfig(headers);

        const source = getZoneSource();
        const features = await fetchZoneFeatures(source);

        const report = reconcileZones(masterGrid, features, cfg);

        db.setSetting(LAST_ZONE_KEY, JSON.stringify({ runId, source, report }));
        db.run(`UPDATE runs SET status = 'succeeded', finished_at = datetime('now'), summary_json = ? WHERE id = ?`, [
          JSON.stringify(report.summary),
          runId,
        ]);

        return res.json({ runId, source, report });
      } catch (e) {
        db.run(`UPDATE runs SET status = 'failed', finished_at = datetime('now') WHERE id = ?`, [runId]);
        throw e;
      }
    } catch (e) {
      res.status(502).json({ error: friendlyError(e) });
    }
  });

  // The last computed zone report, so Health shows it at a glance without a
  // re-scan on every visit.
  api.get('/zones/latest', (_req: Request, res: Response) => {
    const raw = db.getSetting(LAST_ZONE_KEY, '');
    if (!raw) return res.json({ report: null, runId: null, source: null });
    try {
      const parsed = JSON.parse(raw) as { runId: number; source: unknown; report: unknown };
      return res.json({ report: parsed.report, runId: parsed.runId, source: parsed.source });
    } catch {
      return res.json({ report: null, runId: null, source: null });
    }
  });
}

function friendlyError(e: unknown): string {
  const msg = String((e as Error)?.message || e);
  if (/permission|not have access|forbidden|403/i.test(msg)) {
    return (
      'Google returned a permission error. Make sure the master sheet is shared with the service account as Editor. Details: ' +
      msg
    );
  }
  if (/not found|404/i.test(msg) && /spreadsheet|sheet/i.test(msg)) {
    return 'Google could not find that spreadsheet ID. Double-check the master connection. Details: ' + msg;
  }
  return msg;
}

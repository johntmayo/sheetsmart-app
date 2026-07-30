// Mapbox zone-source client (read-only). Fetches the GeoJSON FeatureCollection
// of ~120 zone polygons that Workflow A joins against (ZONE_PIPELINE_SPEC.md
// §2.1/§5.2). This is the ONLY external, non-Google dependency; it is a plain
// authenticated HTTPS GET, so it works server-side unchanged from the reference
// extension. The token is secret (config.mapboxToken, from env); the username +
// dataset id are non-secret and passed in from app_settings.

import { config } from './config';
import type { ZoneFeatureCollection } from './lib/zoneEngine';

// Sensible defaults from the reference tool's config, so the app works out of
// the box against the real Altagether zone dataset (these are NOT secrets).
export const DEFAULT_MAPBOX_USERNAME = 'altagether';
export const DEFAULT_MAPBOX_DATASET_ID = 'cm64fisju135z1qqmifs0zty5';

export interface ZoneSourceConfig {
  username: string;
  datasetId: string;
}

export function isMapboxConfigured(): boolean {
  return Boolean(config.mapboxToken);
}

// Small retry-with-backoff so a transient Mapbox hiccup doesn't fail a check.
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 600): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i >= attempts - 1) break;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i + Math.floor(Math.random() * 200)));
    }
  }
  throw lastErr;
}

// Fetch the full zone FeatureCollection. Throws a plain-language error when the
// token is missing or Mapbox rejects the request.
export async function fetchZoneFeatures(source: ZoneSourceConfig): Promise<ZoneFeatureCollection> {
  if (!isMapboxConfigured()) {
    throw new Error(
      'Mapbox is not configured. Add MAPBOX_TOKEN (a token with the datasets:read scope) to your .env, then restart.'
    );
  }
  const username = (source.username || '').trim();
  const datasetId = (source.datasetId || '').trim();
  if (!username || !datasetId) {
    throw new Error('Zone source is incomplete: set the Mapbox username and dataset id under Zone Health.');
  }

  const url =
    `https://api.mapbox.com/datasets/v1/${encodeURIComponent(username)}/${encodeURIComponent(datasetId)}/features` +
    `?access_token=${encodeURIComponent(config.mapboxToken)}`;

  return withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Mapbox rejected the token (HTTP ${res.status}). Confirm MAPBOX_TOKEN has the "datasets:read" scope and can read this dataset.`
        );
      }
      if (res.status === 404) {
        throw new Error(
          `Mapbox could not find that dataset (HTTP 404). Check the username "${username}" and dataset id "${datasetId}".`
        );
      }
      throw new Error(`Mapbox request failed (HTTP ${res.status}). ${body.slice(0, 200)}`);
    }
    return (await res.json()) as ZoneFeatureCollection;
  });
}

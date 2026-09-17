import type { Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';
import { ADDRESS_PLACEHOLDER_COLUMN } from '../lib/addressPlaceholder';
import type { Deps } from '../types';
import * as google from '../google';
import * as jobs from '../jobs';
import {
  canonicalizeHeaders,
  detectSheetZoneWithName,
  findColumn,
  type DictionaryAliasSpec,
} from '../lib/columns';
import {
  planAddressIntake,
  type AddressHeaders,
  type AddressPlaceholder,
  type AddressRow,
} from '../lib/addressIntakeEngine';
import {
  buildSpatialIndex,
  findContainingFeatures,
  ZONE_OUTPUT_FIELDS,
  type ZoneFeature,
} from '../lib/zoneEngine';
import {
  DEFAULT_MAPBOX_DATASET_ID,
  DEFAULT_MAPBOX_USERNAME,
  fetchZoneFeatures,
  isMapboxConfigured,
} from '../mapbox';
import { ADDRESS_INTAKE_TASK } from '../executionTasks';
import { parseDeletedRecords } from '../lib/operationsContract';

const ADDRESS_HEADERS: Partial<AddressHeaders> = {
  addressId: 'address_id',
  apn: 'APN',
  house: '_SitusHouseNo',
  direction: '_SitusDirection',
  street: '_SitusStreet',
  unit: '_SitusUnit',
  city: 'City',
  state: 'State',
  zip: 'Zip',
  latitude: 'Latitude',
  longitude: 'Longitude',
};

export interface ZonedAddressPlaceholder extends AddressPlaceholder {
  resident_id: string;
  zoneFields: Record<string, string>;
  captainSpreadsheetId: string;
  captainSpreadsheetName: string;
}

export default function registerAddressIntakeRoutes(api: Router, { db }: Deps): void {
  api.get('/address-intake/sources', (_req: Request, res: Response) => {
    res.json({
      sources: db.all(
        `SELECT id, name, google_id, source_tab, notes FROM connections
         WHERE type='external' ORDER BY name, id`
      ),
    });
  });

  api.post('/address-intake/preview', async (req: Request, res: Response) => {
    if (!google.isConfigured()) return res.status(400).json({ error: 'Google is not configured.' });
    const sourceId = Number(req.body?.sourceConnectionId);
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return res.status(400).json({ error: 'Choose the spreadsheet containing missing addresses.' });
    }
    const source = db.get<{
      id: number;
      name: string;
      google_id: string;
      source_tab: string;
    }>("SELECT id, name, google_id, source_tab FROM connections WHERE id=? AND type='external'", [sourceId]);
    const master = db.get<{ name: string; google_id: string; source_tab: string }>(
      "SELECT name, google_id, source_tab FROM connections WHERE type='master' ORDER BY id LIMIT 1"
    );
    const folder = db.get<{ google_id: string }>(
      "SELECT google_id FROM connections WHERE type='captain_folder' ORDER BY id LIMIT 1"
    );
    if (!source || !master || !folder) {
      return res.status(400).json({ error: 'Connect the source, master, and captain folder first.' });
    }

    const insert = db.run(
      `INSERT INTO runs (workflow_name, type, mode, status, started_at)
       VALUES ('Review missing-address intake', 'preview_address_intake', 'dry', 'running', datetime('now'))`
    );
    const runId = Number(insert.lastInsertRowid);
    try {
      const dictionary = loadDictionary(db);
      const mapboxConfigured = isMapboxConfigured();
      const [sourceGrid, masterGrid, captainData, zoneLoad] = await Promise.all([
        readCanonicalGrid(source.google_id, source.source_tab, dictionary),
        readCanonicalGrid(master.google_id, master.source_tab, dictionary),
        readCaptainAddresses(folder.google_id, dictionary),
        mapboxConfigured
          ? fetchZoneFeatures(loadZoneSource(db))
              .then((features) => ({ available: true, features, warning: '' }))
              .catch(() => ({
                available: false,
                features: { type: 'FeatureCollection' as const, features: [] },
                warning: 'Mapbox could not be read. New addresses can still be added to the master unzoned.',
              }))
          : Promise.resolve({
              available: false,
              features: { type: 'FeatureCollection' as const, features: [] },
              warning: 'Mapbox is not configured. New addresses can still be added to the master unzoned.',
            }),
      ]);
      const { available: mapboxAvailable, features, warning: zoneReadWarning } = zoneLoad;
      for (const required of ['Resident Name', ADDRESS_PLACEHOLDER_COLUMN]) {
        if (!(masterGrid[0] || []).includes(required)) {
          throw new Error(`The master spreadsheet is missing required column "${required}".`);
        }
      }
      const deletedAddresses = await readActiveDeletedAddressRows(db);
      const plan = planAddressIntake(
        gridObjects(sourceGrid),
        [...gridObjects(masterGrid), ...deletedAddresses.rows],
        captainData.rows,
        {
          externalHeaders: addressHeadersFor(sourceGrid[0] || []),
          masterHeaders: addressHeadersFor(masterGrid[0] || []),
          captainHeaders: ADDRESS_HEADERS,
          requiredFields: ['house', 'street', 'city', 'state', 'zip'],
          maxBatchSize: 250,
          placeholderIdPrefix: 'addr_',
        }
      );
      const spatial = buildSpatialIndex(features);
      const historyBlocked: Array<{ externalRow: number; addressId: string; reason: string }> = [];
      for (const match of plan.matches.filter((item) => deletedAddresses.addressIds.has(item.addressId))) {
        historyBlocked.push({
          externalRow: match.externalRow,
          addressId: match.addressId,
          reason: 'This address was deliberately deleted and remains archived. Restore it instead of importing it.',
        });
      }
      const zoned: ZonedAddressPlaceholder[] = [];
      const zoneWarnings: Array<{ externalRow: number; addressId: string; reason: string }> = [];
      const publishWarnings: Array<{ externalRow: number; addressId: string; reason: string }> = [];
      for (const placeholder of plan.placeholders) {
        let assignedZoneFields: Record<string, string> = {};
        let captainSpreadsheetId = '';
        let captainSpreadsheetName = '';
        if (placeholder.latitude === '' || placeholder.longitude === '') {
          zoneWarnings.push({
            externalRow: placeholder.provenance_row,
            addressId: placeholder.address_id,
            reason: 'Coordinates are missing, so this address will be added to the master without a zone.',
          });
        } else if (!mapboxAvailable) {
          zoneWarnings.push({
            externalRow: placeholder.provenance_row,
            addressId: placeholder.address_id,
            reason: 'Mapbox is unavailable, so this address will be added to the master without a zone.',
          });
        } else {
        const matches = findContainingFeatures(spatial, [
          Number(placeholder.longitude),
          Number(placeholder.latitude),
        ]);
          if (matches.length === 0) {
            zoneWarnings.push({
              externalRow: placeholder.provenance_row,
              addressId: placeholder.address_id,
              reason: 'This address is outside every current Mapbox zone and will be added to the master unzoned.',
            });
          } else if (matches.length > 1) {
            zoneWarnings.push({
              externalRow: placeholder.provenance_row,
              addressId: placeholder.address_id,
              reason: 'This address is inside overlapping Mapbox zones and will be added to the master unzoned.',
            });
          } else {
            const zoneName = String(matches[0].properties?.ZoneName ?? '').trim();
            if (!zoneName) {
              zoneWarnings.push({
                externalRow: placeholder.provenance_row,
                addressId: placeholder.address_id,
                reason: 'The containing Mapbox shape has no zone name, so this address will be added unzoned.',
              });
            } else {
              assignedZoneFields = zoneFields(matches[0]);
              const captainTargets = captainData.zoneSheets[zoneName] || [];
              if (captainTargets.length === 1 && captainTargets[0].supportsAddressPlaceholders) {
                captainSpreadsheetId = captainTargets[0].spreadsheetId;
                captainSpreadsheetName = captainTargets[0].spreadsheetName;
              } else {
                publishWarnings.push({
                  externalRow: placeholder.provenance_row,
                  addressId: placeholder.address_id,
                  reason:
                    captainTargets.length === 0
                      ? `${zoneName} has no captain sheet yet. This address will enter the master now and can be published after that sheet is created.`
                      : captainTargets.length === 1
                        ? `${captainTargets[0].spreadsheetName} is missing Resident Name or Address Placeholder. This address will enter the master now but will not be published until that column is added.`
                      : `${zoneName} maps to more than one captain sheet. This address will enter the master now but will not be published until that is corrected.`,
                });
              }
            }
          }
        }
        zoned.push({
          ...placeholder,
          resident_id: randomUUID(),
          zoneFields: assignedZoneFields,
          captainSpreadsheetId,
          captainSpreadsheetName,
        });
      }
      const summary = {
        kind: 'address_intake_preview',
        sourceConnectionId: source.id,
        sourceName: source.name,
        masterName: master.name,
        generatedAt: new Date().toISOString(),
        fingerprint: plan.fingerprint,
        matches: plan.matches.filter((item) => !deletedAddresses.addressIds.has(item.addressId)),
        review: plan.review,
        blocked: plan.blocked,
        historyBlocked,
        zoneWarnings,
        publishWarnings,
        zoneReadWarning,
        placeholders: zoned,
        errors: plan.errors,
        impact: {
          sourceRows: Math.max(0, sourceGrid.length - 1),
          alreadyKnown: plan.matches.filter((item) => !deletedAddresses.addressIds.has(item.addressId)).length,
          needsReview: plan.review.length,
          blocked: plan.blocked.length + historyBlocked.length,
          readyToAdd: zoned.length,
          readyZoned: zoned.filter((item) => Boolean(item.zoneFields.ZoneName)).length,
          readyUnzoned: zoned.filter((item) => !item.zoneFields.ZoneName).length,
          readyForCaptain: zoned.filter(
            (item) => Boolean(item.captainSpreadsheetId)
          ).length,
          zonedWithoutCaptainSheet: publishWarnings.length,
          sourceDuplicatesCombined: plan.coalescedSourceRows,
        },
      };
      db.run(
        "UPDATE runs SET status='succeeded', finished_at=datetime('now'), summary_json=? WHERE id=?",
        [JSON.stringify(summary), runId]
      );
      res.json({ runId, ...summary, canApply: zoned.length > 0 && plan.errors.length === 0 });
    } catch (error) {
      db.run("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id=?", [runId]);
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  api.post('/address-intake/apply', (req: Request, res: Response) => {
    if (req.body?.confirmed !== true) {
      return res.status(400).json({ error: 'Confirm before adding addresses to the master.' });
    }
    const previewRunId = Number(req.body?.previewRunId);
    const preview = db.get<{ type: string; mode: string; status: string; summary_json: string }>(
      'SELECT type, mode, status, summary_json FROM runs WHERE id=?',
      [previewRunId]
    );
    if (
      !preview ||
      preview.type !== 'preview_address_intake' ||
      preview.mode !== 'dry' ||
      preview.status !== 'succeeded'
    ) {
      return res.status(400).json({ error: 'That address preview is no longer available.' });
    }
    const summary = safeJson(preview.summary_json);
    if (summary.kind !== 'address_intake_preview' || !Array.isArray(summary.placeholders)) {
      return res.status(400).json({ error: 'That preview does not contain a valid address plan.' });
    }
    const approved = Array.isArray(req.body?.addressIds)
      ? (req.body.addressIds as unknown[]).map(String)
      : [];
    if (approved.length < 1 || approved.length > 250) {
      return res.status(400).json({ error: 'Choose between 1 and 250 addresses for one import run.' });
    }
    const wanted = new Set(approved);
    const rows = (summary.placeholders as ZonedAddressPlaceholder[]).filter((row) => wanted.has(row.address_id));
    if (rows.length !== wanted.size) {
      return res.status(400).json({ error: 'One or more selected addresses were not in this preview.' });
    }
    try {
      const queued = jobs.enqueueFromPreview(previewRunId, 'preview_address_intake', {
        workflowName: 'Add missing addresses',
        type: ADDRESS_INTAKE_TASK,
        mode: 'live',
        params: {
          previewRunId,
          sourceConnectionId: Number(summary.sourceConnectionId),
          expectedFingerprint: String(summary.fingerprint || ''),
          addresses: rows,
        },
      });
      res.status(202).json({ ...queued, status: 'queued' });
    } catch (error) {
      if (error instanceof jobs.PreviewAlreadyClaimedError) return res.status(409).json({ error: error.message });
      if (error instanceof jobs.PreviewUnavailableError) return res.status(400).json({ error: error.message });
      throw error;
    }
  });
}

async function readCanonicalGrid(
  spreadsheetId: string,
  configuredTab: string,
  dictionary: DictionaryAliasSpec[]
): Promise<any[][]> {
  let tab = configuredTab;
  if (!tab) tab = (await google.getSpreadsheetMeta(spreadsheetId)).tabs[0] || '';
  if (!tab) throw new Error('A connected spreadsheet has no readable tab.');
  const grid = await google.readValues(spreadsheetId, google.a1Range(tab, 'A:ZZ'));
  const result = canonicalizeHeaders(grid[0] || [], dictionary);
  if (result.errors.length > 0) throw new Error(result.errors.join(' '));
  return [result.headers, ...grid.slice(1)];
}

async function readCaptainAddresses(
  folderId: string,
  dictionary: DictionaryAliasSpec[]
): Promise<{
  rows: AddressRow[];
  zoneSheets: Record<
    string,
    Array<{ spreadsheetId: string; spreadsheetName: string; supportsAddressPlaceholders: boolean }>
  >;
}> {
  const files = await google.listSpreadsheetsInFolder(folderId);
  files.sort((left, right) => left.id.localeCompare(right.id));
  const rowsByFile = new Map<string, AddressRow[]>();
  const zoneByFile = new Map<string, string>();
  const placeholderSupportByFile = new Map<string, boolean>();
  await mapLimit(files, 10, async (file) => {
    const grid = await google.readValues(file.id, 'A:ZZ');
    const canonical = canonicalizeHeaders(grid[0] || [], dictionary);
    if (canonical.errors.length > 0) throw new Error(`${file.name}: ${canonical.errors.join(' ')}`);
    rowsByFile.set(file.id, gridObjects([canonical.headers, ...grid.slice(1)]));
    placeholderSupportByFile.set(
      file.id,
      canonical.headers.includes('Resident Name') && canonical.headers.includes(ADDRESS_PLACEHOLDER_COLUMN)
    );
    zoneByFile.set(
      file.id,
      detectSheetZoneWithName(
        canonical.headers.map((value) => String(value ?? '').trim()),
        grid.slice(1),
        file.name
      )
    );
  });
  const zoneSheets: Record<
    string,
    Array<{ spreadsheetId: string; spreadsheetName: string; supportsAddressPlaceholders: boolean }>
  > = {};
  for (const file of files) {
    const zone = zoneByFile.get(file.id) || '';
    if (!zone) continue;
    zoneSheets[zone] = [
      ...(zoneSheets[zone] || []),
      {
        spreadsheetId: file.id,
        spreadsheetName: file.name,
        supportsAddressPlaceholders: placeholderSupportByFile.get(file.id) === true,
      },
    ];
  }
  return {
    rows: files.flatMap((file) => rowsByFile.get(file.id) || []),
    zoneSheets,
  };
}

function gridObjects(grid: any[][]): AddressRow[] {
  const headers = (grid[0] || []).map((value) => String(value ?? '').trim());
  return grid.slice(1).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']))
  );
}

function addressHeadersFor(headers: unknown[]): Partial<AddressHeaders> {
  const values = headers.map((value) => String(value ?? '').trim());
  const resolve = (candidates: string[]) => findColumn(values, candidates) || candidates[0];
  return {
    addressId: resolve(['address_id', 'Address ID']),
    apn: resolve(['APN', 'Parcel Number']),
    house: resolve(['_SitusHouseNo', 'Situs House Number', 'House Number', 'House']),
    direction: resolve(['_SitusDirection', 'Situs Direction', 'Direction']),
    street: resolve(['_SitusStreet', 'Situs Street', 'Street']),
    unit: resolve(['_SitusUnit', 'Situs Unit', 'Unit']),
    city: resolve(['City', 'Situs City']),
    state: resolve(['State', 'Situs State']),
    zip: resolve(['Zip', 'ZIP', 'Zip Code', 'Postal Code']),
    latitude: resolve(['Latitude', 'Lat']),
    longitude: resolve(['Longitude', 'Lon', 'Lng']),
  };
}

function loadDictionary(db: Deps['db']): DictionaryAliasSpec[] {
  return db
    .all<{ id: number; canonical_name: string }>(
      'SELECT id, canonical_name FROM dictionary_fields ORDER BY sort_order, id'
    )
    .map((field) => ({
      canonicalName: field.canonical_name,
      aliases: db
        .all<{ alias: string }>('SELECT alias FROM dictionary_aliases WHERE field_id=? ORDER BY alias', [field.id])
        .map((row) => row.alias),
    }));
}

function zoneFields(feature: ZoneFeature): Record<string, string> {
  const properties = feature.properties || {};
  return Object.fromEntries(
    ZONE_OUTPUT_FIELDS.map((field) => [field.canonical, String(properties[field.property] ?? '').trim()])
  );
}

function loadZoneSource(db: Deps['db']): { username: string; datasetId: string } {
  try {
    const parsed = JSON.parse(db.getSetting('zone_source_config', '{}')) as {
      username?: string;
      datasetId?: string;
    };
    return {
      username: (parsed.username || DEFAULT_MAPBOX_USERNAME).trim(),
      datasetId: (parsed.datasetId || DEFAULT_MAPBOX_DATASET_ID).trim(),
    };
  } catch {
    return { username: DEFAULT_MAPBOX_USERNAME, datasetId: DEFAULT_MAPBOX_DATASET_ID };
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        await fn(items[index]);
      }
    })
  );
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function readActiveDeletedAddressRows(
  db: Deps['db']
): Promise<{ rows: AddressRow[]; addressIds: Set<string> }> {
  const addressIds = new Set(
    db.all<{ address_id: string }>('SELECT address_id FROM address_tombstones WHERE active=1').map((row) => row.address_id)
  );
  if (addressIds.size === 0) return { rows: [], addressIds };
  let config: { spreadsheetId?: string; deletedRecordsTab?: string } = {};
  try {
    config = JSON.parse(db.getSetting('operations_workbook_v1', '{}'));
  } catch {
    /* handled below */
  }
  if (!config.spreadsheetId) {
    throw new Error('Deleted-address evidence is active, but the private operations workbook is not configured.');
  }
  const grid = await google.readValues(
    config.spreadsheetId,
    google.a1Range(config.deletedRecordsTab || 'Deleted Records', 'A:M')
  );
  const parsed = parseDeletedRecords(grid);
  if (parsed.errors.length > 0) {
    throw new Error('Fix the private Deleted Records archive before importing addresses.');
  }
  const archivedAddressIds = new Set(parsed.records.map((record) => record.addressId));
  const missingEvidence = [...addressIds].filter((addressId) => !archivedAddressIds.has(addressId));
  if (missingEvidence.length > 0) {
    throw new Error(
      `Address intake is paused because ${missingEvidence.length} deleted address archive entr${
        missingEvidence.length === 1 ? 'y is' : 'ies are'
      } missing. Restore the private archive before scanning.`
    );
  }
  const rows = parsed.records
    .filter((record) => addressIds.has(record.addressId))
    .map((record) => record.fullRow as AddressRow);
  return { rows, addressIds };
}

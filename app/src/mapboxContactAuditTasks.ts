import * as db from './db';
import * as google from './google';
import { registerTask, type JobContext } from './jobs';
import { canonicalizeHeaders, fingerprintDictionaryAliases, type DictionaryAliasSpec } from './lib/columns';
import {
  buildMasterCoordLookup,
  fingerprintMapboxRoster,
  fingerprintSelectedContactAudit,
  planContactAuditSheet,
  type ContactAuditSheetPlan,
} from './lib/mapboxContactAuditEngine';
import { ensureHeaderColumns, planGuardedCellWrites } from './lib/liveWriteEngine';
import { type Grid } from './lib/mergeEngine';
import { filterGridByTombstones, loadActiveTombstones } from './lib/tombstones';
import {
  DEFAULT_MAPBOX_DATASET_ID,
  DEFAULT_MAPBOX_USERNAME,
  fetchZoneFeatures,
  type ZoneSourceConfig,
} from './mapbox';

export const MAPBOX_CONTACT_AUDIT_TASK = 'mapbox_contact_audit';

const MAX_CONTACT_AUDIT_CELLS = 5000;
const ZONE_SOURCE_KEY = 'zone_source_config';

interface ContactAuditParams {
  previewRunId: number;
  masterSpreadsheetId: string;
  masterName: string;
  masterTab: string;
  folderId: string;
  spreadsheetIds: string[];
  expectedFingerprint: string;
  dictionaryFingerprint: string;
  mapboxFingerprint: string;
  sheets: ContactAuditSheetPlan[];
}

export function registerMapboxContactAuditTasks(): void {
  registerTask(MAPBOX_CONTACT_AUDIT_TASK, applyMapboxContactAudit);
}

async function applyMapboxContactAudit(ctx: JobContext): Promise<unknown> {
  if (ctx.mode !== 'live') throw new Error('Mapbox contact audit tasks require live mode.');
  const params = parseParams(ctx.params);
  if (params.spreadsheetIds.length === 0) {
    throw new Error('Choose at least one sheet for this run.');
  }
  const previewSheets = params.sheets;
  if (fingerprintSelectedContactAudit(previewSheets, params.spreadsheetIds) !== params.expectedFingerprint) {
    throw new Error('The selected sheets no longer match the approved preview. Run a fresh scan.');
  }

  ctx.reportProgress({ stage: 'reading', message: 'Rechecking Mapbox and the selected sheets.' });
  const features = await fetchZoneFeatures(loadZoneSource());
  if (fingerprintMapboxRoster(features) !== params.mapboxFingerprint) {
    throw new Error('Mapbox captain contacts changed after the preview. Nothing was written. Run a fresh scan.');
  }
  const dictionary = loadDictionaryAliases();
  if (fingerprintDictionaryAliases(dictionary) !== params.dictionaryFingerprint) {
    throw new Error('The Fields settings changed after preview. Nothing was written. Run a fresh scan.');
  }

  const tombstones = loadActiveTombstones(db);
  const masterRaw = await readGrid(params.masterSpreadsheetId, params.masterTab);
  const masterHeaders = canonicalizeHeaders(masterRaw[0] || [], dictionary);
  if (masterHeaders.errors.length > 0) {
    throw new Error(`Master columns are ambiguous: ${masterHeaders.errors.join(' ')}`);
  }
  const masterGrid = filterGridByTombstones(
    [masterHeaders.headers, ...masterRaw.slice(1)] as Grid,
    tombstones
  );
  const masterCoords = buildMasterCoordLookup(masterGrid);
  const previewById = new Map(previewSheets.map((sheet) => [sheet.spreadsheetId, sheet]));

  let totalCells = 0;
  const sheetsUpdated: string[] = [];

  for (const spreadsheetId of params.spreadsheetIds) {
    const previewSheet = previewById.get(spreadsheetId);
    if (!previewSheet) continue;
    if (
      previewSheet.fills + previewSheet.overwrites === 0 &&
      previewSheet.columnsToAdd.length === 0
    ) {
      continue;
    }

    const meta = await google.getSpreadsheetMeta(spreadsheetId);
    const tabName =
      previewSheet.kind === 'master'
        ? params.masterTab || previewSheet.tabName || meta.tabs[0] || ''
        : previewSheet.tabName || meta.tabs[0] || '';
    if (!tabName) throw new Error(`${previewSheet.spreadsheetName} has no readable tab.`);

    const raw = await readGrid(spreadsheetId, tabName);
    const headerResult = canonicalizeHeaders(raw[0] || [], dictionary);
    if (headerResult.errors.length > 0) {
      throw new Error(`${previewSheet.spreadsheetName}: ${headerResult.errors.join(' ')}`);
    }
    const grid = filterGridByTombstones([headerResult.headers, ...raw.slice(1)] as Grid, tombstones) as Grid;
    const { plan, changes } = planContactAuditSheet(
      {
        spreadsheetId,
        spreadsheetName: previewSheet.spreadsheetName,
        tabName,
        url: previewSheet.url,
        kind: previewSheet.kind,
        grid,
      },
      features,
      masterCoords
    );
    if (plan.errors.length > 0) {
      throw new Error(`${previewSheet.spreadsheetName}: ${plan.errors.join('; ')}`);
    }
    if (plan.sheetFingerprint !== previewSheet.sheetFingerprint) {
      throw new Error(`${previewSheet.spreadsheetName} changed after preview. Nothing was written. Run a fresh scan.`);
    }

    const { headers, added, addedIndexes } = ensureHeaderColumns(grid, plan.columnsToAdd);
    if (added.length > 0) {
      const sheet = (await google.getSheetProperties(spreadsheetId)).find((candidate) => candidate.title === tabName);
      if (!sheet) throw new Error(`Tab "${tabName}" no longer exists on ${previewSheet.spreadsheetName}.`);
      const columnsNeeded = headers.length - sheet.columnCount;
      if (columnsNeeded > 0) {
        await google.batchUpdateSpreadsheet(spreadsheetId, [
          {
            appendDimension: {
              sheetId: sheet.sheetId,
              dimension: 'COLUMNS',
              length: columnsNeeded,
            },
          },
        ]);
      }
      const headerUpdates = added.map((column, index) => ({
        range: google.a1Range(tabName, `${google.columnLetter(addedIndexes[index] - 1)}1`),
        values: [[column]],
      }));
      const headerSnapshot = db.transaction(() => {
        for (let index = 0; index < added.length; index++) {
          db.run(
            `INSERT INTO run_snapshots
               (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
                range_a1, before_json, after_json, metadata_json)
             VALUES (?, ?, ?, ?, 'cell_update', '', ?, '""', ?, ?)`,
            [
              ctx.runId,
              spreadsheetId,
              previewSheet.spreadsheetName,
              tabName,
              headerUpdates[index].range,
              JSON.stringify(added[index]),
              JSON.stringify({
                kind: 'mapbox_contact_audit_header',
                column: added[index],
                previewRunId: params.previewRunId,
              }),
            ]
          );
        }
      });
      headerSnapshot();
      await google.updateValues(spreadsheetId, headerUpdates);
    }

    const guarded = planGuardedCellWrites(
      grid,
      changes.map((change) => ({
        residentId: change.residentId,
        column: change.column,
        value: change.mapbox,
        policy: change.action === 'overwrite' ? 'overwrite' : 'fill_blank',
      }))
    );
    if (guarded.errors.length > 0) {
      throw new Error(`${previewSheet.spreadsheetName}: ${guarded.errors.join('; ')}`);
    }
    if (guarded.writes.length === 0 && added.length === 0) continue;
    if (totalCells + guarded.writes.length > MAX_CONTACT_AUDIT_CELLS) {
      throw new Error(
        `This run would write more than ${MAX_CONTACT_AUDIT_CELLS.toLocaleString()} cells. Select fewer sheets or run another batch.`
      );
    }

    if (guarded.writes.length > 0) {
      const insertSnapshots = db.transaction(() => {
        for (const write of guarded.writes) {
          const range = google.a1Range(tabName, `${google.columnLetter(write.col - 1)}${write.row}`);
          db.run(
            `INSERT INTO run_snapshots
               (run_id, spreadsheet_id, spreadsheet_name, tab_name, operation, resident_id,
                range_a1, before_json, after_json, metadata_json)
             VALUES (?, ?, ?, ?, 'cell_update', ?, ?, ?, ?, ?)`,
            [
              ctx.runId,
              spreadsheetId,
              previewSheet.spreadsheetName,
              tabName,
              write.residentId,
              range,
              JSON.stringify(write.before ?? ''),
              JSON.stringify(write.after ?? ''),
              JSON.stringify({
                kind: 'mapbox_contact_audit',
                column: write.column,
                previewRunId: params.previewRunId,
              }),
            ]
          );
        }
      });
      insertSnapshots();
      ctx.reportProgress({
        stage: 'writing',
        message: `Updating ${guarded.writes.length.toLocaleString()} Mapbox contact cell(s) on ${previewSheet.spreadsheetName}.`,
      });
      await google.updateValuesChunked(
        spreadsheetId,
        guarded.writes.map((write) => ({
          range: google.a1Range(tabName, `${google.columnLetter(write.col - 1)}${write.row}`),
          values: [[write.after]],
        }))
      );
      totalCells += guarded.writes.length;
      for (const write of guarded.writes) {
        ctx.log({
          spreadsheet: previewSheet.spreadsheetName,
          row: write.row,
          column: write.column,
          resident_id: write.residentId,
          type: write.action === 'overwrite' ? 'overwrite' : 'fill',
          message: `Set ${write.column} from Mapbox for resident ${write.residentId}.`,
        });
      }
    }

    sheetsUpdated.push(previewSheet.spreadsheetName);
  }

  return {
    previewRunId: params.previewRunId,
    cellsWritten: totalCells,
    sheetsUpdated: sheetsUpdated.length,
    sheetNames: sheetsUpdated,
    revertAvailable: totalCells > 0,
    nextStep:
      totalCells > 0
        ? 'Captain contact fields were updated from Mapbox. Zone-name disagreements were left for the boundary-change playbook.'
        : 'Selected sheets already matched Mapbox, or only zone-name mismatches remain.',
  };
}

function parseParams(raw: Record<string, unknown>): ContactAuditParams {
  const previewRunId = Number(raw.previewRunId);
  const masterSpreadsheetId = String(raw.masterSpreadsheetId || '').trim();
  const masterName = String(raw.masterName || 'Master').trim();
  const masterTab = String(raw.masterTab || '').trim();
  const folderId = String(raw.folderId || '').trim();
  const expectedFingerprint = String(raw.expectedFingerprint || '').trim();
  const dictionaryFingerprint = String(raw.dictionaryFingerprint || '').trim();
  const mapboxFingerprint = String(raw.mapboxFingerprint || '').trim();
  const spreadsheetIds = Array.isArray(raw.spreadsheetIds)
    ? (raw.spreadsheetIds as unknown[]).map((value) => String(value).trim()).filter(Boolean)
    : [];
  const sheets = Array.isArray(raw.sheets) ? (raw.sheets as ContactAuditSheetPlan[]) : [];
  if (
    !Number.isInteger(previewRunId) ||
    previewRunId <= 0 ||
    !masterSpreadsheetId ||
    !masterTab ||
    !folderId ||
    !expectedFingerprint ||
    !dictionaryFingerprint ||
    !mapboxFingerprint
  ) {
    throw new Error('The approved Mapbox contact audit plan is incomplete.');
  }
  return {
    previewRunId,
    masterSpreadsheetId,
    masterName,
    masterTab,
    folderId,
    spreadsheetIds,
    expectedFingerprint,
    dictionaryFingerprint,
    mapboxFingerprint,
    sheets,
  };
}

function loadZoneSource(): ZoneSourceConfig {
  const raw = db.getSetting(ZONE_SOURCE_KEY, '');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ZoneSourceConfig>;
      return {
        username: (parsed.username || DEFAULT_MAPBOX_USERNAME).trim(),
        datasetId: (parsed.datasetId || DEFAULT_MAPBOX_DATASET_ID).trim(),
      };
    } catch {
      /* defaults */
    }
  }
  return { username: DEFAULT_MAPBOX_USERNAME, datasetId: DEFAULT_MAPBOX_DATASET_ID };
}

async function readGrid(spreadsheetId: string, tabName: string): Promise<Grid> {
  return (await google.readValues(spreadsheetId, tabName ? google.a1Range(tabName, 'A:ZZ') : 'A:ZZ')) as Grid;
}

function loadDictionaryAliases(): DictionaryAliasSpec[] {
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

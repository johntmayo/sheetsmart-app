// Google integration (handoff Section 4). Authenticates a dedicated service
// account, caches the clients, wraps every call in retry-with-backoff, and
// provides the A1/column helpers used across the app. All Sheets API calls,
// including Phase-C writes, stay behind this module.

import { google, sheets_v4, drive_v3 } from 'googleapis';
import { config } from './config';
import { assertCurrentJobLease } from './jobs';
import {
  LEGACY_ADDRESS_COLUMNS,
  NOTE_TEXT_COLUMNS,
  RETIRED_SALES_COLUMNS,
  type CleanupCell,
  type CleanupDependency,
  type CleanupSheet,
} from './lib/folderCleanupEngine';

// The service-account auth client, derived from googleapis so we don't depend
// on google-auth-library directly.
type GoogleAuthClient = InstanceType<typeof google.auth.GoogleAuth>;

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets', // read + write cells/columns
  'https://www.googleapis.com/auth/drive', // list, create, move, and safely undo app-created zone sheets
];

interface ServiceAccountCredentials {
  client_email?: string;
  private_key?: string;
  [key: string]: unknown;
}

interface GoogleClients {
  auth: GoogleAuthClient;
  sheets: sheets_v4.Sheets;
  drive: drive_v3.Drive;
  clientEmail: string;
}

// A Google spreadsheet as listed from a Drive folder (only the fields we use).
export interface SpreadsheetFile {
  id: string;
  name: string;
  modifiedTime: string;
  webViewLink: string;
}

export interface SpreadsheetMeta {
  id: string;
  title: string;
  tabs: string[];
}

export interface SheetProperties {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
}

let cached: GoogleClients | null = null;

export function isConfigured(): boolean {
  return Boolean(config.googleServiceAccountJsonB64);
}

function loadCredentials(): ServiceAccountCredentials {
  if (!isConfigured()) {
    throw new Error(
      'Google is not connected. Check the Dashboard for setup status.'
    );
  }
  let json: string;
  try {
    json = Buffer.from(config.googleServiceAccountJsonB64, 'base64').toString('utf8');
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not valid base64.');
  }
  let creds: ServiceAccountCredentials;
  try {
    creds = JSON.parse(json) as ServiceAccountCredentials;
  } catch {
    throw new Error('Decoded service-account value is not valid JSON. Re-create the base64 (see README).');
  }
  if (!creds.client_email || !creds.private_key) {
    throw new Error('Service-account JSON is missing client_email or private_key.');
  }
  return creds;
}

export function getClients(): GoogleClients {
  if (cached) return cached;
  const credentials = loadCredentials();
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  cached = {
    auth,
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth }),
    clientEmail: credentials.client_email as string,
  };
  return cached;
}

// Print only the client_email for confirmation, never the private key.
export function getClientEmail(): string | null {
  try {
    return loadCredentials().client_email ?? null;
  } catch {
    return null;
  }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
}

// Retry with exponential backoff + jitter. Callers must use a single attempt
// for mutations that are not safe to repeat after an ambiguous timeout.
export async function withRetry<T>(fn: () => Promise<T>, { attempts = 8, baseDelayMs = 700 }: RetryOptions = {}): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const e = err as { code?: number; response?: { status?: number }; message?: string };
      const code = e.code || (e.response && e.response.status);
      const msg = String(e.message || '').toLowerCase();
      const retryable =
        [429, 500, 503].includes(code as number) ||
        msg.includes('quota') ||
        msg.includes('rate limit') ||
        msg.includes('backend error') ||
        msg.includes('internal error') ||
        msg.includes('unavailable') ||
        msg.includes('timeout') ||
        msg.includes('unable to parse range');
      if (i >= attempts - 1 || !retryable) throw err;
      // Sheets write quotas are per-minute; wait out the window on 429/quota.
      const quotaHit = code === 429 || msg.includes('quota') || msg.includes('rate limit');
      const delay = quotaHit
        ? 65_000 + Math.floor(Math.random() * 5_000)
        : baseDelayMs * 2 ** i + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ---- A1 + column-letter helpers (handoff 4.5) ----

// 0 -> A, 25 -> Z, 26 -> AA
export function columnLetter(index: number): string {
  let letter = '';
  let temp = index;
  while (true) {
    letter = String.fromCharCode(65 + (temp % 26)) + letter;
    temp = Math.floor(temp / 26) - 1;
    if (temp < 0) break;
  }
  return letter;
}

// Quote a tab name for A1 notation, escaping embedded single quotes.
export function quoteTabName(tabName: string): string {
  const name = String(tabName || '');
  return `'${name.replace(/'/g, "''")}'`;
}

export function a1Range(tabName: string, range: string): string {
  return `${quoteTabName(tabName)}!${range}`;
}

// ---- Read helpers (safe, read-only) ----

// Lists all Google Spreadsheets inside a Drive folder, sorted by name.
export async function listSpreadsheetsInFolder(folderId: string): Promise<SpreadsheetFile[]> {
  const { drive } = getClients();
  const files: SpreadsheetFile[] = [];
  let pageToken: string | undefined = undefined;
  do {
    const res: { data: drive_v3.Schema$FileList } = await withRetry(() =>
      drive.files.list({
        q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
        fields: 'nextPageToken, files(id, name, modifiedTime, webViewLink)',
        pageSize: 200,
        orderBy: 'name',
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
    );
    for (const f of res.data.files || []) {
      files.push({
        id: f.id ?? '',
        name: f.name ?? '',
        modifiedTime: f.modifiedTime ?? '',
        webViewLink: f.webViewLink ?? '',
      });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

// Returns spreadsheet metadata including tab names.
export async function getSpreadsheetMeta(spreadsheetId: string): Promise<SpreadsheetMeta> {
  const { sheets } = getClients();
  const res = await withRetry(() =>
    sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'spreadsheetId,properties.title,sheets.properties(title,sheetId,gridProperties)',
    })
  );
  return {
    id: res.data.spreadsheetId ?? '',
    title: res.data.properties?.title ?? '',
    tabs: (res.data.sheets || []).map((s) => s.properties?.title ?? ''),
  };
}

// Numeric sheet IDs are required for structural batchUpdate requests.
export async function getSheetProperties(spreadsheetId: string): Promise<SheetProperties[]> {
  const { sheets } = getClients();
  const res = await withRetry(() =>
    sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))',
    })
  );
  return (res.data.sheets ?? []).map((sheet) => ({
    sheetId: sheet.properties?.sheetId ?? 0,
    title: sheet.properties?.title ?? '',
    rowCount: sheet.properties?.gridProperties?.rowCount ?? 0,
    columnCount: sheet.properties?.gridProperties?.columnCount ?? 0,
  }));
}

// Reads a single range's values (batched read of the whole used range is
// preferred per 4.7; callers pass a wide range like "A1:ZZ").
export async function readValues(spreadsheetId: string, range: string): Promise<any[][]> {
  const { sheets } = getClients();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: 'UNFORMATTED_VALUE' })
  );
  return (res.data.values as any[][]) || [];
}

// Reads just the header row (row 1) of a tab. When no tab is given, defaults to
// the spreadsheet's actual first tab (not a hardcoded "Sheet1").
export async function readHeaders(spreadsheetId: string, tabName?: string): Promise<string[]> {
  let tab = tabName;
  if (!tab) {
    const meta = await getSpreadsheetMeta(spreadsheetId);
    tab = meta.tabs[0] || 'Sheet1';
  }
  const range = a1Range(tab, '1:1');
  const rows = await readValues(spreadsheetId, range);
  const header = rows[0] || [];
  return header.map((h: unknown) => String(h == null ? '' : h).trim());
}

/**
 * Read raw/effective/formatted values and the formatting/validation metadata
 * needed by the folder-cleanup safety audit and its schema-specific Undo.
 */
export async function readCleanupSheet(
  spreadsheetId: string,
  tabName?: string,
  knownName = ''
): Promise<CleanupSheet> {
  const { sheets } = getClients();
  const meta = await getSpreadsheetMeta(spreadsheetId);
  const tab = tabName || meta.tabs[0] || '';
  if (!tab) throw new Error(`${knownName || meta.title || spreadsheetId} has no readable tab.`);
  const res = await withRetry(() =>
    sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [quoteTabName(tab)],
      includeGridData: false,
      fields: [
        'spreadsheetId',
        'properties.title',
        'namedRanges',
        'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount))',
        'merges,conditionalFormats,protectedRanges,filterViews,basicFilter,charts)',
      ].join(','),
    })
  );
  const source = (res.data.sheets || []).find((item) => item.properties?.title === tab);
  if (!source) throw new Error(`${knownName || meta.title || spreadsheetId} no longer has tab "${tab}".`);
  const props = source.properties;
  const rowCount = props?.gridProperties?.rowCount || 0;
  const columnCount = props?.gridProperties?.columnCount || 0;
  const cells: CleanupCell[][] = [];
  let columnMetadata: Array<Record<string, unknown>> = [];
  // Keep each JSON payload far below V8's string limit while avoiding hundreds
  // of quota-heavy requests for large master tabs.
  const rowsPerRequest = 5000;
  const endColumn = columnCount > 0 ? columnLetter(columnCount - 1) : 'A';
  for (let startRow = 1; startRow <= rowCount; startRow += rowsPerRequest) {
    const endRow = Math.min(rowCount, startRow + rowsPerRequest - 1);
    const chunk = await withRetry(() =>
      sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [a1Range(tab, `A${startRow}:${endColumn}${endRow}`)],
        includeGridData: true,
        fields: [
          'sheets(data(startRow,startColumn,columnMetadata',
          'rowData.values(userEnteredValue,effectiveValue,formattedValue,userEnteredFormat,effectiveFormat,dataValidation,note)))',
        ].join(','),
      })
    );
    const grid = chunk.data.sheets?.[0]?.data?.[0];
    const offset = grid?.startRow ?? startRow - 1;
    if (columnMetadata.length === 0 && (grid?.columnMetadata || []).length > 0) {
      columnMetadata = (grid?.columnMetadata || []).map((item) =>
        JSON.parse(JSON.stringify(item)) as Record<string, unknown>
      );
    }
    for (let rowOffset = 0; rowOffset < (grid?.rowData || []).length; rowOffset++) {
      cells[offset + rowOffset] = (grid?.rowData?.[rowOffset]?.values || []).map((value) => ({
      userEnteredValue: sheetExtendedValue(value.userEnteredValue),
      effectiveValue: sheetExtendedValue(value.effectiveValue) as CleanupCell['effectiveValue'],
      formattedValue: value.formattedValue ?? '',
      numberFormat: (value.effectiveFormat?.numberFormat || value.userEnteredFormat?.numberFormat)
        ? {
            type: (value.effectiveFormat?.numberFormat || value.userEnteredFormat?.numberFormat)?.type || undefined,
            pattern: (value.effectiveFormat?.numberFormat || value.userEnteredFormat?.numberFormat)?.pattern || undefined,
          }
        : undefined,
      userEnteredFormat: value.userEnteredFormat
        ? JSON.parse(JSON.stringify(value.userEnteredFormat)) as Record<string, unknown>
        : undefined,
      effectiveFormat: value.effectiveFormat
        ? JSON.parse(JSON.stringify(value.effectiveFormat)) as Record<string, unknown>
        : undefined,
      dataValidation: value.dataValidation ? JSON.parse(JSON.stringify(value.dataValidation)) : undefined,
      note: value.note || undefined,
      }));
    }
  }
  const dependencies: CleanupDependency[] = [];
  const selectedHeaders = (cells[0] || []).map((cell) => String(cell.formattedValue || '').trim());
  const noteIndexes = new Set(
    selectedHeaders
      .map((header, index) => ({ header, index }))
      .filter((item) => NOTE_TEXT_COLUMNS.includes(item.header as typeof NOTE_TEXT_COLUMNS[number]))
      .map((item) => item.index)
  );
  const selectedTabHasBlockingFormula = cells.some((row) =>
    row.some((cell, index) =>
      !noteIndexes.has(index) &&
      Boolean(cell.userEnteredValue && typeof cell.userEnteredValue === 'object')
    )
  );
  if (selectedTabHasBlockingFormula) {
    dependencies.push({
      kind: 'formula',
      detail: 'At least one formula exists on this tab; column-reference restoration cannot be guaranteed.',
      startColumn: 0,
      endColumn: columnCount,
    });
  }
  const structuralHeaders = new Set<string>([...LEGACY_ADDRESS_COLUMNS, ...RETIRED_SALES_COLUMNS]);
  if (!selectedTabHasBlockingFormula && selectedHeaders.some((header) => structuralHeaders.has(header))) {
    const formulaTab = await findFormulaOnOtherTab(spreadsheetId, tab);
    if (formulaTab) {
      dependencies.push({
        kind: 'formula',
        detail: `Formula cells exist on tab "${formulaTab}"; cross-tab references cannot be restored safely.`,
        startColumn: 0,
        endColumn: columnCount,
      });
    }
  }
  const addRanges = (kind: string, values: unknown[] | undefined, rangeOf: (value: any) => any) => {
    for (const value of values || []) {
      const range = rangeOf(value);
      if (!range || range.sheetId !== props?.sheetId) continue;
      dependencies.push({
        kind,
        detail: `${kind} spans columns ${(range.startColumnIndex || 0) + 1}-${range.endColumnIndex || columnCount}.`,
        startColumn: range.startColumnIndex || 0,
        endColumn: range.endColumnIndex || columnCount,
      });
    }
  };
  addRanges('merged range', source.merges, (value) => value);
  addRanges(
    'conditional format',
    (source.conditionalFormats || []).flatMap((value) => value.ranges || []),
    (value) => value
  );
  addRanges('protected range', source.protectedRanges, (value) => value.range);
  addRanges('filter view', source.filterViews, (value) => value.range);
  if (source.basicFilter?.range) addRanges('basic filter', [source.basicFilter], (value) => value.range);
  // Charts and named ranges can carry column references not represented as a
  // single simple grid range. Blocking all candidate deletes is conservative.
  if ((source.charts || []).length > 0 || (res.data.namedRanges || []).some((value) => value.range?.sheetId === props?.sheetId)) {
    dependencies.push({
      kind: 'named range or chart',
      detail: 'A named range or chart may depend on this tab.',
      startColumn: 0,
      endColumn: columnCount,
    });
  }
  return {
    spreadsheetId,
    spreadsheetName: knownName || res.data.properties?.title || meta.title,
    tabName: tab,
    sheetId: props?.sheetId || 0,
    rowCount,
    columnCount,
    cells,
    columnMetadata,
    dependencies,
  };
}

async function findFormulaOnOtherTab(spreadsheetId: string, selectedTab: string): Promise<string | null> {
  const { sheets } = getClients();
  const properties = await getSheetProperties(spreadsheetId);
  const rowsPerRequest = 1000;
  for (const property of properties) {
    if (property.title === selectedTab || property.rowCount <= 0 || property.columnCount <= 0) continue;
    const endColumn = columnLetter(property.columnCount - 1);
    for (let startRow = 1; startRow <= property.rowCount; startRow += rowsPerRequest) {
      const endRow = Math.min(property.rowCount, startRow + rowsPerRequest - 1);
      const response = await withRetry(() =>
        sheets.spreadsheets.values.get({
          spreadsheetId,
          range: a1Range(property.title, `A${startRow}:${endColumn}${endRow}`),
          valueRenderOption: 'FORMULA',
        })
      );
      const hasFormula = (response.data.values || []).some((row) =>
        row.some((value) => typeof value === 'string' && value.startsWith('='))
      );
      if (hasFormula) return property.title;
    }
  }
  return null;
}

function sheetExtendedValue(value?: sheets_v4.Schema$ExtendedValue | null): CleanupCell['userEnteredValue'] {
  if (!value) return null;
  if (value.formulaValue != null) return { formulaValue: value.formulaValue };
  if (value.boolValue != null) return value.boolValue;
  if (value.numberValue != null) return value.numberValue;
  if (value.stringValue != null) return value.stringValue;
  if (value.errorValue != null) return String(value.errorValue.message || value.errorValue.type || '#ERROR!');
  return null;
}

// ---- Write helpers (Phase C) ----
// These are deliberately small transport wrappers. Safety decisions, snapshots,
// approval checks, and durable logging belong to the execution engine.

export interface ValueRangeUpdate {
  range: string;
  values: unknown[][];
}

export interface AppendValuesResult {
  updatedRange: string;
  updatedRows: number;
}

export interface CreatedSpreadsheetFile {
  id: string;
  name: string;
  webViewLink: string;
  modifiedTime: string;
}

export interface DrivePermissionSummary {
  type: string;
  role: string;
  emailAddress: string;
  domain: string;
  allowFileDiscovery: boolean | null;
}

export async function listDrivePermissions(fileId: string): Promise<DrivePermissionSummary[]> {
  const { drive } = getClients();
  const res = await withRetry(() =>
    drive.permissions.list({
      fileId,
      supportsAllDrives: true,
      fields: 'permissions(type,role,emailAddress,domain,allowFileDiscovery)',
    })
  );
  return (res.data.permissions || []).map((permission) => ({
    type: permission.type || '',
    role: permission.role || '',
    emailAddress: permission.emailAddress || '',
    domain: permission.domain || '',
    allowFileDiscovery: permission.allowFileDiscovery ?? null,
  }));
}

/** Update several A1 ranges in one Sheets API request. */
export async function updateValues(spreadsheetId: string, updates: ValueRangeUpdate[]): Promise<number> {
  if (updates.length === 0) return 0;
  assertCurrentJobLease();
  const { sheets } = getClients();
  const res = await withRetry(
    () =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: updates.map((update) => ({ range: update.range, values: update.values })),
        },
      }),
    { attempts: 1 }
  );
  return res.data.totalUpdatedCells ?? 0;
}

/** Chunk large update sets and pace them under Sheets write-request quotas. */
export async function updateValuesChunked(
  spreadsheetId: string,
  updates: ValueRangeUpdate[],
  chunkSize = 2500,
  pauseMs = 1200
): Promise<number> {
  if (updates.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < updates.length; i += chunkSize) {
    if (i > 0 && pauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    total += await updateValues(spreadsheetId, updates.slice(i, i + chunkSize));
  }
  return total;
}

/** Append whole rows to a tab without interpreting user-entered values. */
export async function appendValues(
  spreadsheetId: string,
  range: string,
  rows: unknown[][]
): Promise<AppendValuesResult> {
  if (rows.length === 0) return { updatedRange: '', updatedRows: 0 };
  assertCurrentJobLease();
  const { sheets } = getClients();
  const res = await withRetry(
    () =>
      sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      }),
    { attempts: 1 }
  );
  return {
    updatedRange: res.data.updates?.updatedRange ?? '',
    updatedRows: res.data.updates?.updatedRows ?? 0,
  };
}

/** Copy an existing spreadsheet into a Drive folder, preserving formatting and validations. */
export async function copySpreadsheetToFolder(
  templateSpreadsheetId: string,
  folderId: string,
  name: string,
  operationToken?: string
): Promise<CreatedSpreadsheetFile> {
  assertCurrentJobLease();
  const { drive } = getClients();
  const res = await withRetry(
    () =>
      drive.files.copy({
        fileId: templateSpreadsheetId,
        supportsAllDrives: true,
        fields: 'id,name,webViewLink,modifiedTime',
        requestBody: {
          name,
          parents: [folderId],
          ...(operationToken ? { appProperties: { sheetsmartOperation: operationToken } } : {}),
        },
      }),
    { attempts: 1 }
  );
  if (!res.data.id) throw new Error('Google Drive copied the template but returned no spreadsheet ID.');
  return {
    id: res.data.id,
    name: res.data.name || name,
    webViewLink: res.data.webViewLink || '',
    modifiedTime: res.data.modifiedTime || '',
  };
}

export async function findSpreadsheetByOperationToken(
  folderId: string,
  operationToken: string
): Promise<CreatedSpreadsheetFile | null> {
  const { drive } = getClients();
  const escapedToken = operationToken.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const parentClause = folderId ? `'${folderId}' in parents and ` : '';
  const res = await withRetry(() =>
    drive.files.list({
      q: `${parentClause}trashed=false and mimeType='application/vnd.google-apps.spreadsheet' and appProperties has { key='sheetsmartOperation' and value='${escapedToken}' }`,
      fields: 'files(id,name,webViewLink,modifiedTime)',
      pageSize: 2,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
  );
  const file = res.data.files?.[0];
  if (!file?.id) return null;
  return {
    id: file.id,
    name: file.name || '',
    webViewLink: file.webViewLink || '',
    modifiedTime: file.modifiedTime || '',
  };
}

/** Clear cell contents while preserving formatting and data-validation rules. */
export async function clearValues(spreadsheetId: string, range: string): Promise<void> {
  assertCurrentJobLease();
  const { sheets } = getClients();
  await withRetry(() => sheets.spreadsheets.values.clear({ spreadsheetId, range, requestBody: {} }), { attempts: 1 });
}

export async function getDriveFile(
  fileId: string
): Promise<{ id: string; name: string; modifiedTime: string; trashed: boolean }> {
  const { drive } = getClients();
  const res = await withRetry(() =>
    drive.files.get({ fileId, supportsAllDrives: true, fields: 'id,name,modifiedTime,trashed' })
  );
  return {
    id: res.data.id || fileId,
    name: res.data.name || '',
    modifiedTime: res.data.modifiedTime || '',
    trashed: Boolean(res.data.trashed),
  };
}

export async function trashDriveFile(fileId: string): Promise<void> {
  assertCurrentJobLease();
  const { drive } = getClients();
  await withRetry(
    () => drive.files.update({ fileId, supportsAllDrives: true, requestBody: { trashed: true }, fields: 'id' }),
    { attempts: 1 }
  );
}

/** Apply structural requests such as deleting rows. */
export async function batchUpdateSpreadsheet(
  spreadsheetId: string,
  requests: sheets_v4.Schema$Request[]
): Promise<sheets_v4.Schema$Response[]> {
  if (requests.length === 0) return [];
  assertCurrentJobLease();
  const { sheets } = getClients();
  const res = await withRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      }),
    { attempts: 1 }
  );
  return res.data.replies ?? [];
}

/** Remove a temporary safety lock even if the originating job lease expired. */
export async function removeProtectedRangeCleanup(
  spreadsheetId: string,
  protectedRangeId: number
): Promise<void> {
  const { sheets } = getClients();
  await withRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ deleteProtectedRange: { protectedRangeId } }],
        },
      }),
    { attempts: 1 }
  );
}

export async function listProtectedRanges(
  spreadsheetId: string
): Promise<Array<{ protectedRangeId: number; description: string }>> {
  const { sheets } = getClients();
  const res = await withRetry(() =>
    sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.protectedRanges(protectedRangeId,description)',
    })
  );
  return (res.data.sheets || []).flatMap((sheet) =>
    (sheet.protectedRanges || [])
      .filter((range) => range.protectedRangeId != null)
      .map((range) => ({
        protectedRangeId: Number(range.protectedRangeId),
        description: String(range.description || ''),
      }))
  );
}

export { SCOPES };

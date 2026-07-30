// Google integration (handoff Section 4). Authenticates a dedicated service
// account, caches the clients, wraps every call in retry-with-backoff, and
// provides the A1/column helpers used across the app. All Sheets API calls,
// including Phase-C writes, stay behind this module.

import { google, sheets_v4, drive_v3 } from 'googleapis';
import { config } from './config';

// The service-account auth client, derived from googleapis so we don't depend
// on google-auth-library directly.
type GoogleAuthClient = InstanceType<typeof google.auth.GoogleAuth>;

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets', // read + write cells/columns
  'https://www.googleapis.com/auth/drive.readonly', // list files in the captain folder
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

let cached: GoogleClients | null = null;

export function isConfigured(): boolean {
  return Boolean(config.googleServiceAccountJsonB64);
}

function loadCredentials(): ServiceAccountCredentials {
  if (!isConfigured()) {
    throw new Error(
      'Google is not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON_B64 in your .env (see README Section A).'
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

// Retry with exponential backoff + jitter (handoff 4.2). Wrap EVERY Sheets/
// Drive call in this.
export async function withRetry<T>(fn: () => Promise<T>, { attempts = 4, baseDelayMs = 700 }: RetryOptions = {}): Promise<T> {
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
      const delay = baseDelayMs * 2 ** i + Math.floor(Math.random() * 250);
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

/** Update several A1 ranges in one Sheets API request. */
export async function updateValues(spreadsheetId: string, updates: ValueRangeUpdate[]): Promise<number> {
  if (updates.length === 0) return 0;
  const { sheets } = getClients();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates.map((update) => ({ range: update.range, values: update.values })),
      },
    })
  );
  return res.data.totalUpdatedCells ?? 0;
}

/** Append whole rows to a tab without interpreting user-entered values. */
export async function appendValues(
  spreadsheetId: string,
  range: string,
  rows: unknown[][]
): Promise<AppendValuesResult> {
  if (rows.length === 0) return { updatedRange: '', updatedRows: 0 };
  const { sheets } = getClients();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    })
  );
  return {
    updatedRange: res.data.updates?.updatedRange ?? '',
    updatedRows: res.data.updates?.updatedRows ?? 0,
  };
}

/** Apply structural requests such as deleting rows. */
export async function batchUpdateSpreadsheet(
  spreadsheetId: string,
  requests: sheets_v4.Schema$Request[]
): Promise<sheets_v4.Schema$Response[]> {
  if (requests.length === 0) return [];
  const { sheets } = getClients();
  const res = await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    })
  );
  return res.data.replies ?? [];
}

export { SCOPES };

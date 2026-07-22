// Shared types mirroring the SheetSmart JSON API. Kept in one place so the
// whole frontend stays in sync with the backend contract.

export type ConnectionType = 'master' | 'captain_folder' | 'external';

export interface Connection {
  id: number;
  name: string;
  type: ConnectionType;
  google_id: string;
  source_tab: string;
  notes: string;
  created_at: string;
}

export type Policy = 'fill_blank' | 'overwrite' | 'conflict' | 'never';
export type FieldDataType = 'text' | 'number' | 'date' | 'checkbox';

export interface DictionaryField {
  id: number;
  canonical_name: string;
  data_type: FieldDataType;
  is_identity: number; // 0 | 1
  is_sensitive: number; // 0 | 1
  is_text_safe: number; // 0 | 1
  default_policy: Policy;
  notes: string;
  sort_order: number;
  aliases: string[];
}

export interface RunSummary {
  id: number;
  workflow_name: string | null;
  type: string;
  mode: 'dry' | 'live';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  started_at: string | null;
  finished_at: string | null;
  created_at?: string;
  summary_json?: string;
}

export interface StatusResponse {
  google: { configured: boolean; clientEmail: string | null };
  connections: {
    master: Connection[];
    captain_folder: Connection[];
    external: Connection[];
    total: number;
  };
  counts: {
    workflows: number;
    sensitiveColumns: number;
    dictionaryFields: number;
    sensitiveFields: number;
    openConflicts: number;
  };
  recentRuns: RunSummary[];
}

export interface TestConnectionResult {
  kind: 'folder' | 'spreadsheet';
  // folder
  count?: number;
  spreadsheets?: { name: string; modifiedTime?: string }[];
  // spreadsheet
  title?: string;
  tabRead?: string;
  headerCount?: number;
  headers?: string[];
}

// ---- Health audit (Phase B) — mirrors src/lib/auditEngine.ts ----

export type Count = number | 'N/A';

export type SheetStatus =
  | 'Match'
  | 'Missing Columns'
  | 'Extra Columns'
  | 'Missing + Extra'
  | 'Empty'
  | 'ERROR';

export interface SheetAudit {
  name: string;
  url: string;
  status: SheetStatus;
  error?: string;
  totalColumns: number;
  dataRows: number;
  apnValues: Count;
  damageValues: Count;
  addressesMissingApn: Count;
  zone: string;
  apnInconsistentAddresses: number;
  missingRows: Count;
  extraNotInMaster: Count;
  extraWrongZone: Count;
  missingColumns: string[];
  extraColumns: string[];
}

export interface DuplicateResidentRow {
  residentId: string;
  spreadsheet: string;
  url: string;
  row: number;
  totalOccurrences: number;
  scope: 'Within Sheet' | 'Across Sheets';
}

export interface MissingRow {
  spreadsheet: string;
  url: string;
  zoneName: string;
  residentId: string;
  residentName: string;
  address: string;
  masterRow: number | '';
}

export interface ExtraRow {
  spreadsheet: string;
  url: string;
  sheetZone: string;
  residentId: string;
  residentName: string;
  address: string;
  reason: 'Not in master' | 'Wrong zone';
  masterZoneName: string;
}

export interface MissingSitusRow {
  spreadsheet: string;
  url: string;
  zoneName: string;
  row: number;
  residentId: string;
  residentName: string;
  house: string;
  street: string;
  situsHouseNo: string;
  situsStreet: string;
  missingFields: string;
}

export interface ApnInconsistencyRow {
  spreadsheet: string;
  url: string;
  zoneName: string;
  address: string;
  addressSource: string;
  rowsAtAddress: number;
  rowsWithApn: number;
  rowsMissingApn: number;
  apnValues: string;
  missingApnRows: string;
  reason: string;
}

export interface AuditSummary {
  sheetsScanned: number;
  sheetsWithErrors: number;
  sheetsEmpty: number;
  sheetsMatching: number;
  sheetsWithColumnDrift: number;
  totalDataRows: number;
  duplicateResidentIds: number;
  totalMissingRows: number;
  totalExtraNotInMaster: number;
  totalExtraWrongZone: number;
  totalAddressesMissingApn: number;
  totalApnInconsistencies: number;
  totalMissingSitus: number;
  rowMembershipSkipReason: string;
}

export interface AuditReport {
  generatedAt: string;
  masterHeaders: string[];
  summary: AuditSummary;
  sheets: SheetAudit[];
  columnDetail: unknown[];
  duplicateResidentIds: DuplicateResidentRow[];
  missingRows: MissingRow[];
  extraRows: ExtraRow[];
  missingSitusRows: MissingSitusRow[];
  apnInconsistencies: ApnInconsistencyRow[];
}

export interface AuditLatestResponse {
  report: AuditReport | null;
  runId: number | null;
}

export interface AuditRunResponse {
  runId: number;
  report: AuditReport;
}

// ---- Preview (dry run) — mirrors src/routes/preview.routes.ts ----

export interface PreviewPlaybook {
  key: string;
  title: string;
  engine: string;
  kind: 'cell_fill' | 'push_missing';
}

export interface CellFillImpact {
  headline: string;
  detail: string;
  filled: number;
  conflicts: number;
  overwritten: number;
  columnsToAdd: number;
  sheetsAffected: number;
  errors: number;
}

export interface PushMissingImpact {
  headline: string;
  detail: string;
  appended: number;
  flagged: number;
  sheetsAffected: number;
  errors: number;
}

export type PreviewImpact = CellFillImpact | PushMissingImpact;

export interface CellFillSheet {
  name: string;
  url: string;
  filled: number;
  conflicts: number;
  overwritten: number;
  columnsToAdd: number;
  errors: string[];
}

export interface PushMissingSheet {
  name: string;
  url: string;
  appended: number;
  flagged: number;
  detectedZone: string;
  errors: string[];
}

export interface PreviewResponse {
  runId: number;
  playbook: string;
  impact: PreviewImpact;
  target: 'master' | 'folder';
  unmatchedFields?: string[];
  sheets: (CellFillSheet | PushMissingSheet)[];
}

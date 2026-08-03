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
  snapshot_count?: number;
  unreverted_append_count?: number;
  unreverted_cell_count?: number;
  unreverted_delete_count?: number;
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

// ---- Phase C safe-copy execution ----

export interface SafeCopyTarget {
  masterSpreadsheetId: string;
  masterTab: string;
  captainSpreadsheetId: string;
  captainTab: string;
  folderId: string;
  masterName: string;
  captainName: string;
}

export interface SafeCopyTargetResponse {
  configured: boolean;
  target: SafeCopyTarget | null;
}

export interface SafeCopyResident {
  residentId: string;
  residentName: string;
  masterRow: number;
  flagged: boolean;
}

export interface SafeCopyPreviewResponse {
  runId: number;
  target: SafeCopyTarget;
  impact: PushMissingImpact;
  detectedZone: string;
  residents: SafeCopyResident[];
  canApply: boolean;
}

export interface EnrichZonesImpact {
  headline: string;
  detail: string;
  columnsToAdd: number;
  cellsToFill: number;
  residentsTouched: number;
  wouldChangeZone: number;
  unassigned: number;
}

export interface EnrichZonesSampleRow {
  residentId: string;
  residentName: string;
  masterRow: number;
  computedZone: string;
  values: Record<string, string>;
}

export interface EnrichZonesPreviewResponse {
  runId: number;
  target: SafeCopyTarget;
  enrichmentTab: string;
  impact: EnrichZonesImpact;
  columnsToAdd: string[];
  sample: EnrichZonesSampleRow[];
  canApply: boolean;
}

export interface MoveCopyTarget {
  masterSpreadsheetId: string;
  masterTab: string;
  fromCaptainSpreadsheetId: string;
  fromCaptainTab: string;
  toCaptainSpreadsheetId: string;
  toCaptainTab: string;
  folderId: string;
  masterName: string;
  fromCaptainName: string;
  toCaptainName: string;
  fromZoneOverride: string;
  toZoneOverride: string;
}

export interface MoveCopyTargetResponse {
  configured: boolean;
  target: MoveCopyTarget | null;
  suggested: {
    masterSpreadsheetId: string;
    masterTab: string;
    fromCaptainSpreadsheetId: string;
    fromCaptainTab: string;
    folderId: string;
  } | null;
}

export interface MoveResidentRow {
  residentId: string;
  residentName: string;
  fromZone: string;
  toZone: string;
  currentZoneOnSheet: string;
  computedZone: string;
  destinationFields?: Record<string, string>;
  fromSheet: string;
  toSheet: string;
}

export interface MoveResidentsImpact {
  headline: string;
  detail: string;
  moved: number;
  skipped: number;
  fromZone: string;
  toZone: string;
  destinationFields?: Record<string, string>;
}

export interface MoveResidentsPreviewResponse {
  runId: number;
  target: MoveCopyTarget;
  impact: MoveResidentsImpact;
  fromZone: string;
  toZone: string;
  destinationFields?: Record<string, string>;
  residents: MoveResidentRow[];
  skipped: Array<{ residentId: string; reason: string }>;
  canApply: boolean;
}

export interface QueuedRunResponse {
  runId: number;
  jobId: number;
  status: 'queued';
}

// ---- Zone Health (Workflow A) — mirrors src/lib/zoneEngine.ts ----

export type ZoneOutcome = 'match' | 'fill' | 'conflict' | 'unassigned' | 'missing_coords';

export interface ZoneFieldChange {
  field: string;
  from: string;
  to: string;
}

export interface ZoneDerivedFieldPreview {
  field: string;
  current: string;
  computed: string;
  columnExists: boolean;
}

export interface ZoneReconcileRow {
  residentId: string;
  residentName: string;
  masterRow: number;
  outcome: ZoneOutcome;
  currentZone: string;
  computedZone: string;
  multiZone: boolean;
  contactChanges: ZoneFieldChange[];
  outputValues: ZoneDerivedFieldPreview[];
}

export interface ZoneReconcileSummary {
  featuresLoaded: number;
  totalResidentRows: number;
  withCoordinates: number;
  missingCoords: number;
  unassigned: number;
  matched: number;
  wouldFillZone: number;
  wouldChangeZone: number;
  contactUpdates: number;
  multiZone: number;
  distinctZonesInMaster: number;
  distinctZonesComputed: number;
  columnsToAdd: number;
}

export interface ZoneResolvedHeader {
  field: string;
  header: string | null;
  matched: boolean;
}

export interface ZoneReconcileReport {
  generatedAt: string;
  summary: ZoneReconcileSummary;
  resolution: ZoneResolvedHeader[];
  proposedColumns: string[];
  enrichmentMode: boolean;
  detailTruncated: boolean;
  detailTotal: number;
  configError: string;
  rows: ZoneReconcileRow[];
}

export interface ZoneSource {
  username: string;
  datasetId: string;
}

export interface ZoneSourceStatus extends ZoneSource {
  tokenConfigured: boolean;
  usingDefaults: boolean;
}

export interface ZoneLatestResponse {
  report: ZoneReconcileReport | null;
  runId: number | null;
  source: ZoneSource | null;
}

export interface ZoneCheckResponse {
  runId: number;
  source: ZoneSource;
  report: ZoneReconcileReport;
}

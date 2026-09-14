import { useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { ErrorState, StatusPill } from './ui';
import { useToast } from './Toast';

interface PushMissingSheet {
  spreadsheetId: string;
  spreadsheetName: string;
  url: string;
  detectedZone: string;
  appended: Array<{ residentId: string; residentName: string }>;
  flagged: Array<{ residentId: string; residentName: string; flaggedColumns: string }>;
  errors: string[];
}

interface PushMissingPreview {
  runId: number;
  impact: {
    headline: string;
    detail: string;
    appended: number;
    flagged: number;
    sheetsAffected: number;
    sheetsWithAdds: number;
    sheetsScanned: number;
    readErrors: number;
  };
  sheets: PushMissingSheet[];
  readErrors: Array<{ spreadsheet: string; reason: string }>;
  canApply: boolean;
}

interface PushFieldsSheet {
  spreadsheetId: string;
  spreadsheetName: string;
  url: string;
  filled: number;
  conflicts: number;
  overwritten: number;
  columnsToAdd: string[];
  errors: string[];
}

interface PushFieldsPreview {
  runId: number;
  impact: {
    headline: string;
    detail: string;
    filled: number;
    conflicts: number;
    overwritten: number;
    columnsToAdd: number;
    sheetsAffected: number;
    sheetsScanned: number;
    readErrors: number;
  };
  sheets: PushFieldsSheet[];
  readErrors: Array<{ spreadsheet: string; reason: string }>;
  canApply: boolean;
}

function SyncCard({
  eyebrow,
  title,
  description,
  scanLabel,
  scanningLabel,
  onScan,
  busy,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  scanLabel: string;
  scanningLabel: string;
  onScan: () => void;
  busy: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="eyebrow">{eyebrow}</div>
      <h3>{title}</h3>
      <p className="reading-copy">{description}</p>
      <div className="btn-row">
        <button className="btn highlight" disabled={busy} onClick={onScan}>
          {busy ? scanningLabel : scanLabel}
        </button>
      </div>
      {children}
    </div>
  );
}

export function CaptainSyncPlaybook() {
  const { toast } = useToast();
  const [missingBusy, setMissingBusy] = useState(false);
  const [fieldsBusy, setFieldsBusy] = useState(false);
  const [missingPreview, setMissingPreview] = useState<PushMissingPreview | null>(null);
  const [fieldsPreview, setFieldsPreview] = useState<PushFieldsPreview | null>(null);
  const [missingSelected, setMissingSelected] = useState<Set<string>>(new Set());
  const [fieldsSelected, setFieldsSelected] = useState<Set<string>>(new Set());
  const [missingError, setMissingError] = useState<string | null>(null);
  const [fieldsError, setFieldsError] = useState<string | null>(null);

  const missingSheetsWithWork = useMemo(
    () => missingPreview?.sheets.filter((sheet) => sheet.appended.length > 0 && sheet.errors.length === 0) || [],
    [missingPreview]
  );
  const fieldsSheetsWithWork = useMemo(
    () =>
      fieldsPreview?.sheets.filter(
        (sheet) => (sheet.filled > 0 || sheet.overwritten > 0 || sheet.columnsToAdd.length > 0) && sheet.errors.length === 0
      ) || [],
    [fieldsPreview]
  );

  async function scanMissing() {
    setMissingBusy(true);
    setMissingError(null);
    setMissingPreview(null);
    try {
      const response = await api.post<PushMissingPreview>('/captain-sync/push-missing/preview');
      setMissingPreview(response);
      setMissingSelected(new Set(response.sheets.filter((sheet) => sheet.appended.length > 0).map((s) => s.spreadsheetId)));
    } catch (reason) {
      setMissingError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setMissingBusy(false);
    }
  }

  async function scanFields() {
    setFieldsBusy(true);
    setFieldsError(null);
    setFieldsPreview(null);
    try {
      const response = await api.post<PushFieldsPreview>('/captain-sync/push-fields/preview');
      setFieldsPreview(response);
      setFieldsSelected(
        new Set(
          response.sheets
            .filter((sheet) => sheet.filled > 0 || sheet.overwritten > 0 || sheet.columnsToAdd.length > 0)
            .map((s) => s.spreadsheetId)
        )
      );
    } catch (reason) {
      setFieldsError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setFieldsBusy(false);
    }
  }

  async function applyMissing() {
    if (!missingPreview || missingSelected.size === 0) return;
    if (
      !confirm(
        `Add master residents to ${missingSelected.size} captain sheet${missingSelected.size === 1 ? '' : 's'}? Existing captain rows will not be changed. You can undo this from Runs.`
      )
    ) {
      return;
    }
    setMissingBusy(true);
    setMissingError(null);
    try {
      const result = await api.post<{ runId: number }>('/captain-sync/push-missing/apply', {
        previewRunId: missingPreview.runId,
        spreadsheetIds: [...missingSelected],
        confirmed: true,
      });
      toast(`Captain row sync queued as run #${result.runId}`, 'success');
      setMissingPreview(null);
      setMissingSelected(new Set());
    } catch (reason) {
      setMissingError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setMissingBusy(false);
    }
  }

  async function applyFields() {
    if (!fieldsPreview || fieldsSelected.size === 0) return;
    if (
      !confirm(
        `Fill blank cells from the master on ${fieldsSelected.size} captain sheet${fieldsSelected.size === 1 ? '' : 's'}? Existing captain values will not be overwritten unless a field is set to overwrite in Fields. You can undo this from Runs.`
      )
    ) {
      return;
    }
    setFieldsBusy(true);
    setFieldsError(null);
    try {
      const result = await api.post<{ runId: number }>('/captain-sync/push-fields/apply', {
        previewRunId: fieldsPreview.runId,
        spreadsheetIds: [...fieldsSelected],
        confirmed: true,
      });
      toast(`Captain field sync queued as run #${result.runId}`, 'success');
      setFieldsPreview(null);
      setFieldsSelected(new Set());
    } catch (reason) {
      setFieldsError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setFieldsBusy(false);
    }
  }

  function toggleMissing(id: string) {
    setMissingSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleFields(id: string) {
    setFieldsSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const missingResidentsSelected = missingPreview
    ? missingPreview.sheets
        .filter((sheet) => missingSelected.has(sheet.spreadsheetId))
        .reduce((sum, sheet) => sum + sheet.appended.length, 0)
    : 0;
  const fieldsCellsSelected = fieldsPreview
    ? fieldsPreview.sheets
        .filter((sheet) => fieldsSelected.has(sheet.spreadsheetId))
        .reduce((sum, sheet) => sum + sheet.filled + sheet.overwritten, 0)
    : 0;

  return (
    <>
      <SyncCard
        eyebrow="Live master → captains"
        title="Add missing residents to captain sheets"
        description="Finds master residents whose zone matches a captain sheet but who are missing from that sheet. Only new rows are appended — nothing already on a captain sheet is changed."
        scanLabel="Scan captain sheets for missing residents"
        scanningLabel="Scanning master and captain sheets…"
        busy={missingBusy}
        onScan={scanMissing}
      >
        {missingError && <ErrorState message={missingError} />}
        {missingPreview && (
          <>
            <div className="callout" style={{ marginTop: 16 }}>
              <strong>{missingPreview.impact.headline}</strong>
              <div style={{ marginTop: 6 }}>{missingPreview.impact.detail}</div>
            </div>
            <div className="card-grid" style={{ marginTop: 16 }}>
              <Metric value={missingPreview.impact.appended} label="New residents to add" />
              <Metric value={missingPreview.impact.sheetsWithAdds} label="Captain sheets affected" />
              <Metric value={missingPreview.impact.flagged} label="Rows with sensitive fields" alert />
              <Metric value={missingPreview.impact.sheetsScanned} label="Captain sheets scanned" />
            </div>
            {missingPreview.readErrors.length > 0 && (
              <div className="callout warn" style={{ marginTop: 16 }}>
                <strong>{missingPreview.readErrors.length} captain sheet(s) could not be read.</strong> Fix those
                problems and scan again.
              </div>
            )}
            {missingSheetsWithWork.length > 0 && (
              <>
                <div className="section-head" style={{ marginTop: 18 }}>
                  <h3>Captain sheets ready to update</h3>
                  <div className="spacer" />
                  <span className="pill neutral">{missingResidentsSelected.toLocaleString()} residents selected</span>
                </div>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th />
                        <th>Captain sheet</th>
                        <th>Zone</th>
                        <th className="num">New residents</th>
                        <th className="num">Sensitive rows</th>
                      </tr>
                    </thead>
                    <tbody>
                      {missingSheetsWithWork.map((sheet) => (
                        <tr key={sheet.spreadsheetId}>
                          <td>
                            <input
                              type="checkbox"
                              checked={missingSelected.has(sheet.spreadsheetId)}
                              onChange={() => toggleMissing(sheet.spreadsheetId)}
                              aria-label={`Select ${sheet.spreadsheetName}`}
                            />
                          </td>
                          <td>
                            {sheet.url ? (
                              <a href={sheet.url} target="_blank" rel="noreferrer">
                                {sheet.spreadsheetName}
                              </a>
                            ) : (
                              sheet.spreadsheetName
                            )}
                          </td>
                          <td>{sheet.detectedZone || '—'}</td>
                          <td className="num">{sheet.appended.length}</td>
                          <td className="num">{sheet.flagged.length}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="btn-row" style={{ marginTop: 16 }}>
                  <button
                    className="btn"
                    disabled={missingBusy || missingSelected.size === 0 || missingResidentsSelected === 0}
                    onClick={applyMissing}
                  >
                    Add {missingResidentsSelected.toLocaleString()} resident
                    {missingResidentsSelected === 1 ? '' : 's'} to {missingSelected.size} sheet
                    {missingSelected.size === 1 ? '' : 's'}
                  </button>
                  <StatusPill status="approval required" />
                </div>
              </>
            )}
            {!missingPreview.canApply && missingPreview.readErrors.length === 0 && (
              <p className="reading-copy" style={{ marginTop: 16 }}>
                Every captain sheet already includes the master residents for its zone.
              </p>
            )}
          </>
        )}
      </SyncCard>

      <SyncCard
        eyebrow="Live master → captains"
        title="Push master fields to captain sheets"
        description="Fills blank cells on captain sheets from the master for every field marked to distribute to captains. Disagreements are skipped, not overwritten."
        scanLabel="Scan captain sheets for blank cells"
        scanningLabel="Scanning master and captain sheets…"
        busy={fieldsBusy}
        onScan={scanFields}
      >
        {fieldsError && <ErrorState message={fieldsError} />}
        {fieldsPreview && (
          <>
            <div className="callout" style={{ marginTop: 16 }}>
              <strong>{fieldsPreview.impact.headline}</strong>
              <div style={{ marginTop: 6 }}>{fieldsPreview.impact.detail}</div>
            </div>
            <div className="card-grid" style={{ marginTop: 16 }}>
              <Metric value={fieldsPreview.impact.filled} label="Blank cells to fill" />
              <Metric value={fieldsPreview.impact.sheetsAffected} label="Captain sheets affected" />
              <Metric value={fieldsPreview.impact.conflicts} label="Conflicts skipped" alert />
              <Metric value={fieldsPreview.impact.columnsToAdd} label="New columns to add" />
            </div>
            {fieldsPreview.readErrors.length > 0 && (
              <div className="callout warn" style={{ marginTop: 16 }}>
                <strong>{fieldsPreview.readErrors.length} captain sheet(s) could not be read.</strong> Fix those
                problems and scan again.
              </div>
            )}
            {fieldsSheetsWithWork.length > 0 && (
              <>
                <div className="section-head" style={{ marginTop: 18 }}>
                  <h3>Captain sheets ready to update</h3>
                  <div className="spacer" />
                  <span className="pill neutral">{fieldsCellsSelected.toLocaleString()} cells selected</span>
                </div>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th />
                        <th>Captain sheet</th>
                        <th className="num">Fill blanks</th>
                        <th className="num">Replace</th>
                        <th className="num">Conflicts</th>
                        <th className="num">New cols</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fieldsSheetsWithWork.map((sheet) => (
                        <tr key={sheet.spreadsheetId}>
                          <td>
                            <input
                              type="checkbox"
                              checked={fieldsSelected.has(sheet.spreadsheetId)}
                              onChange={() => toggleFields(sheet.spreadsheetId)}
                              aria-label={`Select ${sheet.spreadsheetName}`}
                            />
                          </td>
                          <td>
                            {sheet.url ? (
                              <a href={sheet.url} target="_blank" rel="noreferrer">
                                {sheet.spreadsheetName}
                              </a>
                            ) : (
                              sheet.spreadsheetName
                            )}
                          </td>
                          <td className="num">{sheet.filled}</td>
                          <td className="num">{sheet.overwritten}</td>
                          <td className="num">{sheet.conflicts}</td>
                          <td className="num">{sheet.columnsToAdd.length}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="btn-row" style={{ marginTop: 16 }}>
                  <button
                    className="btn"
                    disabled={fieldsBusy || fieldsSelected.size === 0 || fieldsCellsSelected === 0}
                    onClick={applyFields}
                  >
                    Fill {fieldsCellsSelected.toLocaleString()} cell{fieldsCellsSelected === 1 ? '' : 's'} on{' '}
                    {fieldsSelected.size} sheet{fieldsSelected.size === 1 ? '' : 's'}
                  </button>
                  <StatusPill status="approval required" />
                </div>
              </>
            )}
            {!fieldsPreview.canApply && fieldsPreview.readErrors.length === 0 && (
              <p className="reading-copy" style={{ marginTop: 16 }}>
                Captain sheets already match the master on every shared field, or only conflicts remain.
              </p>
            )}
          </>
        )}
      </SyncCard>
    </>
  );
}

function Metric({ value, label, alert = false }: { value: number; label: string; alert?: boolean }) {
  return (
    <div className="card">
      <div className="metric" style={alert && value > 0 ? { color: 'var(--rosy-copper)' } : undefined}>
        {value.toLocaleString()}
      </div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

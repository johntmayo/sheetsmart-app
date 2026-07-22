import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type {
  AuditLatestResponse,
  AuditReport,
  AuditRunResponse,
  Count,
  SheetAudit,
  SheetStatus,
  StatusResponse,
} from '../lib/types';
import { EmptyState, ErrorState, SectionHead, Spinner, StatusPill } from '../components/ui';

const SHEET_STATUS_KIND: Record<SheetStatus, string> = {
  Match: 'ok',
  'Missing Columns': 'warn',
  'Extra Columns': 'warn',
  'Missing + Extra': 'urgent',
  Empty: 'neutral',
  ERROR: 'error',
};

function fmt(count: Count): string {
  return typeof count === 'number' ? count.toLocaleString() : 'N/A';
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function Dashboard() {
  const { data: status, loading: statusLoading, error: statusError } = useAsync<StatusResponse>(() =>
    api.get('/status'),
  );

  const [report, setReport] = useState<AuditReport | null>(null);
  const [auditLoading, setAuditLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<AuditLatestResponse>('/audit/latest')
      .then((r) => {
        if (alive) setReport(r.report);
      })
      .catch(() => {
        /* no prior audit is fine */
      })
      .finally(() => {
        if (alive) setAuditLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const runAudit = useCallback(async () => {
    setRunning(true);
    setAuditError(null);
    try {
      const r = await api.post<AuditRunResponse>('/audit/run');
      setReport(r.report);
    } catch (e) {
      setAuditError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, []);

  if (statusLoading) return <Spinner />;
  if (statusError) return <ErrorState message={statusError} />;
  if (!status) return null;

  const { google, connections: conn } = status;
  const canAudit = google.configured && conn.master.length > 0 && conn.captain_folder.length > 0;

  const connCard = (title: string, present: boolean, detail: string) => (
    <div className="card">
      <h3>{title}</h3>
      <StatusPill status={present ? 'connected' : 'disconnected'} />
      <div className="card-meta" style={{ marginTop: 8 }}>
        {detail}
      </div>
    </div>
  );

  return (
    <>
      <div className="callout">
        Welcome back. This is the health view for the resident-data backbone — the master, the captain sheets, and the
        sources it keeps honestly aligned. Nothing changes without a preview and your confirmation.
        {!google.configured && (
          <>
            {' '}
            <strong>Google isn&apos;t connected yet</strong> — add the service-account key to{' '}
            <span className="mono">.env</span> and restart.
          </>
        )}
      </div>

      <div className="card-grid">
        {connCard(
          'Google connection',
          google.configured,
          google.configured ? `Service account: ${google.clientEmail ?? ''}` : 'No service-account key configured.',
        )}
        {connCard('Master spreadsheet', conn.master.length > 0, conn.master.length ? conn.master[0].name : 'Not added yet')}
        {connCard(
          'Captain folder',
          conn.captain_folder.length > 0,
          conn.captain_folder.length ? conn.captain_folder[0].name : 'Not added yet',
        )}
        {connCard(
          'External sources',
          conn.external.length > 0,
          conn.external.length ? `${conn.external.length} connected` : 'Not added yet',
        )}
      </div>

      <SectionHead title="Alignment">
        <div className="card-meta" style={{ marginRight: 12 }}>
          {report ? `Last checked ${fmtWhen(report.generatedAt)}` : 'Not checked yet'}
        </div>
        <button className="btn" onClick={runAudit} disabled={!canAudit || running}>
          {running ? 'Checking…' : report ? 'Re-check alignment' : 'Check alignment'}
        </button>
      </SectionHead>

      {!canAudit && (
        <p className="reading-copy" style={{ marginTop: 0 }}>
          Connect Google and add a <strong>master</strong> and a <strong>captain folder</strong> under Sources to check
          alignment. This is a read-only scan — nothing is written to any sheet.
        </p>
      )}

      {auditError && <ErrorState message={auditError} />}

      {auditLoading ? (
        <Spinner />
      ) : running && !report ? (
        <div className="reading-copy">Reading the master and every captain sheet… this can take a moment.</div>
      ) : report ? (
        <AuditView report={report} />
      ) : (
        canAudit && (
          <EmptyState
            title="No alignment check yet"
            body="Run a check to see column drift, duplicate resident IDs, missing/extra rows by zone, and data completeness across every captain sheet."
          />
        )
      )}
    </>
  );
}

function AuditView({ report }: { report: AuditReport }) {
  const s = report.summary;
  return (
    <>
      <div className="card-grid" style={{ marginTop: 16 }}>
        <Metric value={s.sheetsScanned} label="Captain sheets scanned" />
        <Metric value={s.sheetsWithColumnDrift} label="Sheets with column drift" alert={s.sheetsWithColumnDrift > 0} />
        <Metric value={s.duplicateResidentIds} label="Duplicate resident IDs" alert={s.duplicateResidentIds > 0} />
        <Metric value={s.totalMissingRows} label="Missing rows (by zone)" alert={s.totalMissingRows > 0} />
      </div>
      <div className="card-grid" style={{ marginTop: 16 }}>
        <Metric
          value={s.totalExtraNotInMaster + s.totalExtraWrongZone}
          label="Extra rows (not in master / wrong zone)"
          alert={s.totalExtraNotInMaster + s.totalExtraWrongZone > 0}
        />
        <Metric value={s.totalAddressesMissingApn} label="Addresses missing APN" alert={s.totalAddressesMissingApn > 0} />
        <Metric value={s.totalApnInconsistencies} label="APN inconsistencies" alert={s.totalApnInconsistencies > 0} />
        <Metric value={s.totalMissingSitus} label="Rows missing situs address" alert={s.totalMissingSitus > 0} />
      </div>

      {s.sheetsWithErrors > 0 && (
        <p className="reading-copy">
          <strong>{s.sheetsWithErrors}</strong> sheet(s) couldn&apos;t be read (see the “ERROR” status below).
        </p>
      )}
      {s.rowMembershipSkipReason && <p className="reading-copy">{s.rowMembershipSkipReason}</p>}

      <SheetTable sheets={report.sheets} />
      <DrilldownSections report={report} />
    </>
  );
}

function Metric({ value, label, alert }: { value: number; label: string; alert?: boolean }) {
  return (
    <div className="card">
      <div className="metric" style={alert ? { color: 'var(--rosy-copper)' } : undefined}>
        {value.toLocaleString()}
      </div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

function SheetStatusPill({ status }: { status: SheetStatus }) {
  const kind = SHEET_STATUS_KIND[status] ?? 'neutral';
  return <span className={`pill ${kind}`}>{status}</span>;
}

function SheetTable({ sheets }: { sheets: SheetAudit[] }) {
  if (sheets.length === 0) return null;
  return (
    <>
      <div className="section-head" style={{ marginTop: 32 }}>
        <h2>By captain sheet</h2>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Spreadsheet</th>
              <th>Zone</th>
              <th>Status</th>
              <th className="num">Rows</th>
              <th className="num">Missing</th>
              <th className="num">Extra</th>
              <th className="num">Missing APN</th>
              <th className="num">APN issues</th>
              <th>Drift</th>
            </tr>
          </thead>
          <tbody>
            {sheets.map((sh) => {
              const extra =
                (typeof sh.extraNotInMaster === 'number' ? sh.extraNotInMaster : 0) +
                (typeof sh.extraWrongZone === 'number' ? sh.extraWrongZone : 0);
              const drift = [
                sh.missingColumns.length ? `−${sh.missingColumns.length} cols` : '',
                sh.extraColumns.length ? `+${sh.extraColumns.length} cols` : '',
              ]
                .filter(Boolean)
                .join(', ');
              return (
                <tr key={sh.name}>
                  <td>
                    {sh.url ? (
                      <a href={sh.url} target="_blank" rel="noreferrer">
                        {sh.name}
                      </a>
                    ) : (
                      sh.name
                    )}
                    {sh.error && <div className="card-meta">{sh.error}</div>}
                  </td>
                  <td>{sh.zone || '—'}</td>
                  <td>
                    <SheetStatusPill status={sh.status} />
                  </td>
                  <td className="num">{sh.dataRows.toLocaleString()}</td>
                  <td className="num">{fmt(sh.missingRows)}</td>
                  <td className="num">{extra || (sh.status === 'ERROR' || sh.status === 'Empty' ? 'N/A' : 0)}</td>
                  <td className="num">{fmt(sh.addressesMissingApn)}</td>
                  <td className="num">{sh.apnInconsistentAddresses}</td>
                  <td className="truncate" title={[...sh.missingColumns, ...sh.extraColumns].join(', ')}>
                    {drift || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DrilldownSections({ report }: { report: AuditReport }) {
  return (
    <>
      {report.duplicateResidentIds.length > 0 && (
        <Section title="Duplicate resident IDs" count={report.duplicateResidentIds.length}>
          <table className="data">
            <thead>
              <tr>
                <th>resident_id</th>
                <th>Spreadsheet</th>
                <th className="num">Row</th>
                <th className="num">Occurrences</th>
                <th>Scope</th>
              </tr>
            </thead>
            <tbody>
              {report.duplicateResidentIds.map((d, i) => (
                <tr key={`${d.residentId}-${d.spreadsheet}-${d.row}-${i}`}>
                  <td className="mono">{d.residentId}</td>
                  <td>{d.spreadsheet}</td>
                  <td className="num">{d.row}</td>
                  <td className="num">{d.totalOccurrences}</td>
                  <td>{d.scope}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {report.missingRows.length > 0 && (
        <Section title="Missing rows (expected by zone, absent from sheet)" count={report.missingRows.length}>
          <table className="data">
            <thead>
              <tr>
                <th>Spreadsheet</th>
                <th>Zone</th>
                <th>resident_id</th>
                <th>Resident Name</th>
                <th>Address</th>
              </tr>
            </thead>
            <tbody>
              {report.missingRows.map((m, i) => (
                <tr key={`${m.spreadsheet}-${m.residentId}-${i}`}>
                  <td>{m.spreadsheet}</td>
                  <td>{m.zoneName}</td>
                  <td className="mono">{m.residentId}</td>
                  <td>{m.residentName}</td>
                  <td className="truncate">{m.address}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {report.extraRows.length > 0 && (
        <Section title="Extra rows (in sheet, not expected here)" count={report.extraRows.length}>
          <table className="data">
            <thead>
              <tr>
                <th>Spreadsheet</th>
                <th>Sheet Zone</th>
                <th>resident_id</th>
                <th>Resident Name</th>
                <th>Reason</th>
                <th>Master&apos;s Zone</th>
              </tr>
            </thead>
            <tbody>
              {report.extraRows.map((x, i) => (
                <tr key={`${x.spreadsheet}-${x.residentId}-${i}`}>
                  <td>{x.spreadsheet}</td>
                  <td>{x.sheetZone}</td>
                  <td className="mono">{x.residentId}</td>
                  <td>{x.residentName}</td>
                  <td>{x.reason}</td>
                  <td>{x.masterZoneName || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {report.apnInconsistencies.length > 0 && (
        <Section title="APN inconsistencies (same address)" count={report.apnInconsistencies.length}>
          <table className="data">
            <thead>
              <tr>
                <th>Spreadsheet</th>
                <th>Address</th>
                <th className="num">Rows</th>
                <th className="num">With APN</th>
                <th className="num">Missing APN</th>
                <th>APN value(s)</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {report.apnInconsistencies.map((a, i) => (
                <tr key={`${a.spreadsheet}-${a.address}-${i}`}>
                  <td>{a.spreadsheet}</td>
                  <td className="truncate">{a.address}</td>
                  <td className="num">{a.rowsAtAddress}</td>
                  <td className="num">{a.rowsWithApn}</td>
                  <td className="num">{a.rowsMissingApn}</td>
                  <td className="truncate">{a.apnValues}</td>
                  <td>{a.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {report.missingSitusRows.length > 0 && (
        <Section title="Rows missing situs address fields" count={report.missingSitusRows.length}>
          <table className="data">
            <thead>
              <tr>
                <th>Spreadsheet</th>
                <th>Zone</th>
                <th className="num">Row</th>
                <th>resident_id</th>
                <th>Resident Name</th>
                <th>Missing field(s)</th>
              </tr>
            </thead>
            <tbody>
              {report.missingSitusRows.map((m, i) => (
                <tr key={`${m.spreadsheet}-${m.row}-${i}`}>
                  <td>{m.spreadsheet}</td>
                  <td>{m.zoneName}</td>
                  <td className="num">{m.row}</td>
                  <td className="mono">{m.residentId}</td>
                  <td>{m.residentName}</td>
                  <td>{m.missingFields}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="section-head" style={{ marginTop: 24 }}>
        <h2>{title}</h2>
        <div className="spacer" />
        <span className="pill warn">{count.toLocaleString()}</span>
        <button className="btn secondary small" style={{ marginLeft: 12 }} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && <div className="table-wrap">{children}</div>}
    </>
  );
}

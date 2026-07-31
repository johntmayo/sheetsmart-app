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
  ZoneCheckResponse,
  ZoneLatestResponse,
  ZoneOutcome,
  ZoneReconcileReport,
  ZoneSourceStatus,
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

      <ZoneHealth googleConfigured={google.configured} hasMaster={conn.master.length > 0} />
    </>
  );
}

// ---- Zone Health (Workflow A): read-only zone reconciliation ----

const ZONE_OUTCOME_META: Record<ZoneOutcome, { label: string; kind: string }> = {
  fill: { label: 'Would fill', kind: 'ok' },
  match: { label: 'Correct', kind: 'ok' },
  conflict: { label: 'Would change zone', kind: 'urgent' },
  unassigned: { label: 'In no zone', kind: 'warn' },
  missing_coords: { label: 'Missing coordinates', kind: 'neutral' },
};

function ZoneHealth({ googleConfigured, hasMaster }: { googleConfigured: boolean; hasMaster: boolean }) {
  const [source, setSource] = useState<ZoneSourceStatus | null>(null);
  const [report, setReport] = useState<ZoneReconcileReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get<ZoneSourceStatus>('/zones/source').catch(() => null),
      api.get<ZoneLatestResponse>('/zones/latest').catch(() => null),
    ])
      .then(([src, latest]) => {
        if (!alive) return;
        if (src) setSource(src);
        if (latest?.report) setReport(latest.report);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const runCheck = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.post<ZoneCheckResponse>('/zones/check');
      setReport(r.report);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, []);

  const tokenConfigured = source?.tokenConfigured ?? false;
  const canCheck = googleConfigured && hasMaster && tokenConfigured;

  return (
    <>
      <SectionHead title="Zones & captains">
        <div className="card-meta" style={{ marginRight: 12 }}>
          {report ? `Last checked ${fmtWhen(report.generatedAt)}` : 'Not checked yet'}
        </div>
        <button className="btn" onClick={runCheck} disabled={!canCheck || running}>
          {running ? 'Checking…' : report ? 'Re-check zones' : 'Check zones'}
        </button>
      </SectionHead>

      <p className="reading-copy" style={{ marginTop: 0 }}>
        Compares each resident&apos;s latitude/longitude against your {source?.username ? '' : 'Mapbox '}zone shapes and
        proposes ZoneName plus captain (NC) contact values. Works on the raw 48-column master even when those four
        columns do not exist yet — they are treated as proposed outputs, not required inputs.{' '}
        <strong>This is a read-only check — nothing is written to any sheet.</strong>
      </p>

      {!loading && !tokenConfigured && (
        <div className="callout" style={{ marginTop: 0 }}>
          <strong>Mapbox isn&apos;t connected yet.</strong> Add a <span className="mono">MAPBOX_TOKEN</span> (a token with
          the <span className="mono">datasets:read</span> scope) to <span className="mono">.env</span> and restart. The
          zone dataset is <span className="mono">{source?.username ?? 'altagether'}</span> /{' '}
          <span className="mono">{source?.datasetId ?? ''}</span>.
        </div>
      )}
      {!loading && tokenConfigured && !hasMaster && (
        <p className="reading-copy" style={{ marginTop: 0 }}>
          Add a <strong>master</strong> connection under Sources to check zones.
        </p>
      )}

      {error && <ErrorState message={error} />}
      {report?.configError && <ErrorState message={report.configError} />}

      {loading ? (
        <Spinner />
      ) : running && !report ? (
        <div className="reading-copy">Reading the master and fetching your zone shapes…</div>
      ) : report && !report.configError ? (
        <ZoneView report={report} />
      ) : (
        canCheck &&
        !report && (
          <EmptyState
            title="No zone check yet"
            body="Run a check to see how many residents would change zones, sit in no zone, are missing coordinates, or have captain contact info that needs updating."
          />
        )
      )}
    </>
  );
}

const DERIVED_ZONE_FIELDS = new Set(['ZoneName', 'NC Name', 'NC Phone', 'NC Email']);

function ZoneView({ report }: { report: ZoneReconcileReport }) {
  const s = report.summary;
  const enrichmentMode = report.enrichmentMode || (report.proposedColumns?.length ?? 0) > 0;
  const proposedColumns = report.proposedColumns || [];
  // Derived ZoneName/NC fields are proposed outputs on a raw master — only warn
  // about truly required inputs (lat/lon/identity) that couldn't be found.
  const unresolvedRequired = report.resolution
    .filter((r) => !r.matched && !DERIVED_ZONE_FIELDS.has(r.field))
    .map((r) => r.field);

  return (
    <>
      {enrichmentMode && (
        <div className="callout" style={{ marginTop: 16 }}>
          <strong>Enrichment plan (read-only).</strong> This master tab is missing{' '}
          {proposedColumns.length > 0 ? proposedColumns.join(', ') : 'the derived zone/captain columns'}. SheetSmart
          computed them from latitude/longitude + Mapbox shapes. No columns or cells will be written until a later,
          approval-gated live step.
        </div>
      )}

      <div className="card-grid" style={{ marginTop: 16 }}>
        <Metric
          value={s.columnsToAdd ?? proposedColumns.length}
          label="Columns to add"
          alert={(s.columnsToAdd ?? proposedColumns.length) > 0}
        />
        <Metric
          value={s.wouldFillZone}
          label={enrichmentMode ? 'Would receive a zone' : 'Unzoned → would get a zone'}
          alert={s.wouldFillZone > 0}
        />
        <Metric value={s.wouldChangeZone} label="Would change zone" alert={s.wouldChangeZone > 0} />
        <Metric value={s.unassigned} label="In no zone (valid coords)" alert={s.unassigned > 0} />
      </div>
      <div className="card-grid" style={{ marginTop: 16 }}>
        <Metric value={s.contactUpdates} label="Captain contact updates" alert={s.contactUpdates > 0} />
        <Metric value={s.missingCoords} label="Missing coordinates" alert={s.missingCoords > 0} />
        <Metric value={s.matched} label="Already correct" />
        <Metric value={s.multiZone} label="In more than one zone" alert={s.multiZone > 0} />
      </div>
      <div className="card-grid" style={{ marginTop: 16 }}>
        <Metric value={s.featuresLoaded} label="Zone shapes loaded" />
        <Metric value={s.distinctZonesComputed} label="Zones computed" />
        <Metric value={s.distinctZonesInMaster} label="Zones already on master" />
        <Metric value={s.totalResidentRows} label="Resident rows checked" />
      </div>

      {unresolvedRequired.length > 0 && (
        <p className="reading-copy">
          <strong>Heads up:</strong> couldn&apos;t locate these required master column(s): {unresolvedRequired.join(', ')}.
          Add an alias in the Field Dictionary so the check can find them.
        </p>
      )}

      <ZoneDetailTable report={report} enrichmentMode={enrichmentMode} />
    </>
  );
}

function formatOutputPreview(row: ZoneReconcileReport['rows'][number]): string {
  if (row.outputValues && row.outputValues.length > 0) {
    return row.outputValues
      .map((v) => {
        const arrow = v.columnExists ? `${v.current || '(blank)'} → ${v.computed || '(blank)'}` : v.computed || '(blank)';
        const suffix = v.columnExists ? '' : ' (new)';
        return `${v.field}: ${arrow}${suffix}`;
      })
      .join('; ');
  }
  if (row.contactChanges.length === 0) return row.computedZone || '—';
  return row.contactChanges.map((c) => `${c.field}: ${c.from || '(blank)'} → ${c.to}`).join('; ');
}

function ZoneDetailTable({
  report,
  enrichmentMode,
}: {
  report: ZoneReconcileReport;
  enrichmentMode: boolean;
}) {
  const [open, setOpen] = useState(enrichmentMode);
  const detailTotal = report.detailTotal ?? report.rows.length;
  const truncated = report.detailTruncated ?? false;

  if (report.rows.length === 0) {
    return (
      <p className="reading-copy">
        Everything lines up — every resident with coordinates is in the right zone with current captain info.
      </p>
    );
  }
  return (
    <>
      <div className="section-head" style={{ marginTop: 24 }}>
        <h2>{enrichmentMode ? 'Raw resident → computed zone & captain values' : 'What a zone refresh would change'}</h2>
        <div className="spacer" />
        <span className="pill warn">
          {truncated
            ? `${report.rows.length.toLocaleString()} of ${detailTotal.toLocaleString()}`
            : report.rows.length.toLocaleString()}
        </span>
        <button className="btn secondary small" style={{ marginLeft: 12 }} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {truncated && (
        <p className="reading-copy" style={{ marginTop: 0 }}>
          Showing a prioritized sample of {report.rows.length.toLocaleString()} rows (conflicts and fills first). Summary
          counts above cover all {detailTotal.toLocaleString()} residents that need attention.
        </p>
      )}
      {open && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>What</th>
                <th>resident_id</th>
                <th>Resident Name</th>
                <th className="num">Row</th>
                <th>Current zone</th>
                <th>Computed zone</th>
                <th>{enrichmentMode ? 'Proposed ZoneName / NC values' : 'Captain contact changes'}</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r, i) => {
                const meta = ZONE_OUTCOME_META[r.outcome];
                return (
                  <tr key={`${r.residentId}-${r.masterRow}-${i}`}>
                    <td>
                      <span className={`pill ${meta.kind}`}>
                        {enrichmentMode && r.outcome === 'fill' ? 'Would enrich' : meta.label}
                      </span>
                      {r.multiZone && (
                        <span className="pill warn" style={{ marginLeft: 6 }}>
                          Overlap
                        </span>
                      )}
                    </td>
                    <td className="mono">{r.residentId || '—'}</td>
                    <td>{r.residentName || '—'}</td>
                    <td className="num">{r.masterRow}</td>
                    <td>{r.currentZone || (enrichmentMode ? '(column absent)' : '—')}</td>
                    <td>{r.computedZone || '—'}</td>
                    <td className="truncate">{formatOutputPreview(r)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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

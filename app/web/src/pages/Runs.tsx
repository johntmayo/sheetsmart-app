import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { QueuedRunResponse, RunSummary } from '../lib/types';
import { EmptyState, ErrorState, Modal, SectionHead, Spinner, StatusPill } from '../components/ui';

interface RunDetailResponse {
  run: RunSummary;
  job: { error?: string; progress_json?: string } | null;
  typeCounts: Array<{ type: string; n: number }>;
  snapshotCounts: Array<{ operation: string; n: number; remaining: number }>;
}

interface RunLogRow {
  id: number;
  spreadsheet: string;
  row: string;
  column: string;
  resident_id: string;
  type: string;
  message: string;
}

export function Runs() {
  const { data, loading, error, reload } = useAsync<RunSummary[]>(() => api.get('/runs'));
  const [reverting, setReverting] = useState<RunSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [details, setDetails] = useState<{ data: RunDetailResponse; log: RunLogRow[] } | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  useEffect(() => {
    if (!data?.some((run) => run.status === 'queued' || run.status === 'running')) return;
    const timer = window.setInterval(reload, 2000);
    return () => window.clearInterval(timer);
  }, [data, reload]);

  async function confirmRevert() {
    if (!reverting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const queued = await api.post<QueuedRunResponse>(`/runs/${reverting.id}/revert`, { confirmed: true });
      setNotice(`Undo run #${queued.runId} is queued. This page will update automatically.`);
      setReverting(null);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function openDetails(run: RunSummary) {
    setDetails(null);
    setDetailsError(null);
    setDetailsLoading(true);
    try {
      const [data, log] = await Promise.all([
        api.get<RunDetailResponse>(`/runs/${run.id}`),
        api.get<RunLogRow[]>(`/runs/${run.id}/log?limit=200`),
      ]);
      setDetails({ data, log });
    } catch (e) {
      setDetailsError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setDetailsLoading(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  const rows = data ?? [];

  return (
    <>
      <SectionHead title="Runs" />
      <p className="reading-copy" style={{ marginTop: 0 }}>
        Every preview and live run is kept here as a permanent, readable record of exactly what changed (or would
        change) and why.
      </p>
      {notice && <div className="callout info">{notice}</div>}
      {rows.length === 0 ? (
        <EmptyState title="No runs yet" body="When you preview or approve a playbook, it will appear here." />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="num">ID</th>
                <th>Name</th>
                <th>Kind</th>
                <th>Preview or live</th>
                <th>Status</th>
                <th>Result</th>
                <th>Started</th>
                <th>Undo</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="num">{r.id}</td>
                  <td>
                    {r.workflow_name || '—'}
                    <div>
                      <button className="btn secondary small" style={{ marginTop: 6 }} onClick={() => openDetails(r)}>
                        View details
                      </button>
                    </div>
                  </td>
                  <td>{runTypeLabel(r.type)}</td>
                  <td>{r.mode === 'dry' ? 'Preview' : r.mode === 'live' ? 'Live change' : r.mode}</td>
                  <td>
                    <StatusPill status={r.status} />
                  </td>
                  <td>{runResult(r)}</td>
                  <td>{r.started_at || r.created_at || ''}</td>
                  <td>
                    {canUndo(r) ? (
                      <button className="btn destructive small" onClick={() => { setActionError(null); setReverting(r); }}>
                        Undo this run
                      </button>
                    ) : isReverted(r) ? (
                      <span className="card-meta">Reverted</span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reverting && (
        <Modal title={`Undo live run #${reverting.id}`} onClose={() => setReverting(null)}>
          <div className="callout warn">{undoWarning(reverting.type)}</div>
          <p className="reading-copy">{undoScope(reverting.type)}</p>
          {actionError && <div className="field-error">{actionError}</div>}
          <div className="btn-row" style={{ marginTop: 18 }}>
            <button className="btn secondary" onClick={() => setReverting(null)}>
              Keep the run
            </button>
            <button className="btn destructive" onClick={confirmRevert} disabled={submitting}>
              {submitting ? 'Starting undo…' : undoButtonLabel(reverting.type)}
            </button>
          </div>
        </Modal>
      )}
      {(detailsLoading || detailsError || details) && (
        <Modal
          title={details ? `Run #${details.data.run.id} details` : 'Run details'}
          onClose={() => {
            setDetails(null);
            setDetailsError(null);
            setDetailsLoading(false);
          }}
          wide
        >
          {detailsLoading && <Spinner />}
          {detailsError && <ErrorState message={detailsError} />}
          {details && <RunDetails data={details.data} log={details.log} />}
        </Modal>
      )}
    </>
  );
}

function RunDetails({ data, log }: { data: RunDetailResponse; log: RunLogRow[] }) {
  const progress = parseObject(data.job?.progress_json);
  const progressMessage =
    progress && typeof progress.progress === 'object' && progress.progress
      ? String((progress.progress as Record<string, unknown>).message || '')
      : '';
  const remaining = data.snapshotCounts.reduce((sum, item) => sum + Number(item.remaining || 0), 0);

  return (
    <>
      <div className="card-grid" style={{ marginTop: 12 }}>
        <div className="card">
          <div className="metric-label">Status</div>
          <div style={{ marginTop: 8 }}><StatusPill status={data.run.status} /></div>
        </div>
        <div className="card">
          <div className="metric-label">What happened</div>
          <div style={{ marginTop: 8 }}>{runResult(data.run)}</div>
        </div>
        <div className="card">
          <div className="metric">{remaining.toLocaleString()}</div>
          <div className="metric-label">Changes still available to Undo</div>
        </div>
      </div>
      {progressMessage && <div className="callout info" style={{ marginTop: 14 }}>{progressMessage}</div>}
      {data.job?.error && (
        <div className="callout warn" style={{ marginTop: 14 }}>
          <strong>Why it stopped:</strong> {data.job.error}
          {remaining > 0 && <div style={{ marginTop: 6 }}>This run recorded changes. Use Undo after reviewing the events below.</div>}
        </div>
      )}
      <div className="section-head" style={{ marginTop: 20 }}>
        <h3>Recorded events</h3>
      </div>
      {log.length === 0 ? (
        <p className="reading-copy">This run has no row-by-row events.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Spreadsheet</th>
                <th>Resident ID</th>
                <th>Column</th>
                <th>Event</th>
              </tr>
            </thead>
            <tbody>
              {log.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.spreadsheet || '—'}</td>
                  <td className="mono">{entry.resident_id || '—'}</td>
                  <td>{entry.column || '—'}</td>
                  <td>{entry.message || entry.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.length === 200 && (
        <p className="card-meta">Showing the first 200 events. The complete record remains stored in SheetSmart.</p>
      )}
    </>
  );
}

function parseObject(value?: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function undoWarning(type: string): string {
  if (type === 'create_zone_sheets') {
    return 'SheetSmart will move new sheets from this run to Google Drive trash, but only if nobody edited them afterward.';
  }
  if (type === 'folder_captain_import') {
    return 'SheetSmart will remove only the master rows added by this import that are still unchanged. Any row edited after import is preserved and flagged for review.';
  }
  if (type === 'address_intake') {
    return 'SheetSmart will remove only unchanged address-placeholder rows added by this intake. Later edits are preserved for review.';
  }
  if (type === 'folder_zone_reconcile') {
    return 'SheetSmart will reverse the approved master updates and captain-sheet moves only where rows and cells still match this run. Later human edits are preserved and flagged for review.';
  }
  if (type === 'apply_dashboard_deletion') {
    return 'SheetSmart will clear this run’s deletion markers where they are still unchanged, making those archived rows active again. Later edits are preserved for review.';
  }
  if (type === 'enrich_zones_copy') {
    return 'SheetSmart will restore only cells written by this run that are still unchanged. If anyone edited one of those cells afterward, it will be left in place and flagged for review.';
  }
  if (type === 'move_residents_copy') {
    return 'SheetSmart will remove unchanged rows from the destination copy and restore unchanged rows to the source copy. Rows edited after the move are left in place and flagged for review.';
  }
  if (type === 'pull_to_master_copy' || type === 'apply_conflict_copy') {
    return 'SheetSmart will put back the master values that this run replaced, but only where the cell is still unchanged. Anything edited afterward is left in place and flagged for review.';
  }
  return 'SheetSmart will remove only rows added by this run that are still unchanged. If anyone edited one of those rows afterward, it will be left in place and flagged for review.';
}

function runTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    create_zone_sheets: 'Create captain sheets',
    preview_create_zone_sheets: 'Preview new captain sheets',
    folder_captain_import: 'Add captain residents',
    preview_folder_captain_import: 'Preview captain additions',
    folder_zone_reconcile: 'Move residents between zones',
    preview_folder_zone_reconcile: 'Preview boundary changes',
    push_missing_copy: 'Practice: add missing residents',
    enrich_zones_copy: 'Practice: fill zone details',
    move_residents_copy: 'Practice: move residents',
    pull_to_master_copy: 'Practice: update master',
    pull_new_residents_copy: 'Practice: add residents to master',
    apply_conflict_copy: 'Practice: resolve conflicts',
    apply_dashboard_deletion: 'Apply captain deletion',
    revert_dashboard_deletion: 'Restore captain deletion',
    address_intake: 'Add missing addresses',
    preview_address_intake: 'Preview missing addresses',
  };
  return labels[type] ?? type.replaceAll('_', ' ');
}

function undoScope(type: string): string {
  if (type === 'create_zone_sheets') {
    return 'This affects only captain-zone spreadsheets created by this run; existing files are never removed.';
  }
  if (type === 'folder_captain_import') {
    return 'This affects only the real master, removing unchanged captain-created resident rows added by this run.';
  }
  if (type === 'address_intake') {
    return 'This affects only address-placeholder rows added to the real master by this intake.';
  }
  if (type === 'folder_zone_reconcile') {
    return 'This affects the real master and the real captain sheets included in that approved reconciliation.';
  }
  if (type === 'apply_dashboard_deletion') {
    return 'This restores rows marked as deleted in the master and captain sheets by this run.';
  }
  if (type === 'enrich_zones_copy') {
    return 'This affects only the master copy used by the zone-enrichment playbook.';
  }
  if (type === 'move_residents_copy') {
    return 'This affects only the two captain copies used by the re-zone move playbook.';
  }
  if (type === 'pull_to_master_copy' || type === 'apply_conflict_copy') {
    return 'This affects only the master copy. Conflicts logged by the run stay in the Conflict inbox.';
  }
  if (type === 'pull_new_residents_copy') {
    return 'This affects only the master copy, removing the resident rows this run added.';
  }
  return 'This affects only the copied captain sheet used by the safe-copy playbook.';
}

function undoButtonLabel(type: string): string {
  if (type === 'create_zone_sheets') return 'Undo created zone sheets';
  if (type === 'folder_captain_import') return 'Undo the captain import';
  if (type === 'address_intake') return 'Undo the address intake';
  if (type === 'folder_zone_reconcile') return 'Undo the reconciliation';
  if (type === 'apply_dashboard_deletion') return 'Restore deleted records';
  if (type === 'enrich_zones_copy') return 'Undo the enriched cells';
  if (type === 'move_residents_copy') return 'Undo the resident moves';
  if (type === 'pull_to_master_copy') return 'Undo the pulled values';
  if (type === 'pull_new_residents_copy') return 'Undo the added residents';
  if (type === 'apply_conflict_copy') return 'Undo the applied values';
  return 'Undo the appended rows';
}

function canUndo(run: RunSummary): boolean {
  const settled = ['succeeded', 'failed', 'interrupted'].includes(run.status);
  if (run.type === 'create_zone_sheets') {
    return settled && (run.unreverted_created_file_count ?? 0) > 0;
  }
  if (run.type === 'folder_captain_import' || run.type === 'address_intake') {
    return settled && (run.unreverted_append_count ?? 0) > 0;
  }
  if (run.type === 'folder_zone_reconcile') {
    const remaining =
      (run.unreverted_append_count ?? 0) +
      (run.unreverted_delete_count ?? 0) +
      (run.unreverted_cell_count ?? 0);
    return settled && remaining > 0;
  }
  if (run.type === 'apply_dashboard_deletion') {
    const remaining =
      (run.unreverted_append_count ?? 0) + (run.unreverted_delete_count ?? 0);
    return settled && remaining > 0;
  }
  if (run.type === 'push_missing_copy' || run.type === 'pull_new_residents_copy') {
    return settled && (run.unreverted_append_count ?? 0) > 0;
  }
  if (run.type === 'enrich_zones_copy') {
    return settled && (run.unreverted_cell_count ?? 0) > 0;
  }
  if (run.type === 'move_residents_copy') {
    const remaining =
      (run.unreverted_append_count ?? 0) + (run.unreverted_delete_count ?? 0);
    return settled && remaining > 0;
  }
  if (run.type === 'pull_to_master_copy' || run.type === 'apply_conflict_copy') {
    return settled && (run.unreverted_cell_count ?? 0) > 0;
  }
  return false;
}

function isReverted(run: RunSummary): boolean {
  if ((run.snapshot_count ?? 0) === 0 && (run.created_file_count ?? 0) === 0) return false;
  if (run.type === 'create_zone_sheets') {
    return (run.unreverted_created_file_count ?? 0) === 0;
  }
  if (run.type === 'folder_captain_import' || run.type === 'address_intake') {
    return (run.unreverted_append_count ?? 0) === 0;
  }
  if (run.type === 'folder_zone_reconcile') {
    return (
      (run.unreverted_append_count ?? 0) === 0 &&
      (run.unreverted_delete_count ?? 0) === 0 &&
      (run.unreverted_cell_count ?? 0) === 0
    );
  }
  if (run.type === 'apply_dashboard_deletion') {
    return (
      (run.unreverted_append_count ?? 0) === 0 &&
      (run.unreverted_delete_count ?? 0) === 0
    );
  }
  if (run.type === 'push_missing_copy' || run.type === 'pull_new_residents_copy') {
    return (run.unreverted_append_count ?? 0) === 0;
  }
  if (run.type === 'enrich_zones_copy') return (run.unreverted_cell_count ?? 0) === 0;
  if (run.type === 'move_residents_copy') {
    return (run.unreverted_append_count ?? 0) === 0 && (run.unreverted_delete_count ?? 0) === 0;
  }
  if (run.type === 'pull_to_master_copy' || run.type === 'apply_conflict_copy') {
    return (run.unreverted_cell_count ?? 0) === 0;
  }
  return false;
}

function runResult(run: RunSummary): string {
  if (!run.summary_json) return '—';
  try {
    const summary = JSON.parse(run.summary_json) as Record<string, unknown>;
    if (typeof summary.sheetsCreated === 'number') {
      const residents =
        typeof summary.residentsPendingReconciliation === 'number' ? summary.residentsPendingReconciliation : 0;
      return `${summary.sheetsCreated} zone sheet(s), ${residents} resident row(s) awaiting reconciliation`;
    }
    if (typeof summary.addressesImported === 'number') {
      const residents = typeof summary.residentsImported === 'number' ? summary.residentsImported : 0;
      return `${summary.addressesImported} address(es), ${residents} resident row(s) imported`;
    }
    if (typeof summary.addressesChanged === 'number') {
      const residents = typeof summary.residentsMoved === 'number' ? summary.residentsMoved : 0;
      return `${summary.addressesChanged} address(es), ${residents} resident row(s) reconciled`;
    }
    if (typeof summary.moved === 'number') return `${summary.moved} resident(s) moved`;
    if (typeof summary.restoredToSource === 'number' || typeof summary.deletedFromDest === 'number') {
      const restored = typeof summary.restoredToSource === 'number' ? summary.restoredToSource : 0;
      const removed = typeof summary.deletedFromDest === 'number' ? summary.deletedFromDest : 0;
      return `${removed} removed / ${restored} restored`;
    }
    if (typeof summary.cellsWritten === 'number') {
      const logged = typeof summary.conflictsLogged === 'number' ? summary.conflictsLogged : 0;
      return `${summary.cellsWritten.toLocaleString()} cell(s) pulled` + (logged ? `, ${logged} conflict(s) logged` : '');
    }
    if (typeof summary.resolved === 'number') return `${summary.resolved} conflict(s) applied`;
    if (typeof summary.appended === 'number') return `${summary.appended} row(s) added`;
    if (typeof summary.deleted === 'number') return `${summary.deleted} row(s) removed`;
    if (typeof summary.cellsFilled === 'number') {
      const cols = typeof summary.columnsAdded === 'number' ? summary.columnsAdded : 0;
      return `${summary.cellsFilled.toLocaleString()} cell(s) filled` + (cols ? `, ${cols} column(s)` : '');
    }
    if (typeof summary.restored === 'number') return `${summary.restored.toLocaleString()} cell(s) restored`;
    if (summary.impact && typeof summary.impact === 'object') {
      const headline = (summary.impact as { headline?: unknown }).headline;
      if (typeof headline === 'string') return headline;
    }
  } catch {
    // A malformed historic summary should not break the run ledger.
  }
  return 'Recorded';
}

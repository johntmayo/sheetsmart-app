import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { QueuedRunResponse, RunSummary } from '../lib/types';
import { EmptyState, ErrorState, Modal, SectionHead, Spinner, StatusPill } from '../components/ui';

export function Runs() {
  const { data, loading, error, reload } = useAsync<RunSummary[]>(() => api.get('/runs'));
  const [reverting, setReverting] = useState<RunSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
        <EmptyState title="No runs yet" body="Previews and live runs will appear here once execution is turned on." />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="num">ID</th>
                <th>Workflow</th>
                <th>Type</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Result</th>
                <th>Started</th>
                <th>Safety</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="num">{r.id}</td>
                  <td>{r.workflow_name || '—'}</td>
                  <td>{r.type}</td>
                  <td>{r.mode}</td>
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
    </>
  );
}

function undoWarning(type: string): string {
  if (type === 'enrich_zones_copy') {
    return 'SheetSmart will restore only cells written by this run that are still unchanged. If anyone edited one of those cells afterward, it will be left in place and flagged for review.';
  }
  if (type === 'move_residents_copy') {
    return 'SheetSmart will remove unchanged rows from the destination copy and restore unchanged rows to the source copy. Rows edited after the move are left in place and flagged for review.';
  }
  return 'SheetSmart will remove only rows added by this run that are still unchanged. If anyone edited one of those rows afterward, it will be left in place and flagged for review.';
}

function undoScope(type: string): string {
  if (type === 'enrich_zones_copy') {
    return 'This affects only the master copy used by the zone-enrichment playbook.';
  }
  if (type === 'move_residents_copy') {
    return 'This affects only the two captain copies used by the re-zone move playbook.';
  }
  return 'This affects only the copied captain sheet used by the safe-copy playbook.';
}

function undoButtonLabel(type: string): string {
  if (type === 'enrich_zones_copy') return 'Undo the enriched cells';
  if (type === 'move_residents_copy') return 'Undo the resident moves';
  return 'Undo the appended rows';
}

function canUndo(run: RunSummary): boolean {
  if (run.type === 'push_missing_copy') {
    return run.status === 'succeeded' && (run.unreverted_append_count ?? 0) > 0;
  }
  if (run.type === 'enrich_zones_copy') {
    return (run.status === 'succeeded' || run.status === 'failed') && (run.unreverted_cell_count ?? 0) > 0;
  }
  if (run.type === 'move_residents_copy') {
    const remaining =
      (run.unreverted_append_count ?? 0) + (run.unreverted_delete_count ?? 0);
    return (run.status === 'succeeded' || run.status === 'failed') && remaining > 0;
  }
  return false;
}

function isReverted(run: RunSummary): boolean {
  if ((run.snapshot_count ?? 0) === 0) return false;
  if (run.type === 'push_missing_copy') return (run.unreverted_append_count ?? 0) === 0;
  if (run.type === 'enrich_zones_copy') return (run.unreverted_cell_count ?? 0) === 0;
  if (run.type === 'move_residents_copy') {
    return (run.unreverted_append_count ?? 0) === 0 && (run.unreverted_delete_count ?? 0) === 0;
  }
  return false;
}

function runResult(run: RunSummary): string {
  if (!run.summary_json) return '—';
  try {
    const summary = JSON.parse(run.summary_json) as Record<string, unknown>;
    if (typeof summary.moved === 'number') return `${summary.moved} resident(s) moved`;
    if (typeof summary.restoredToSource === 'number' || typeof summary.deletedFromDest === 'number') {
      const restored = typeof summary.restoredToSource === 'number' ? summary.restoredToSource : 0;
      const removed = typeof summary.deletedFromDest === 'number' ? summary.deletedFromDest : 0;
      return `${removed} removed / ${restored} restored`;
    }
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

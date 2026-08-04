import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { EmptyState, ErrorState, SectionHead, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';
import type { QueuedRunResponse } from '../lib/types';

interface ConflictRow {
  id: number;
  workflow_name: string | null;
  run_type: string;
  spreadsheet: string;
  row: string;
  column: string;
  resident_id: string;
  existing_value: string;
  incoming_value: string;
  context_json?: string;
}

interface ConflictContext {
  kind?: string;
  tabName?: string;
  sourceName?: string;
  residentName?: string;
}

export function Conflicts() {
  const { data, loading, error, reload } = useAsync<ConflictRow[]>(() => api.get('/conflicts?status=open'));
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);
  const [queued, setQueued] = useState<QueuedRunResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function resolve(id: number) {
    await api.put(`/conflicts/${id}`, { status: 'resolved' });
    toast('Conflict marked resolved', 'success');
    reload();
  }

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function applySelected() {
    if (selected.size === 0) return;
    setApplying(true);
    setActionError(null);
    try {
      const result = await api.post<QueuedRunResponse>('/conflicts/apply', {
        confirmed: true,
        conflictIds: [...selected],
      });
      setQueued(result);
      setSelected(new Set());
      toast(`Live run #${result.runId} queued`, 'success');
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  const rows = data ?? [];
  const applicable = rows.filter((row) => parseContext(row).kind === 'pull_to_master');
  const selectedCount = applicable.filter((row) => selected.has(row.id)).length;

  return (
    <>
      <SectionHead title="Conflict inbox" />
      <p className="reading-copy" style={{ marginTop: 0 }}>
        Conflicts are disagreements between a source and a target value where the policy did not allow an overwrite.
        SheetSmart logs them instead of overwriting, so a human decides. Applying a captain value writes it to the
        master copy as its own recorded run, which you can undo from Runs.
      </p>
      {actionError && <ErrorState message={actionError} />}
      {queued && (
        <div className="callout info" style={{ marginBottom: 14 }}>
          Live run <strong>#{queued.runId}</strong> is queued. Follow it on the <a href="/runs">Runs page</a>, where it
          can also be undone.
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState title="No open conflicts" body="When a sync finds disagreements, they collect here for review." />
      ) : (
        <>
          {applicable.length > 0 && (
            <div className="btn-row" style={{ marginBottom: 12 }}>
              <button className="btn highlight" onClick={applySelected} disabled={selectedCount === 0 || applying}>
                {applying ? 'Starting safely…' : `Use captain value for ${selectedCount} selected`}
              </button>
            </div>
          )}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th />
                  <th>Workflow</th>
                  <th>Spreadsheet</th>
                  <th>Resident</th>
                  <th>Row</th>
                  <th>Column</th>
                  <th>Master value</th>
                  <th>Captain value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const context = parseContext(c);
                  const canApply = context.kind === 'pull_to_master';
                  return (
                    <tr key={c.id}>
                      <td>
                        {canApply && (
                          <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                        )}
                      </td>
                      <td className="truncate">{c.workflow_name || c.run_type}</td>
                      <td className="truncate">
                        {c.spreadsheet}
                        {context.tabName ? ` (${context.tabName})` : ''}
                      </td>
                      <td className="truncate">{context.residentName || c.resident_id || '—'}</td>
                      <td>{c.row}</td>
                      <td>{c.column}</td>
                      <td className="truncate">{c.existing_value}</td>
                      <td className="truncate">{c.incoming_value}</td>
                      <td>
                        <button className="btn secondary small" onClick={() => resolve(c.id)}>
                          Mark resolved
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function parseContext(row: ConflictRow): ConflictContext {
  try {
    const value = JSON.parse(row.context_json || '{}');
    return value && typeof value === 'object' ? (value as ConflictContext) : {};
  } catch {
    return {};
  }
}

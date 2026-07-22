import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { RunSummary } from '../lib/types';
import { EmptyState, ErrorState, SectionHead, Spinner, StatusPill } from '../components/ui';

export function Runs() {
  const { data, loading, error } = useAsync<RunSummary[]>(() => api.get('/runs'));
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
                <th>Started</th>
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
                  <td>{r.started_at || r.created_at || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { EmptyState, ErrorState, SectionHead, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';

interface ConflictRow {
  id: number;
  workflow_name: string | null;
  run_type: string;
  spreadsheet: string;
  row: string;
  column: string;
  existing_value: string;
  incoming_value: string;
}

export function Conflicts() {
  const { data, loading, error, reload } = useAsync<ConflictRow[]>(() => api.get('/conflicts?status=open'));
  const { toast } = useToast();

  async function resolve(id: number) {
    await api.put(`/conflicts/${id}`, { status: 'resolved' });
    toast('Conflict marked resolved', 'success');
    reload();
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  const rows = data ?? [];

  return (
    <>
      <SectionHead title="Conflict inbox" />
      <p className="reading-copy" style={{ marginTop: 0 }}>
        Conflicts are disagreements between a source and a target value where the policy did not allow an overwrite.
        SheetSmart logs them instead of overwriting, so a human decides. Approval-based resolution arrives with live
        execution.
      </p>
      {rows.length === 0 ? (
        <EmptyState title="No open conflicts" body="When a sync finds disagreements, they collect here for review." />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Spreadsheet</th>
                <th>Row</th>
                <th>Column</th>
                <th>Master value</th>
                <th>Captain value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{c.workflow_name || c.run_type}</td>
                  <td className="truncate">{c.spreadsheet}</td>
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

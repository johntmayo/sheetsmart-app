import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { EmptyState, ErrorState, SectionHead, Spinner, StatusPill } from './ui';
import { useToast } from './Toast';

interface OperationsConfig {
  spreadsheetId: string;
  deletedRecordsTab: string;
  activityEventsTab: string;
  allowedWriterEmails: string[];
}

interface ActivityItem {
  eventId: string;
  actor: string;
  zone: string;
  eventType: string;
  timestamp: string;
  summary: string;
}

interface ActivityResponse {
  events: ActivityItem[];
}

interface DeletionStatus {
  operation_id: string;
  actor: string;
  action: string;
  status: string;
  error: string;
}

interface WorkbookRepair {
  tab: string;
  row: number;
  message: string;
}

const DEFAULT_CONFIG: OperationsConfig = {
  spreadsheetId: '',
  deletedRecordsTab: 'Deleted Records',
  activityEventsTab: 'Activity Events',
  allowedWriterEmails: [],
};

export function OperationsPanel() {
  const { toast } = useToast();
  const [config, setConfig] = useState<OperationsConfig>(DEFAULT_CONFIG);
  const [configured, setConfigured] = useState(false);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [deletions, setDeletions] = useState<DeletionStatus[]>([]);
  const [selectedDeletions, setSelectedDeletions] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairs, setRepairs] = useState<WorkbookRepair[]>([]);

  const loadActivity = useCallback(async () => {
    const response = await api.get<ActivityResponse>('/operations/activity?limit=60');
    setActivity(response.events);
    const deletionResponse = await api.get<{ operations: DeletionStatus[] }>('/operations/deletions');
    setDeletions(deletionResponse.operations);
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get<{ configured: boolean; config: OperationsConfig }>('/operations/source'),
      api.get<ActivityResponse>('/operations/activity?limit=60'),
      api.get<{ operations: DeletionStatus[] }>('/operations/deletions'),
    ])
      .then(([source, recent, deletionStatus]) => {
        if (!alive) return;
        setConfigured(source.configured);
        setConfig(source.config);
        setEditing(!source.configured);
        setActivity(recent.events);
        setDeletions(deletionStatus.operations);
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function saveSource() {
    setBusy(true);
    setError(null);
    setRepairs([]);
    try {
      const response = await api.put<{ configured: boolean; config: OperationsConfig }>(
        '/operations/source',
        config
      );
      setConfigured(response.configured);
      setConfig(response.config);
      setEditing(false);
      toast('Private operations workbook saved', 'success');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
      if (reason instanceof ApiError && reason.details && typeof reason.details === 'object') {
        const details = reason.details as { errors?: WorkbookRepair[] };
        setRepairs(Array.isArray(details.errors) ? details.errors : []);
      }
    } finally {
      setBusy(false);
    }
  }

  async function initialize() {
    if (!confirm('Create missing tabs and add the required headers? SheetSmart will refuse to overwrite different existing headers.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/operations/initialize', { confirmed: true });
      toast('Operations workbook is ready', 'success');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setError(null);
    setRepairs([]);
    try {
      const result = await api.post<{
        operationsAdded: number;
        activityAdded: number;
      }>('/operations/sync');
      await loadActivity();
      toast(`Refreshed: ${result.activityAdded} new activities`, 'success');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
      if (reason instanceof ApiError && reason.details && typeof reason.details === 'object') {
        const details = reason.details as { errors?: WorkbookRepair[] };
        setRepairs(Array.isArray(details.errors) ? details.errors : []);
      }
    } finally {
      setBusy(false);
    }
  }

  async function applyPendingDeletions() {
    const operationIds = [...selectedDeletions];
    if (operationIds.length === 0) return;
    if (
      !confirm(
        `Mark ${operationIds.length} captain deletion${operationIds.length === 1 ? '' : 's'} in the live master and any remaining captain sheets? Rows stay safely archived in place, disappear from active data, and Runs provides restoration.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/operations/deletions/apply', {
        operationIds,
        confirmed: true,
      });
      setSelectedDeletions(new Set());
      await loadActivity();
      toast('Captain deletions queued. Follow progress under Runs.', 'success');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function retryDeletion(operationId: string) {
    if (!confirm('Retry this deletion now? Review its failed Run first if it may have changed some sheets.')) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/operations/deletions/${encodeURIComponent(operationId)}/retry`, { confirmed: true });
      await loadActivity();
      toast('Deletion retry queued. Follow progress under Runs.', 'success');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;

  return (
    <section>
      <SectionHead title="Recent captain activity">
        {configured && <StatusPill status="connected" />}
        <button className="btn secondary small" onClick={() => setEditing((value) => !value)}>
          {editing ? 'Close setup' : 'Workbook setup'}
        </button>
        <button className="btn small" disabled={!configured || busy} onClick={refresh}>
          {busy ? 'Refreshing…' : 'Refresh activity'}
        </button>
      </SectionHead>
      <p className="reading-copy" style={{ marginTop: 0 }}>
        A private, plain-English stream of meaningful actions from Zone Dashboard. Notes and contact details are never
        copied into this feed.
      </p>

      {error && <ErrorState message={error} />}
      {repairs.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 18 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Tab</th>
                <th>Row</th>
                <th>What to fix</th>
              </tr>
            </thead>
            <tbody>
              {repairs.map((item, index) => (
                <tr key={`${item.tab}-${item.row}-${index}`}>
                  <td>{item.tab}</td>
                  <td>{item.row}</td>
                  <td>{item.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {deletions.some((item) => item.status === 'failed') && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Captain deletions that need attention</h3>
          <p className="card-meta">
            Review the failed Run and fix the reported sheet problem. A retry preserves every earlier attempt for Undo.
          </p>
          {deletions
            .filter((item) => item.status === 'failed')
            .map((item) => (
              <div className="callout" key={item.operation_id}>
                <strong>{item.action === 'delete_address' ? 'Delete whole address' : 'Delete person'}</strong>
                {' · '}
                {item.actor}
                <div>{item.error || 'The deletion did not finish.'}</div>
                <button
                  className="btn secondary small"
                  disabled={busy}
                  onClick={() => retryDeletion(item.operation_id)}
                  style={{ marginTop: 8 }}
                >
                  Retry deletion
                </button>
              </div>
            ))}
        </div>
      )}
      {deletions.some((item) => item.status === 'queued') && (
        <p className="reading-copy">
          Captain deletions are queued or running. Their progress and Undo controls appear under Runs.
        </p>
      )}
      {deletions.some((item) => item.status === 'pending') && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Captain deletions ready to apply</h3>
          <p className="card-meta">
            These records already disappeared in Zone Dashboard. Review the requests, then approve removing remaining
            copies as deleted in the master and captain sheets. The rows remain archived in place for safe restoration.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th />
                  <th>Requested by</th>
                  <th>Action</th>
                  <th>Operation</th>
                </tr>
              </thead>
              <tbody>
                {deletions
                  .filter((item) => item.status === 'pending')
                  .map((item) => (
                    <tr key={item.operation_id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedDeletions.has(item.operation_id)}
                          onChange={() =>
                            setSelectedDeletions((current) => {
                              const next = new Set(current);
                              if (next.has(item.operation_id)) next.delete(item.operation_id);
                              else next.add(item.operation_id);
                              return next;
                            })
                          }
                          aria-label={`Select deletion ${item.operation_id}`}
                        />
                      </td>
                      <td>{item.actor}</td>
                      <td>{item.action === 'delete_address' ? 'Delete whole address' : 'Delete person'}</td>
                      <td className="mono">{item.operation_id}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <button
            className="btn destructive"
            disabled={busy || selectedDeletions.size === 0}
            onClick={applyPendingDeletions}
            style={{ marginTop: 12 }}
          >
            Mark {selectedDeletions.size || ''} selected deletion{selectedDeletions.size === 1 ? '' : 's'}
          </button>
        </div>
      )}

      {editing && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Private operations workbook</h3>
          <p className="card-meta">
            Use an admin-only Google spreadsheet. Zone Dashboard writes deletion archives and safe activity events
            here; SheetSmart reads them when you refresh.
          </p>
          <div className="field">
            <label>Spreadsheet ID</label>
            <input
              className="input mono"
              value={config.spreadsheetId}
              onChange={(event) => setConfig((value) => ({ ...value, spreadsheetId: event.target.value }))}
              placeholder="The part between /d/ and /edit"
            />
          </div>
          <div className="card-grid">
            <div className="field">
              <label>Deleted records tab</label>
              <input
                className="input"
                value={config.deletedRecordsTab}
                onChange={(event) => setConfig((value) => ({ ...value, deletedRecordsTab: event.target.value }))}
              />
            </div>
            <div className="field">
              <label>Activity events tab</label>
              <input
                className="input"
                value={config.activityEventsTab}
                onChange={(event) => setConfig((value) => ({ ...value, activityEventsTab: event.target.value }))}
              />
            </div>
          </div>
          <div className="field">
            <label>Zone Dashboard service-account email (optional for now)</label>
            <input
              className="input"
              value={config.allowedWriterEmails.join(', ')}
              onChange={(event) =>
                setConfig((value) => ({
                  ...value,
                  allowedWriterEmails: event.target.value
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                }))
              }
              placeholder="dashboard-bot@project.iam.gserviceaccount.com"
            />
            <div className="hint">
              Only the workbook owner, SheetSmart, and explicitly listed Dashboard accounts may have access.
            </div>
          </div>
          <div className="btn-row">
            <button className="btn" disabled={busy || !config.spreadsheetId.trim()} onClick={saveSource}>
              Save workbook
            </button>
            <button className="btn secondary" disabled={busy || !configured} onClick={initialize}>
              Create missing tabs and headers
            </button>
          </div>
        </div>
      )}

      {activity.length === 0 ? (
        <EmptyState
          title={configured ? 'No captain activity received yet' : 'Connect the private operations workbook'}
          body={
            configured
              ? 'After Zone Dashboard begins writing events, refresh this stream to see additions, deletions, outreach, and follow-up changes.'
              : 'Workbook setup creates a safe bridge between Zone Dashboard and SheetSmart.'
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Activity</th>
                <th>Zone</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {activity.map((item) => (
                <tr key={item.eventId}>
                  <td>{item.summary}</td>
                  <td>{item.zone || '—'}</td>
                  <td>{new Date(item.timestamp).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

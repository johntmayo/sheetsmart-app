import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { FolderCleanupPreviewResponse, QueuedRunResponse } from '../lib/types';
import { ErrorState, Modal } from './ui';

export function FolderCleanupPlaybook() {
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<FolderCleanupPreviewResponse | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [applying, setApplying] = useState(false);
  const [queued, setQueued] = useState<QueuedRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setPreviewing(true);
    setPreview(null);
    setConfirmation('');
    setQueued(null);
    setError(null);
    try {
      setPreview(await api.post<FolderCleanupPreviewResponse>('/folder-cleanup/preview'));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setPreviewing(false);
    }
  }

  async function apply() {
    if (!preview || confirmation !== 'CLEANUP') return;
    setApplying(true);
    setError(null);
    try {
      setQueued(await api.post<QueuedRunResponse>('/folder-cleanup/apply', {
        previewRunId: preview.runId,
        confirmation,
      }));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="card" style={{ borderColor: 'var(--golden-orange)', marginTop: 20 }}>
      <div className="eyebrow">Folder maintenance · approval required</div>
      <h3 style={{ marginTop: 6 }}>Clean legacy columns and field types</h3>
      <p className="reading-copy">
        Audits the master and every captain sheet before removing retired columns, repairing units from the master,
        and standardizing approved dashboard booleans. The scan changes nothing. Any unsafe or ambiguous value blocks
        the whole cleanup.
      </p>
      <button className="btn highlight" onClick={scan} disabled={previewing}>
        {previewing ? 'Auditing every sheet…' : 'Preview folder cleanup'}
      </button>
      {error && <div style={{ marginTop: 12 }}><ErrorState message={error} /></div>}

      {preview && (
        <Modal title="Review folder-wide cleanup" onClose={() => setPreview(null)} wide>
          <div className={preview.canApply ? 'callout' : 'callout warn'}>
            <strong>
              {preview.canApply
                ? `${preview.totals.sheetsChanging} sheet(s) are ready for a snapshotted cleanup.`
                : 'Nothing can be approved until every block and read error is resolved.'}
            </strong>
            <div style={{ marginTop: 6 }}>
              House and Street are removed from master and captains only after canonical address checks. Retired sales
              fields are removed from captains only.
            </div>
          </div>
          <div className="card-grid" style={{ marginTop: 16 }}>
            <Metric value={preview.totals.columnsDeleted} label="Columns removed" />
            <Metric value={preview.totals.booleansStandardized} label="Booleans standardized" />
            <Metric value={preview.totals.unitsRepaired} label="Captain units repaired" />
            <Metric value={preview.totals.blocks + preview.readErrors.length} label="Blocking issues" alert />
          </div>

          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Sheet</th>
                  <th>Columns removed</th>
                  <th className="num">Booleans</th>
                  <th className="num">Units</th>
                  <th>Unit format</th>
                  <th>Safety result</th>
                </tr>
              </thead>
              <tbody>
                {preview.sheets.map((sheet) => (
                  <tr key={`${sheet.role}-${sheet.spreadsheetName}`}>
                    <td>
                      <strong>{sheet.spreadsheetName}</strong>
                      <div className="card-meta">{sheet.role === 'master' ? 'Master' : 'Captain'} · {sheet.tabName}</div>
                    </td>
                    <td>{sheet.columnsToDelete.join(', ') || 'None'}</td>
                    <td className="num">{sheet.booleansToStandardize}</td>
                    <td className="num">{sheet.unitsToRepair}</td>
                    <td>{sheet.formatUnitAsText ? 'Set full column to text' : 'Column not present'}</td>
                    <td>
                      {sheet.blocks.length === 0 ? (
                        sheet.cellChanges.length > 0 ? (
                          <details>
                            <summary style={{ cursor: 'pointer' }}><span className="card-meta">Ready · exact cells</span></summary>
                            {sheet.cellChanges.map((change) => (
                              <div className="card-meta" key={`${change.row}-${change.column}`}>
                                Row {change.row}, {change.column}: {change.action}
                              </div>
                            ))}
                          </details>
                        ) : <span className="card-meta">Ready</span>
                      ) : (
                        <details>
                          <summary style={{ cursor: 'pointer' }}><strong>{sheet.blocks.length} block(s)</strong></summary>
                          {sheet.blocks.map((block, index) => (
                            <div className="card-meta" key={`${block.code}-${block.row || 0}-${index}`}>
                              {block.column ? `${block.column}: ` : ''}
                              {block.message}
                              {block.row ? ` (row ${block.row})` : ''}
                            </div>
                          ))}
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.readErrors.length > 0 && (
            <div className="callout warn" style={{ marginTop: 16 }}>
              {preview.readErrors.map((item) => <div key={item.spreadsheet}>{item.spreadsheet}: {item.reason}</div>)}
            </div>
          )}
          {!queued && preview.canApply && (
            <div className="card" style={{ marginTop: 18 }}>
              <label className="reading-copy" htmlFor="cleanup-confirmation">
                Type <strong>CLEANUP</strong> to approve exactly this preview. Every sheet is re-read before any write,
                changed atomically per spreadsheet, and can be conservatively undone from Runs.
              </label>
              <input
                id="cleanup-confirmation"
                className="input"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                style={{ marginTop: 8, maxWidth: 220 }}
              />
            </div>
          )}
          {queued && (
            <div className="callout info" style={{ marginTop: 18 }}>
              Cleanup run <strong>#{queued.runId}</strong> is queued. Follow it and use Undo from the{' '}
              <a href="/runs">Runs page</a>.
            </div>
          )}
          <div className="btn-row" style={{ marginTop: 18 }}>
            <button className="btn secondary" onClick={() => setPreview(null)}>Close</button>
            {preview.canApply && !queued && (
              <button className="btn highlight" onClick={apply} disabled={confirmation !== 'CLEANUP' || applying}>
                {applying ? 'Starting cleanup…' : 'Run approved cleanup'}
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Metric({ value, label, alert }: { value: number; label: string; alert?: boolean }) {
  return (
    <div className="card">
      <div className="metric" style={alert && value > 0 ? { color: 'var(--rosy-copper)' } : undefined}>
        {value.toLocaleString()}
      </div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { FolderReconcilePreviewResponse, QueuedRunResponse } from '../lib/types';
import { ErrorState, Modal } from './ui';

export function FolderReconcilePlaybook() {
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<FolderReconcilePreviewResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState('');
  const [applying, setApplying] = useState(false);
  const [queued, setQueued] = useState<QueuedRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setPreviewing(true);
    setPreview(null);
    setSelected(new Set());
    setConfirmation('');
    setQueued(null);
    setError(null);
    try {
      setPreview(await api.post<FolderReconcilePreviewResponse>('/folder-reconcile/preview'));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setPreviewing(false);
    }
  }

  function toggle(addressId: string) {
    const next = new Set(selected);
    if (next.has(addressId)) next.delete(addressId);
    else if (next.size < 500) next.add(addressId);
    setSelected(next);
  }

  async function apply() {
    if (!preview || selected.size === 0 || confirmation !== 'APPLY') return;
    setApplying(true);
    setError(null);
    try {
      setQueued(
        await api.post<QueuedRunResponse>('/folder-reconcile/apply', {
          previewRunId: preview.runId,
          addressIds: [...selected],
          confirmation,
        })
      );
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setApplying(false);
    }
  }

  const sensitiveAddressCount =
    preview?.moves.filter((move) => move.residents.some((resident) => resident.sensitiveData.length > 0)).length || 0;

  return (
    <div className="card" style={{ borderColor: 'var(--golden-orange)', marginTop: 20 }}>
      <div className="eyebrow">Live update · after zone boundaries change</div>
      <h3 style={{ marginTop: 6 }}>Move residents when zone boundaries change</h3>
      <p className="reading-copy">
        Scans the master and every captain sheet, computes each address’s zone from Mapbox, and groups all residents at
        that address into one move. Nothing changes during the scan.
      </p>
      <button className="btn highlight" onClick={scan} disabled={previewing}>
        {previewing ? 'Scanning the full folder…' : 'Scan for boundary changes'}
      </button>
      {error && <div style={{ marginTop: 12 }}><ErrorState message={error} /></div>}

      {preview && (
        <Modal title="Review Mapbox boundary changes" onClose={() => setPreview(null)} wide>
          <div className="callout">
            <strong>
              {preview.impact.addressesToMove} address(es), containing {preview.impact.residentsToMove} resident row(s),
              would be assigned or moved.
            </strong>
            <div style={{ marginTop: 6 }}>
              Scanned {preview.impact.sheetsScanned} captain sheets. Select the addresses you approve before anything
              changes.
            </div>
          </div>
          <div className="card-grid" style={{ marginTop: 16 }}>
            <Metric value={preview.impact.addressesToMove} label="Addresses to move" />
            <Metric value={preview.impact.residentsToMove} label="Resident rows" />
            <Metric value={preview.impact.blockedAddresses} label="Addresses skipped (data problems)" alert />
            <Metric value={preview.unassignedAddresses} label="On map but not in any zone" />
            <Metric value={sensitiveAddressCount} label="Addresses with private info" alert />
          </div>

          {(preview.registryErrors.length > 0 || preview.readErrors.length > 0) && (
            <div className="callout warn" style={{ marginTop: 16 }}>
              Fix these problems first. Each zone needs exactly one captain sheet that SheetSmart can read.
              {[...preview.registryErrors, ...preview.readErrors.map((item) => `${item.spreadsheet}: ${item.reason}`)].map(
                (message) => <div key={message}>{message}</div>
              )}
            </div>
          )}

          {preview.moves.length > 0 && (
            <>
            <div className="btn-row" style={{ marginTop: 16 }}>
              <button
                className="btn secondary small"
                onClick={() => setSelected(new Set(preview.moves.slice(0, 500).map((move) => move.addressId)))}
                disabled={Boolean(queued)}
              >
                Select all proposed
              </button>
              <button className="btn secondary small" onClick={() => setSelected(new Set())} disabled={Boolean(queued)}>
                Clear selection
              </button>
            </div>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th />
                    <th>Address</th>
                    <th>Before</th>
                    <th>After</th>
                    <th>Residents moving together</th>
                    <th>Private fields on this move</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.moves.map((move) => (
                    <tr key={move.addressId}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(move.addressId)}
                          onChange={() => toggle(move.addressId)}
                          disabled={Boolean(queued) || (!selected.has(move.addressId) && selected.size >= 500)}
                          aria-label={`Select address ${move.displayAddress || move.addressId}`}
                        />
                      </td>
                      <td>
                        <strong>{move.displayAddress || 'Address not displayed'}</strong>
                        <div className="card-meta mono">{move.addressId}</div>
                      </td>
                      <td>
                        {move.kind === 'assign' ? 'Wasn’t in any zone' : move.fromZone}
                        <div className="card-meta">{move.fromSpreadsheetName || 'Not on a captain sheet'}</div>
                      </td>
                      <td>
                        {move.toZone}
                        <div className="card-meta">{move.toSpreadsheetName}</div>
                      </td>
                      <td>
                        {move.residents.map((resident) => resident.residentName || resident.residentId).join(' · ')}
                        <div className="card-meta">{move.residents.length} row(s)</div>
                      </td>
                      <td style={{ minWidth: 260 }}>
                        {move.residents.some((resident) => resident.sensitiveData.length > 0) ? (
                          <details>
                            <summary style={{ cursor: 'pointer' }}>
                              <strong>Sensitive fields present</strong>
                            </summary>
                            {move.residents
                              .filter((resident) => resident.sensitiveData.length > 0)
                              .map((resident) => (
                                <div key={resident.residentId} style={{ marginTop: 8 }}>
                                  <strong>{resident.residentName || resident.residentId}</strong>
                                  {resident.sensitiveData.map((item) => (
                                    <div className="card-meta" key={`${resident.residentId}-${item.field}`}>
                                      {item.field}: {item.value}
                                    </div>
                                  ))}
                                </div>
                              ))}
                          </details>
                        ) : (
                          <span className="card-meta">No populated sensitive fields</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}

          {preview.blocked.length > 0 && (
            <details style={{ marginTop: 16 }}>
              <summary className="reading-copy" style={{ cursor: 'pointer' }}>
                Review {preview.blocked.length} skipped address data issue(s)
              </summary>
              {preview.blocked.slice(0, 50).map((item) => (
                <div className="card-meta" key={`${item.addressId}-${item.reason}`}>
                  {item.addressId || 'Missing address_id'}: {item.reason}
                </div>
              ))}
            </details>
          )}

          {!queued && preview.canApply && selected.size > 0 && (
            <div className="card" style={{ marginTop: 18 }}>
              <label className="reading-copy" htmlFor="reconcile-confirmation">
                Type <strong>APPLY</strong> to approve reconciling these {selected.size} address(es) on the real master
                and captain sheets. The run is snapshotted and undoable from Runs.
              </label>
              <input
                id="reconcile-confirmation"
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
              Reconciliation run <strong>#{queued.runId}</strong> is queued. Watch it and use Undo from the{' '}
              <a href="/runs">Runs page</a>.
            </div>
          )}
          <div className="btn-row" style={{ marginTop: 18 }}>
            <button className="btn secondary" onClick={() => setPreview(null)}>Close</button>
            {!queued && preview.canApply && (
              <button
                className="btn highlight"
                onClick={apply}
                disabled={selected.size === 0 || confirmation !== 'APPLY' || applying}
              >
                {applying ? 'Starting reconciliation…' : `Reconcile ${selected.size} approved address(es)`}
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

import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { QueuedRunResponse, ZoneSheetsPreviewResponse } from '../lib/types';
import { ErrorState, Modal } from './ui';

export function ZoneSheetsPlaybook() {
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ZoneSheetsPreviewResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState('');
  const [applying, setApplying] = useState(false);
  const [queued, setQueued] = useState<QueuedRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setPreviewing(true);
    setPreview(null);
    setQueued(null);
    setConfirmation('');
    setError(null);
    try {
      const result = await api.post<ZoneSheetsPreviewResponse>('/zone-sheets/preview');
      setPreview(result);
      setSelected(new Set(result.zones.slice(0, 25).map((zone) => zone.zone)));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setPreviewing(false);
    }
  }

  function toggle(zone: string) {
    const next = new Set(selected);
    if (next.has(zone)) next.delete(zone);
    else if (next.size < 25) next.add(zone);
    setSelected(next);
  }

  async function apply() {
    if (!preview || selected.size === 0 || confirmation !== 'CREATE') return;
    setApplying(true);
    setError(null);
    try {
      setQueued(
        await api.post<QueuedRunResponse>('/zone-sheets/apply', {
          previewRunId: preview.runId,
          zones: [...selected],
          confirmation,
        })
      );
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="card" style={{ borderColor: 'var(--golden-orange)', marginTop: 20 }}>
      <div className="eyebrow">Step 1 after creating a new map zone</div>
      <h3 style={{ marginTop: 6 }}>Create sheets for new Mapbox zones</h3>
      <p className="reading-copy">
        Creates an empty captain sheet for each new Mapbox zone, using an existing sheet for its column layout and
        dropdown rules. Then use the boundary-change workflow below to move residents into it.
      </p>
      <button className="btn highlight" onClick={scan} disabled={previewing}>
        {previewing ? 'Checking Mapbox and captain sheets…' : 'Find zones that need a captain sheet'}
      </button>
      {error && <div style={{ marginTop: 12 }}><ErrorState message={error} /></div>}

      {preview && (
        <Modal title="Create missing captain-zone sheets" onClose={() => setPreview(null)} wide>
          <div className="callout">
            <strong>
              {preview.impact.zones} empty formatted zone sheet(s) would be created. The next boundary reconciliation
              would move {preview.impact.addresses} address(es) and {preview.impact.residents} resident row(s) into them.
            </strong>
            <div style={{ marginTop: 6 }}>
              Column layout and dropdown rules will be copied from <strong>{preview.templateSpreadsheetName}</strong>.
            </div>
          </div>
          {(preview.errors.length > 0 || preview.readErrors.length > 0) && (
            <div className="callout warn" style={{ marginTop: 16 }}>
              Fix these problems before creating sheets:
              {[...preview.errors, ...preview.readErrors.map((item) => `${item.spreadsheet}: ${item.reason}`)].map(
                (message) => <div key={message}>{message}</div>
              )}
            </div>
          )}
          {preview.zones.length > 25 && (
            <div className="callout info" style={{ marginTop: 16 }}>
              You can create up to 25 zone sheets per run. The first 25 are selected; create those, then scan again for
              the remaining zones.
            </div>
          )}
          {preview.zones.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 16 }}>
              <table className="data">
                <thead>
                  <tr>
                    <th />
                    <th>New zone</th>
                    <th>Spreadsheet name</th>
                    <th>Captain</th>
                    <th>Addresses</th>
                    <th>Residents</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.zones.map((zone) => (
                    <tr key={zone.zone}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(zone.zone)}
                          onChange={() => toggle(zone.zone)}
                          disabled={Boolean(queued) || (!selected.has(zone.zone) && selected.size >= 25)}
                        />
                      </td>
                      <td><strong>{zone.zone}</strong></td>
                      <td>{zone.fileName}</td>
                      <td>{zone.destinationFields['NC Name'] || 'No captain name in Mapbox'}</td>
                      <td>{zone.addresses.length}</td>
                      <td>{zone.residents.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!queued && preview.canApply && selected.size > 0 && (
            <div className="card" style={{ marginTop: 18 }}>
              <label className="reading-copy" htmlFor="zone-sheet-confirmation">
                Type <strong>CREATE</strong> to create {selected.size} spreadsheet(s) in the real captain folder as
                empty destinations. Undo will move unchanged created files to Drive Trash; files edited afterward are
                preserved.
              </label>
              <input
                id="zone-sheet-confirmation"
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
              Zone-sheet creation run <strong>#{queued.runId}</strong> is queued. Follow it from the{' '}
              <a href="/runs">Runs page</a>.
            </div>
          )}
          {!preview.canApply && preview.zones.length === 0 && (
            <div className="callout info" style={{ marginTop: 18 }}>
              Every Mapbox zone containing a master address already has a captain spreadsheet.
            </div>
          )}
          <div className="btn-row" style={{ marginTop: 18 }}>
            <button className="btn secondary" onClick={() => setPreview(null)}>Close</button>
            {!queued && preview.canApply && (
              <button
                className="btn highlight"
                onClick={apply}
                disabled={selected.size === 0 || selected.size > 25 || confirmation !== 'CREATE' || applying}
              >
                {applying ? 'Creating sheets…' : `Create ${selected.size} zone sheet(s)`}
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

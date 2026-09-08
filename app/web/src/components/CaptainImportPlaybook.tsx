import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { CaptainImportPreviewResponse, QueuedRunResponse } from '../lib/types';
import { ErrorState, Modal } from './ui';

export function CaptainImportPlaybook() {
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<CaptainImportPreviewResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState('');
  const [applying, setApplying] = useState(false);
  const [loadingPrevious, setLoadingPrevious] = useState(false);
  const [queued, setQueued] = useState<QueuedRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function showPreview(result: CaptainImportPreviewResponse) {
    setPreview(result);
    setSelected(
      new Set(result.addresses.filter((address) => address.risk === 'none').map((address) => address.addressId))
    );
  }

  async function openPrevious() {
    setLoadingPrevious(true);
    setError(null);
    try {
      showPreview(await api.get<CaptainImportPreviewResponse>('/captain-import/latest-preview'));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setLoadingPrevious(false);
    }
  }

  async function scan() {
    setPreviewing(true);
    setPreview(null);
    setSelected(new Set());
    setConfirmation('');
    setQueued(null);
    setError(null);
    try {
      const result = await api.post<CaptainImportPreviewResponse>('/captain-import/preview');
      showPreview(result);
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
        await api.post<QueuedRunResponse>('/captain-import/apply', {
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

  const selectedResidents =
    preview?.addresses
      .filter((address) => selected.has(address.addressId))
      .reduce(
        (sum, address) => sum + address.residents.filter((resident) => !resident.addressPlaceholder).length,
        0
      ) || 0;
  const selectedPlaceholders =
    preview?.addresses
      .filter((address) => selected.has(address.addressId))
      .reduce(
        (sum, address) => sum + address.residents.filter((resident) => resident.addressPlaceholder).length,
        0
      ) || 0;
  const selectedWarnings =
    preview?.addresses.filter((address) => selected.has(address.addressId) && address.risk !== 'none').length || 0;
  const safeAddresses = preview?.impact.safeAddresses ??
    preview?.addresses.filter((address) => address.risk === 'none').length ?? 0;
  const safeResidents = preview?.impact.safeResidents ??
    preview?.addresses
      .filter((address) => address.risk === 'none')
      .reduce(
        (sum, address) => sum + address.residents.filter((resident) => !resident.addressPlaceholder).length,
        0
      ) ?? 0;
  const warnedResidents = preview?.impact.warnedResidents ??
    preview?.addresses
      .filter((address) => address.risk !== 'none')
      .reduce(
        (sum, address) => sum + address.residents.filter((resident) => !resident.addressPlaceholder).length,
        0
      ) ?? 0;

  return (
    <div className="card" style={{ borderColor: 'var(--golden-orange)', marginTop: 20 }}>
      <div className="eyebrow">Live update · new people and addresses from captains</div>
      <h3 style={{ marginTop: 6 }}>Add captains’ new records to the master</h3>
      <p className="reading-copy">
        Scans every captain sheet for people and address placeholders missing from the master, grouped by address.
        The scan makes no changes. Rows with unclear identities or incomplete addresses are set aside for review.
      </p>
      <div className="btn-row">
        <button className="btn highlight" onClick={scan} disabled={previewing || loadingPrevious}>
          {previewing ? 'Scanning every captain sheet…' : 'Scan for captain additions'}
        </button>
        <button className="btn secondary" onClick={openPrevious} disabled={previewing || loadingPrevious}>
          {loadingPrevious ? 'Opening…' : 'Open last scan'}
        </button>
      </div>
      {error && <div style={{ marginTop: 12 }}><ErrorState message={error} /></div>}

      {preview && (
        <Modal title="Review captain-added residents" onClose={() => setPreview(null)} wide>
          <div className="callout">
            <strong>
              Currently selected: {selectedResidents} resident(s) and {selectedPlaceholders} address placeholder(s) at{' '}
              {selected.size} address(es).
            </strong>
            <div style={{ marginTop: 6 }}>
              {safeResidents} residents at {safeAddresses} addresses have no duplicate warnings and are selected by
              default. {warnedResidents} residents at {preview.impact.warnedAddresses} addresses need duplicate review
              and are not selected. {preview.impact.blockedAddresses} addresses cannot be imported until their data is fixed.
            </div>
            <div style={{ marginTop: 6 }}>
              Overall, the scan found {preview.impact.residents} residents and {preview.impact.placeholders} address
              placeholders at {preview.impact.addresses} reviewable addresses: {preview.impact.newAddresses} new
              addresses and {preview.impact.existingAddresses} existing master addresses.
            </div>
          </div>
          <div className="card-grid" style={{ marginTop: 16 }}>
            <Metric value={selected.size} label="Addresses currently selected" />
            <Metric value={selectedResidents} label="Residents currently selected" />
            <Metric value={selectedPlaceholders} label="Address placeholders currently selected" />
            <Metric value={preview.impact.warnedAddresses} label="Addresses needing duplicate review" alert />
            <Metric value={warnedResidents} label="Residents needing duplicate review" alert />
            <Metric value={preview.impact.blockedAddresses} label="Addresses blocked (fix data first)" alert />
          </div>

          {(preview.errors.length > 0 || preview.readErrors.length > 0) && (
            <div className="callout warn" style={{ marginTop: 16 }}>
              Fix these first: each captain sheet must be readable, and every row needs a Resident ID and Address ID.
              {[...preview.errors, ...preview.readErrors.map((item) => `${item.spreadsheet}: ${item.reason}`)].map(
                (message) => <div key={message}>{message}</div>
              )}
            </div>
          )}

          {preview.addresses.length > 0 && (
            <>
              <div className="btn-row" style={{ marginTop: 16 }}>
                <button
                  className="btn secondary small"
                  onClick={() => setSelected(new Set(preview.addresses.slice(0, 500).map((address) => address.addressId)))}
                  disabled={Boolean(queued)}
                >
                  Add all warned addresses to selection
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
                      <th>Source</th>
                      <th>Residents added together</th>
                      <th>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.addresses.map((address) => (
                      <tr key={address.addressId}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(address.addressId)}
                            onChange={() => toggle(address.addressId)}
                            disabled={Boolean(queued) || (!selected.has(address.addressId) && selected.size >= 500)}
                            aria-label={`Select address ${address.displayAddress || address.addressId}`}
                          />
                        </td>
                        <td>
                          <strong>{address.displayAddress || 'Address not displayed'}</strong>
                          <div className="card-meta mono">{address.addressId}</div>
                          <div className="card-meta">
                            {address.kind === 'new_address' ? 'New address' : 'Address already exists on master'}
                          </div>
                        </td>
                        <td>
                          {address.sourceSpreadsheetName}
                          <div className="card-meta">{address.sourceZone || 'Zone not detected'}</div>
                        </td>
                        <td>
                          {address.residents.map((resident) => resident.residentName || resident.residentId).join(' · ')}
                          <div className="card-meta">
                            {address.residents.filter((resident) => !resident.addressPlaceholder).length} resident(s)
                            {' · '}
                            {address.residents.filter((resident) => resident.addressPlaceholder).length} address placeholder(s)
                          </div>
                        </td>
                        <td>
                          {address.risk === 'none' ? (
                            <span className="card-meta">Looks new</span>
                          ) : (
                            <>
                              <strong>{address.risk === 'likely' ? 'Likely duplicate' : 'Possible duplicate'}</strong>
                              {address.residents
                                .filter((resident) => resident.risk !== 'none')
                                .map((resident) => (
                                  <div className="card-meta" key={resident.residentId}>{resident.riskReason}</div>
                                ))}
                            </>
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
            <section className="card" style={{ marginTop: 18, background: 'var(--floral-white-warm)' }}>
              <h3 style={{ marginTop: 0 }}>{preview.blocked.length} addresses need repair before import</h3>
              <p className="reading-copy">
                These are excluded from this import. Follow the instruction on each card, then run a fresh scan.
              </p>
              {preview.blocked.slice(0, 100).map((item, index) => (
                <div
                  key={`${item.addressId}-${index}`}
                  style={{ borderTop: '1px solid var(--border-color)', padding: '16px 0' }}
                >
                  <strong>{item.displayAddress || `Blocked row ${index + 1}`}</strong>
                  <div className="reading-copy" style={{ marginTop: 6 }}>
                    {blockedGuidance(item)}
                  </div>
                  {item.sourceSpreadsheetName && (
                    <div style={{ marginTop: 8 }}>
                      <strong>Source:</strong>{' '}
                      {item.sourceSpreadsheetId ? (
                        <a
                          href={`https://docs.google.com/spreadsheets/d/${item.sourceSpreadsheetId}/edit`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open {item.sourceSpreadsheetName}
                        </a>
                      ) : item.sourceSpreadsheetName}
                      {item.sourceRows?.length ? ` — row${item.sourceRows.length === 1 ? '' : 's'} ${item.sourceRows.join(', ')}` : ''}
                    </div>
                  )}
                  {item.code === 'address_id_mismatch' && (
                    <div className="card-meta mono" style={{ marginTop: 8 }}>
                      Captain Address ID: {item.addressId}<br />
                      Master Address ID: {item.masterAddressId || 'More than one possible match'}
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}

          {preview.columnsOnlyOnCaptains.length > 0 && (
            <p className="card-meta">
              Captain-only columns are not copied to the master: {preview.columnsOnlyOnCaptains.join(', ')}
            </p>
          )}

          {!queued && preview.canApply && selected.size > 0 && (
            <div className="card" style={{ marginTop: 18 }}>
              <label className="reading-copy" htmlFor="captain-import-confirmation">
                Type <strong>APPLY</strong> to add {selectedResidents} resident(s) at {selected.size} approved
                address(es) to the real master.
                {selectedWarnings > 0 && <> This includes <strong>{selectedWarnings} duplicate warning(s)</strong>.</>}
                {' '}The run is snapshotted and undoable from Runs.
              </label>
              <input
                id="captain-import-confirmation"
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
              Captain import run <strong>#{queued.runId}</strong> is queued. Watch it and use Undo from the{' '}
              <a href="/runs">Runs page</a>.
            </div>
          )}
          {!preview.canApply && preview.addresses.length === 0 && (
            <div className="callout info" style={{ marginTop: 18 }}>
              No importable captain-added people or address placeholders were found.
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
                {applying ? 'Starting import…' : `Import ${selectedResidents} approved resident(s)`}
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function blockedGuidance(item: CaptainImportPreviewResponse['blocked'][number]): string {
  if (item.code === 'address_id_mismatch' && item.masterAddressId) {
    return `Correct fix: keep the master Address ID. In the captain spreadsheet, replace the captain Address ID with ${item.masterAddressId}. Do not change the master.`;
  }
  if (item.code === 'address_id_mismatch') {
    return 'This address matches more than one master record. Review the matching master households before changing any Address ID.';
  }
  if (item.code === 'missing_address_id') {
    return 'This captain row has no Address ID. Open the source row and determine whether it belongs to an existing master address or is genuinely new.';
  }
  if (item.code === 'duplicate_resident') {
    return 'The same Resident ID appears more than once. Keep the correct row and remove or correct the duplicate before importing.';
  }
  if (item.code === 'split_across_sheets') {
    return 'This household appears in multiple captain spreadsheets. Determine the correct zone before importing it.';
  }
  return item.reason;
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

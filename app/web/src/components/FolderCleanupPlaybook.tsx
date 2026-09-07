import { useEffect, useState } from 'react';
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
  const blockedSheets = preview?.sheets.filter((sheet) => sheet.blocks.length > 0) || [];

  useEffect(() => {
    void api.get<FolderCleanupPreviewResponse>('/folder-cleanup/latest-preview')
      .then(setPreview)
      .catch(() => undefined);
  }, []);

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
        standardizing approved dashboard booleans, and protecting private note fields as literal plain text. The scan
        changes nothing. Any unsafe or ambiguous value blocks the whole cleanup.
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
            <Metric value={preview.totals.noteFormulasNeutralized || 0} label="Formula-like notes made safe" />
            <Metric value={preview.totals.noteColumnsFormatted || 0} label="Private note columns protected" />
            <Metric value={preview.totals.blocks + preview.readErrors.length} label="Blocking issues" alert />
          </div>

          {blockedSheets.length > 0 && (
            <section className="card" style={{ marginTop: 18, background: 'var(--floral-white-warm)' }}>
              <h3 style={{ marginTop: 0 }}>What needs attention</h3>
              <p className="reading-copy">
                Cleanup has not changed anything. Open each spreadsheet below to see exactly why it was stopped.
              </p>
              {blockedSheets.map((sheet) => (
                <details
                  key={`issues-${sheet.role}-${sheet.spreadsheetName}`}
                  style={{ borderTop: '1px solid var(--border-color)', padding: '12px 0' }}
                >
                  <summary style={{ cursor: 'pointer', fontWeight: 700 }}>
                    {sheet.spreadsheetName} — {sheet.blocks.length} {sheet.blocks.length === 1 ? 'issue' : 'issues'}
                  </summary>
                  <div style={{ padding: '8px 0 0 22px', maxWidth: 820 }}>
                    {sheet.spreadsheetId && (
                      <a
                        href={`https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: 'inline-block', marginBottom: 12 }}
                      >
                        Open this spreadsheet
                      </a>
                    )}
                    {sheet.blocks.map((block, index) => (
                      <div key={`${block.code}-${block.row || 0}-${index}`} style={{ marginBottom: 14 }}>
                        <strong>{issueLabel(block.code, block.message)}</strong>
                        <div className="reading-copy" style={{ marginTop: 2 }}>
                          {issueExplanation(block.code, block.message)}
                          {block.row ? ` Check row ${block.row}${block.column ? `, column ${block.column}` : ''}.` : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </section>
          )}

          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Sheet</th>
                  <th>Columns removed</th>
                  <th className="num">Booleans</th>
                  <th className="num">Units</th>
                  <th>Unit format</th>
                  <th>Private notes</th>
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
                      {(sheet.noteColumnsFormatted?.length || 0) > 0
                        ? `${sheet.noteColumnsFormatted.length} columns protected${
                            sheet.noteFormulasNeutralized ? ` · ${sheet.noteFormulasNeutralized} formulas made literal` : ''
                          }`
                        : 'No note columns found'}
                    </td>
                    <td>
                      {sheet.blocks.length === 0 ? (
                        <span className="card-meta">Ready</span>
                      ) : (
                        <strong style={{ color: 'var(--rosy-copper)' }}>
                          Stopped — see issues above
                        </strong>
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

function issueLabel(code: string, message: string): string {
  if (code === 'structural_dependency' && /formula/i.test(message)) return 'Formula may depend on a removed column';
  if (code === 'unit_authority_blocked') return 'Master contains conflicting unit values';
  if (code === 'unsafe_master_unit') return 'Unit value may have been converted by Google Sheets';
  if (code === 'invalid_boolean') return 'Boolean field contains an unexpected value';
  if (code === 'blank_canonical_address') return 'Canonical address information is missing';
  if (code === 'unit_authority_missing') return 'Captain address is not connected to the master yet';
  if (code === 'blank_address_id') return 'Captain row is missing its Address ID';
  return 'Safety check stopped this spreadsheet';
}

function issueExplanation(code: string, message: string): string {
  if (code === 'unit_authority_missing') {
    return 'This row’s Address ID does not exist in the master. Usually, a captain added the address. Run “Scan for captain additions” before returning to cleanup.';
  }
  if (code === 'blank_address_id') {
    return 'SheetSmart cannot connect this row to a household until it has an Address ID.';
  }
  return message;
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

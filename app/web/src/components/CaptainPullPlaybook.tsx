import { useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { ErrorState, StatusPill } from './ui';
import { useToast } from './Toast';

interface PullFolderSheet {
  spreadsheetId: string;
  spreadsheetName: string;
  url: string;
  fills: number;
  overwrites: number;
  conflicts: number;
  unmatched: number;
  errors: string[];
}

interface PullFolderPreview {
  runId: number;
  impact: {
    headline: string;
    detail: string;
    fills: number;
    overwrites: number;
    conflicts: number;
    unmatchedResidents: number;
    sheetsAffected: number;
    sheetsScanned: number;
    readErrors: number;
    sheetsWithWrites: number;
  };
  sheets: PullFolderSheet[];
  readErrors: Array<{ spreadsheet: string; reason: string }>;
  canApply: boolean;
}

export function CaptainPullPlaybook() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PullFolderPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const sheetsWithWork = useMemo(
    () =>
      preview?.sheets.filter(
        (sheet) =>
          (sheet.fills > 0 || sheet.overwrites > 0 || sheet.conflicts > 0) && sheet.errors.length === 0
      ) || [],
    [preview]
  );

  async function scan() {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const response = await api.post<PullFolderPreview>('/captain-pull/preview');
      setPreview(response);
      setSelected(
        new Set(
          response.sheets
            .filter((sheet) => sheet.fills > 0 || sheet.overwrites > 0 || sheet.conflicts > 0)
            .map((sheet) => sheet.spreadsheetId)
        )
      );
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview || selected.size === 0) return;
    const cellsSelected = preview.sheets
      .filter((sheet) => selected.has(sheet.spreadsheetId))
      .reduce((sum, sheet) => sum + sheet.fills + sheet.overwrites, 0);
    const conflictsSelected = preview.sheets
      .filter((sheet) => selected.has(sheet.spreadsheetId))
      .reduce((sum, sheet) => sum + sheet.conflicts, 0);
    if (
      !confirm(
        cellsSelected > 0
          ? `Bring ${cellsSelected.toLocaleString()} captain edit(s) into the master from ${selected.size} captain sheet${selected.size === 1 ? '' : 's'}? Disagreements will be logged to the Conflict inbox instead of overwriting silently. You can undo cell writes from Runs.`
          : `Log ${Math.max(conflictsSelected, preview.impact.conflicts).toLocaleString()} disagreement(s) to the Conflict inbox from ${selected.size} captain sheet${selected.size === 1 ? '' : 's'}? No cells will be written.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ runId: number }>('/captain-pull/apply', {
        previewRunId: preview.runId,
        spreadsheetIds: [...selected],
        confirmed: true,
      });
      toast(`Captain pull queued as run #${result.runId}`, 'success');
      setPreview(null);
      setSelected(new Set());
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const cellsSelected = preview
    ? preview.sheets
        .filter((sheet) => selected.has(sheet.spreadsheetId))
        .reduce((sum, sheet) => sum + sheet.fills + sheet.overwrites, 0)
    : 0;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="eyebrow">Live captains → master</div>
      <h3>Pull captain edits into the master</h3>
      <p className="reading-copy">
        Scans the live master and every captain sheet in your folder. Matches people by{' '}
        <span className="mono">resident_id</span>, fills blank master cells from captain values, and replaces existing
        values only where a field is set to overwrite in Fields. Disagreements go to the{' '}
        <a href="/conflicts">Conflict inbox</a> — never a silent overwrite. People who exist only on captain sheets are
        left alone; use Captain Import for those.
      </p>
      <div className="btn-row">
        <button className="btn highlight" disabled={busy} onClick={scan}>
          {busy ? 'Scanning master and captain sheets…' : 'Scan captain sheets for master updates'}
        </button>
      </div>
      {error && <ErrorState message={error} />}
      {preview && (
        <>
          <div className="callout" style={{ marginTop: 16 }}>
            <strong>{preview.impact.headline}</strong>
            <div style={{ marginTop: 6 }}>{preview.impact.detail}</div>
          </div>
          <div className="card-grid" style={{ marginTop: 16 }}>
            <Metric value={preview.impact.fills} label="Blank cells to fill" />
            <Metric value={preview.impact.overwrites} label="Approved overwrites" alert />
            <Metric value={preview.impact.conflicts} label="Conflicts to log" alert />
            <Metric value={preview.impact.unmatchedResidents} label="Unmatched (Captain Import)" />
            <Metric value={preview.impact.sheetsScanned} label="Captain sheets scanned" />
          </div>
          {preview.readErrors.length > 0 && (
            <div className="callout warn" style={{ marginTop: 16 }}>
              <strong>{preview.readErrors.length} captain sheet(s) could not be read.</strong> Fix those problems and
              scan again.
            </div>
          )}
          {sheetsWithWork.length > 0 && (
            <>
              <div className="section-head" style={{ marginTop: 18 }}>
                <h3>Captain sheets with edits</h3>
                <div className="spacer" />
                <span className="pill neutral">{cellsSelected.toLocaleString()} cells selected</span>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th />
                      <th>Captain sheet</th>
                      <th className="num">Fill blanks</th>
                      <th className="num">Replace</th>
                      <th className="num">Conflicts</th>
                      <th className="num">Unmatched</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheetsWithWork.map((sheet) => (
                      <tr key={sheet.spreadsheetId}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(sheet.spreadsheetId)}
                            onChange={() => toggle(sheet.spreadsheetId)}
                            aria-label={`Select ${sheet.spreadsheetName}`}
                          />
                        </td>
                        <td>
                          {sheet.url ? (
                            <a href={sheet.url} target="_blank" rel="noreferrer">
                              {sheet.spreadsheetName}
                            </a>
                          ) : (
                            sheet.spreadsheetName
                          )}
                        </td>
                        <td className="num">{sheet.fills}</td>
                        <td className="num">{sheet.overwrites}</td>
                        <td className="num">{sheet.conflicts}</td>
                        <td className="num">{sheet.unmatched}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="btn-row" style={{ marginTop: 16 }}>
                <button
                  className="btn"
                  disabled={busy || selected.size === 0 || (!preview.canApply && cellsSelected === 0)}
                  onClick={apply}
                >
                  {cellsSelected > 0
                    ? `Apply ${cellsSelected.toLocaleString()} cell${cellsSelected === 1 ? '' : 's'} from ${selected.size} sheet${selected.size === 1 ? '' : 's'}`
                    : `Log conflicts from ${selected.size} sheet${selected.size === 1 ? '' : 's'}`}
                </button>
                <StatusPill status="approval required" />
              </div>
            </>
          )}
          {!preview.canApply && preview.readErrors.length === 0 && (
            <p className="reading-copy" style={{ marginTop: 16 }}>
              Captain sheets already match the master on every shared field, or only unmatched residents remain.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ value, label, alert = false }: { value: number; label: string; alert?: boolean }) {
  return (
    <div className="card">
      <div className="metric" style={alert && value > 0 ? { color: 'var(--rosy-copper)' } : undefined}>
        {value.toLocaleString()}
      </div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

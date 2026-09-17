import { useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { ErrorState, StatusPill } from './ui';
import { useToast } from './Toast';

type AuditScope = 'captains' | 'master';

interface AuditSheet {
  spreadsheetId: string;
  spreadsheetName: string;
  url: string;
  kind: 'master' | 'captain';
  detectedZone: string;
  fills: number;
  overwrites: number;
  zoneMismatches: number;
  columnsToAdd: string[];
  errors: string[];
}

interface ZoneDrift {
  zoneName: string;
  mapboxName: string;
  mapboxPhone: string;
  mapboxEmail: string;
  sheetZone: string;
  sheetName: string;
  sheetPhone: string;
  sheetEmail: string;
  cellsByColumn: Record<string, number>;
  rowsTouched: number;
  fills: number;
  overwrites: number;
}

interface AuditPreview {
  runId: number;
  scope: AuditScope;
  impact: {
    headline: string;
    detail: string;
    fills: number;
    overwrites: number;
    zoneMismatches: number;
    zoneRenames: number;
    renames: Array<{ from: string; to: string; rows: number }>;
    missingCoords: number;
    unassigned: number;
    multiZone: number;
    sheetsAffected: number;
    sheetsScanned: number;
    zonesWithDrift: number;
  };
  sheets: AuditSheet[];
  zoneDrift: ZoneDrift[];
  readErrors: Array<{ spreadsheet: string; reason: string }>;
  canApply: boolean;
}

const COPY: Record<
  AuditScope,
  { eyebrow: string; title: string; blurb: string; scanIdle: string; scanBusy: string; fillsLabel: string }
> = {
  captains: {
    eyebrow: 'Live Mapbox → captain sheets',
    title: 'Update captain contacts from Mapbox',
    blurb:
      'Compares captain name, phone, and email on every captain sheet with the current Mapbox zone roster. Mapbox wins, even when that means dropping a co-captain the sheet still lists. Rows whose coordinates fall in a different zone than the sheet claims are skipped entirely — a boundary moved, so use the boundary-change playbook for those.',
    scanIdle: 'Scan captain sheets against Mapbox',
    scanBusy: 'Reading Mapbox and every captain sheet…',
    fillsLabel: 'Blank cells to fill',
  },
  master: {
    eyebrow: 'Live Mapbox → master · one-time backfill',
    title: 'Fill zone and captain columns on the master',
    blurb:
      'The master has ZoneName, NC Name, NC Phone, and NC Email columns that were never populated. This fills them from Mapbox for every resident whose coordinates land inside a zone. It is a large one-time job, so it applies in undoable batches — scan again after each batch to see what is left.',
    scanIdle: 'Scan the master against Mapbox',
    scanBusy: 'Reading Mapbox and the master…',
    fillsLabel: 'Blank cells to fill',
  },
};

const DRIFT_FIELDS = [
  { column: 'ZoneName', label: 'Zone name', sheetKey: 'sheetZone', mapboxKey: 'zoneName' },
  { column: 'NC Name', label: 'Captain name', sheetKey: 'sheetName', mapboxKey: 'mapboxName' },
  { column: 'NC Phone', label: 'Phone', sheetKey: 'sheetPhone', mapboxKey: 'mapboxPhone' },
  { column: 'NC Email', label: 'Email', sheetKey: 'sheetEmail', mapboxKey: 'mapboxEmail' },
] as const;

export function MapboxContactAuditPlaybook({ scope = 'captains' }: { scope?: AuditScope }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<AuditPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[scope];

  const sheetsWithWork = useMemo(
    () =>
      preview?.sheets.filter(
        (sheet) =>
          (sheet.fills > 0 || sheet.overwrites > 0 || sheet.columnsToAdd.length > 0) && sheet.errors.length === 0
      ) || [],
    [preview]
  );

  // For captain sheets the useful view is field-level before/after, so a zone
  // that only has a bad phone number does not look like a full rewrite.
  const driftRows = useMemo(() => {
    if (!preview || scope === 'master') return [];
    return preview.zoneDrift.flatMap((zone) =>
      DRIFT_FIELDS.filter((field) => (zone.cellsByColumn[field.column] || 0) > 0).map((field) => ({
        key: `${zone.zoneName}:${field.column}`,
        zoneName: zone.zoneName,
        field: field.label,
        sheetValue: zone[field.sheetKey],
        mapboxValue: zone[field.mapboxKey],
        cells: zone.cellsByColumn[field.column] || 0,
      }))
    );
  }, [preview, scope]);

  async function scan() {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const response = await api.post<AuditPreview>('/mapbox-contact-audit/preview', { scope });
      setPreview(response);
      setSelected(
        new Set(
          response.sheets
            .filter((sheet) => sheet.fills > 0 || sheet.overwrites > 0 || sheet.columnsToAdd.length > 0)
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
    const cells = preview.sheets
      .filter((sheet) => selected.has(sheet.spreadsheetId))
      .reduce((sum, sheet) => sum + sheet.fills + sheet.overwrites, 0);
    const target =
      scope === 'master'
        ? 'the master'
        : `${selected.size} captain sheet${selected.size === 1 ? '' : 's'}`;
    if (
      !confirm(
        cells > 0
          ? `Write ${cells.toLocaleString()} cell(s) from Mapbox to ${target}? Mapbox values replace whatever the sheet says, including co-captains the sheet lists but Mapbox does not. Rows whose zone disagrees with Mapbox are left untouched. You can undo this from Runs.`
          : `Add missing Mapbox columns on ${target}? You can undo this from Runs.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ runId: number }>('/mapbox-contact-audit/apply', {
        previewRunId: preview.runId,
        spreadsheetIds: [...selected],
        confirmed: true,
      });
      toast(`Queued as run #${result.runId}`, 'success');
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
      <div className="eyebrow">{copy.eyebrow}</div>
      <h3>{copy.title}</h3>
      <p className="reading-copy">{copy.blurb}</p>
      <div className="btn-row">
        <button className="btn highlight" disabled={busy} onClick={scan}>
          {busy ? copy.scanBusy : copy.scanIdle}
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
            <Metric value={preview.impact.fills} label={copy.fillsLabel} />
            <Metric value={preview.impact.overwrites} label="Existing values Mapbox replaces" alert />
            <Metric value={preview.impact.zoneRenames} label="Zone labels renamed in place" />
            <Metric
              value={preview.impact.zoneMismatches}
              label="Skipped: resident changed zone"
              alert
            />
          </div>
          {preview.impact.zoneRenames > 0 && (
            <div className="callout" style={{ marginTop: 16 }}>
              <strong>A zone was renamed in Mapbox, not redrawn.</strong>
              <ul style={{ marginTop: 6, marginBottom: 0 }}>
                {preview.impact.renames.map((rename) => (
                  <li key={`${rename.from}->${rename.to}`}>
                    <code>{rename.from}</code> → <code>{rename.to}</code> on {rename.rows.toLocaleString()} row
                    {rename.rows === 1 ? '' : 's'}. Every row with the old label falls inside the new zone, and the old
                    name no longer exists in Mapbox, so nobody moved — the label is corrected in place.
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.impact.zoneMismatches > 0 && (
            <div className="callout warn" style={{ marginTop: 16 }}>
              <strong>
                {preview.impact.zoneMismatches.toLocaleString()} resident
                {preview.impact.zoneMismatches === 1 ? '' : 's'} genuinely changed zone.
              </strong>{' '}
              Their coordinates fall inside a different Mapbox zone, but the rest of their sheet did not move, so a
              boundary was redrawn around them. Nothing is written to those rows here — handle them with "Move
              residents when zone boundaries change".
            </div>
          )}
          {preview.impact.unassigned > 0 && (
            <p className="reading-copy" style={{ marginTop: 12 }}>
              {preview.impact.unassigned.toLocaleString()} resident
              {preview.impact.unassigned === 1 ? '' : 's'} sit outside every Mapbox polygon and get nothing written.
              That is expected for addresses beyond the mapped boundary.
            </p>
          )}
          {preview.readErrors.length > 0 && (
            <div className="callout warn" style={{ marginTop: 16 }}>
              <strong>{preview.readErrors.length} sheet(s) could not be read.</strong> Fix those problems and scan
              again.
            </div>
          )}
          {scope === 'captains' && driftRows.length > 0 && (
            <>
              <div className="section-head" style={{ marginTop: 18 }}>
                <h3>Exactly what changes, by zone</h3>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Zone</th>
                      <th>Field</th>
                      <th>Sheet says today</th>
                      <th>Mapbox says</th>
                      <th className="num">Cells</th>
                    </tr>
                  </thead>
                  <tbody>
                    {driftRows.map((row) => (
                      <tr key={row.key}>
                        <td>{row.zoneName}</td>
                        <td>{row.field}</td>
                        <td style={{ color: 'var(--rosy-copper)' }}>{row.sheetValue || '(blank)'}</td>
                        <td>{row.mapboxValue || '(blank)'}</td>
                        <td className="num">{row.cells.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {scope === 'master' && preview.zoneDrift.length > 0 && (
            <>
              <div className="section-head" style={{ marginTop: 18 }}>
                <h3>What would be written, by zone</h3>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Zone</th>
                      <th>Captain name</th>
                      <th>Phone</th>
                      <th>Email</th>
                      <th className="num">Residents</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.zoneDrift.map((zone) => (
                      <tr key={zone.zoneName}>
                        <td>{zone.zoneName}</td>
                        <td>{zone.mapboxName || '—'}</td>
                        <td>{zone.mapboxPhone || '—'}</td>
                        <td>{zone.mapboxEmail || '—'}</td>
                        <td className="num">{zone.rowsTouched.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {sheetsWithWork.length > 0 && (
            <>
              <div className="section-head" style={{ marginTop: 18 }}>
                <h3>{scope === 'master' ? 'Ready to apply' : 'Captain sheets ready to update'}</h3>
                <div className="spacer" />
                <span className="pill neutral">{cellsSelected.toLocaleString()} cells selected</span>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th />
                      <th>Sheet</th>
                      <th>Zone</th>
                      <th className="num">Fill blanks</th>
                      <th className="num">Replace</th>
                      <th className="num">New cols</th>
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
                          {sheet.kind === 'master' ? <strong>Master · </strong> : null}
                          {sheet.url ? (
                            <a href={sheet.url} target="_blank" rel="noreferrer">
                              {sheet.spreadsheetName}
                            </a>
                          ) : (
                            sheet.spreadsheetName
                          )}
                        </td>
                        <td>{sheet.detectedZone || '—'}</td>
                        <td className="num">{sheet.fills.toLocaleString()}</td>
                        <td className="num">{sheet.overwrites.toLocaleString()}</td>
                        <td className="num">{sheet.columnsToAdd.length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="btn-row" style={{ marginTop: 16 }}>
                <button className="btn" disabled={busy || selected.size === 0} onClick={apply}>
                  {cellsSelected > 0
                    ? `Write ${cellsSelected.toLocaleString()} cell${cellsSelected === 1 ? '' : 's'} from Mapbox`
                    : `Add missing Mapbox columns`}
                </button>
                <StatusPill status="approval required" />
              </div>
            </>
          )}
          {!preview.canApply && preview.readErrors.length === 0 && (
            <p className="reading-copy" style={{ marginTop: 16 }}>
              Nothing to write
              {preview.impact.zoneMismatches > 0
                ? ', aside from rows whose zone boundary moved — those belong in the boundary-change playbook'
                : ''}
              .
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

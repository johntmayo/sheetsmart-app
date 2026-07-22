import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type {
  CellFillImpact,
  CellFillSheet,
  PreviewPlaybook,
  PreviewResponse,
  PushMissingImpact,
  PushMissingSheet,
} from '../lib/types';
import { EmptyState, ErrorState, Modal, SectionHead, Spinner } from '../components/ui';

// Playbooks whose guided dry-run preview isn't wired yet (later phases). Shown so
// the Operator sees the full map of what's coming.
const UPCOMING = [
  { title: 'Bring in what captains have added', engine: 'pull missing rows / pull data ← folder' },
  { title: 'Fix / retire a column everywhere', engine: 'rename / delete (destructive, gated)' },
];

export function Workflows() {
  const { data, loading, error } = useAsync<PreviewPlaybook[]>(() => api.get('/preview/playbooks'));
  const [active, setActive] = useState<PreviewPlaybook | null>(null);
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  const playbooks = data ?? [];

  async function runPreview(p: PreviewPlaybook) {
    setActive(p);
    setResult(null);
    setPreviewError(null);
    setPreviewing(true);
    try {
      const r = await api.post<PreviewResponse>('/preview', { playbook: p.key });
      setResult(r);
    } catch (e) {
      setPreviewError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }

  function close() {
    setActive(null);
    setResult(null);
    setPreviewError(null);
  }

  return (
    <>
      <SectionHead title="Playbooks" />
      <p className="reading-copy" style={{ marginTop: 0 }}>
        Playbooks are the plain-language tasks you run. Each shows a <strong>preview</strong> first — a dry run that
        explains exactly what it would do, in plain English — and never writes anything to a sheet. Live runs (with
        one-click undo) arrive in the next phase.
      </p>

      <div className="card-grid">
        {playbooks.map((p) => (
          <div className="card" key={p.key}>
            <h3>{p.title}</h3>
            <div className="card-meta">Engine: {p.engine}</div>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => runPreview(p)}>
                Preview
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="section-head" style={{ marginTop: 32 }}>
        <h2>Coming next</h2>
      </div>
      <div className="card-grid">
        {UPCOMING.map((p) => (
          <div className="card" key={p.title}>
            <h3>{p.title}</h3>
            <div className="card-meta">Engine: {p.engine}</div>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn secondary small" disabled title="Preview for this playbook is coming in a later step">
                Preview
              </button>
            </div>
          </div>
        ))}
      </div>

      {playbooks.length === 0 && (
        <EmptyState
          title="No previewable playbooks yet"
          body="Connect a master, a captain folder, and a sales source under Sources to preview the core syncs."
        />
      )}

      {active && (
        <Modal title={active.title} onClose={close} wide>
          {previewing && (
            <div className="reading-copy">Reading the sources and working out the impact… this can take a moment.</div>
          )}
          {previewError && <ErrorState message={previewError} />}
          {result && <PreviewBody playbook={active} result={result} />}
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn secondary" onClick={close}>
              Close
            </button>
            <button className="btn" disabled title="Live runs arrive in the next phase (with undo)">
              Run it live
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function PreviewBody({ playbook, result }: { playbook: PreviewPlaybook; result: PreviewResponse }) {
  const isCellFill = playbook.kind === 'cell_fill';
  return (
    <>
      <div className="callout">
        <strong>{result.impact.headline}</strong>
        <div style={{ marginTop: 6 }}>{result.impact.detail}</div>
      </div>

      {isCellFill ? (
        <CellFillMetrics impact={result.impact as CellFillImpact} />
      ) : (
        <PushMissingMetrics impact={result.impact as PushMissingImpact} />
      )}

      {result.impact.errors > 0 && (
        <p className="reading-copy">
          <strong>{result.impact.errors}</strong> sheet(s) reported a problem while reading — see the breakdown below.
        </p>
      )}

      {result.unmatchedFields && result.unmatchedFields.length > 0 && (
        <p className="card-meta">
          Fields present in the source but not found in the target (skipped): {result.unmatchedFields.join(', ')}
        </p>
      )}

      <PreviewSheetTable playbook={playbook} sheets={result.sheets} />
    </>
  );
}

function CellFillMetrics({ impact }: { impact: CellFillImpact }) {
  return (
    <div className="card-grid" style={{ marginTop: 16 }}>
      <Metric value={impact.filled} label="Blank cells filled" />
      <Metric value={impact.conflicts} label="Conflicts flagged" alert={impact.conflicts > 0} />
      <Metric value={impact.overwritten} label="Values replaced" alert={impact.overwritten > 0} />
      <Metric value={impact.columnsToAdd} label="New columns added" />
    </div>
  );
}

function PushMissingMetrics({ impact }: { impact: PushMissingImpact }) {
  return (
    <div className="card-grid" style={{ marginTop: 16 }}>
      <Metric value={impact.appended} label="New residents added" />
      <Metric value={impact.flagged} label="Sensitive rows flagged" alert={impact.flagged > 0} />
      <Metric value={impact.sheetsAffected} label="Sheets affected" />
    </div>
  );
}

function Metric({ value, label, alert }: { value: number; label: string; alert?: boolean }) {
  return (
    <div className="card">
      <div className="metric" style={alert ? { color: 'var(--rosy-copper)' } : undefined}>
        {value.toLocaleString()}
      </div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

function PreviewSheetTable({ playbook, sheets }: { playbook: PreviewPlaybook; sheets: PreviewResponse['sheets'] }) {
  const isCellFill = playbook.kind === 'cell_fill';
  // Show the sheets with something to do first, then the rest.
  const rows = [...sheets].sort((a, b) => weight(b) - weight(a));
  const shown = rows.filter((r) => weight(r) > 0 || r.errors.length > 0);
  const quietCount = rows.length - shown.length;

  if (rows.length === 0) return null;

  return (
    <>
      <div className="section-head" style={{ marginTop: 24 }}>
        <h2>Where the changes land</h2>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            {isCellFill ? (
              <tr>
                <th>Sheet</th>
                <th className="num">Fill</th>
                <th className="num">Conflicts</th>
                <th className="num">Replace</th>
                <th className="num">New cols</th>
                <th>Notes</th>
              </tr>
            ) : (
              <tr>
                <th>Sheet</th>
                <th>Zone</th>
                <th className="num">New residents</th>
                <th className="num">Flagged</th>
                <th>Notes</th>
              </tr>
            )}
          </thead>
          <tbody>
            {shown.map((s, i) =>
              isCellFill ? (
                <tr key={`${s.name}-${i}`}>
                  <td>{link(s)}</td>
                  <td className="num">{(s as CellFillSheet).filled}</td>
                  <td className="num">{(s as CellFillSheet).conflicts}</td>
                  <td className="num">{(s as CellFillSheet).overwritten}</td>
                  <td className="num">{(s as CellFillSheet).columnsToAdd}</td>
                  <td className="truncate">{s.errors.join('; ')}</td>
                </tr>
              ) : (
                <tr key={`${s.name}-${i}`}>
                  <td>{link(s)}</td>
                  <td>{(s as PushMissingSheet).detectedZone || '—'}</td>
                  <td className="num">{(s as PushMissingSheet).appended}</td>
                  <td className="num">{(s as PushMissingSheet).flagged}</td>
                  <td className="truncate">{s.errors.join('; ')}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {quietCount > 0 && (
        <p className="card-meta" style={{ marginTop: 8 }}>
          {quietCount.toLocaleString()} other sheet(s) would see no changes.
        </p>
      )}
    </>
  );
}

function weight(s: PreviewResponse['sheets'][number]): number {
  if ('filled' in s) return s.filled + s.conflicts + s.overwritten + s.columnsToAdd;
  return s.appended + s.flagged;
}

function link(s: { name: string; url: string }) {
  return s.url ? (
    <a href={s.url} target="_blank" rel="noreferrer">
      {s.name}
    </a>
  ) : (
    s.name
  );
}

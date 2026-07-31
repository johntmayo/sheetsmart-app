import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type {
  CellFillImpact,
  CellFillSheet,
  EnrichZonesPreviewResponse,
  MoveCopyTargetResponse,
  MoveResidentsPreviewResponse,
  PreviewPlaybook,
  PreviewResponse,
  QueuedRunResponse,
  SafeCopyPreviewResponse,
  SafeCopyTargetResponse,
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
        explains exactly what it would do, in plain English. The first live playbook is intentionally locked to safe
        copies while its one-click undo is proven.
      </p>

      <SafeCopyPlaybook />
      <EnrichZonesPlaybook />
      <MoveResidentsPlaybook />

      <div className="section-head" style={{ marginTop: 32 }}>
        <h2>Read-only previews</h2>
      </div>
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

const EMPTY_COPY_FORM = {
  masterSpreadsheetId: '',
  masterTab: 'Zones Join 2026-07-29',
  captainSpreadsheetId: '',
  captainTab: 'Sheet1',
  folderId: '',
};

function SafeCopyPlaybook() {
  const { data, loading, error, reload } = useAsync<SafeCopyTargetResponse>(() => api.get('/execution/copy-target'));
  const [configuring, setConfiguring] = useState(false);
  const [form, setForm] = useState(EMPTY_COPY_FORM);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<SafeCopyPreviewResponse | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [queued, setQueued] = useState<QueuedRunResponse | null>(null);

  useEffect(() => {
    if (!data?.target) return;
    setForm({
      masterSpreadsheetId: data.target.masterSpreadsheetId,
      masterTab: data.target.masterTab,
      captainSpreadsheetId: data.target.captainSpreadsheetId,
      captainTab: data.target.captainTab,
      folderId: data.target.folderId,
    });
  }, [data]);

  async function saveTarget() {
    setSaving(true);
    setActionError(null);
    try {
      await api.put('/execution/copy-target', {
        ...form,
        masterSpreadsheetId: googleId(form.masterSpreadsheetId),
        captainSpreadsheetId: googleId(form.captainSpreadsheetId),
        folderId: googleId(form.folderId),
      });
      setConfiguring(false);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function runSafePreview() {
    setPreviewing(true);
    setActionError(null);
    setPreview(null);
    setQueued(null);
    setConfirmed(false);
    try {
      setPreview(await api.post<SafeCopyPreviewResponse>('/execution/push-missing/preview'));
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function applyPreview() {
    if (!preview || !confirmed) return;
    setApplying(true);
    setActionError(null);
    try {
      setQueued(
        await api.post<QueuedRunResponse>('/execution/push-missing/apply', {
          previewRunId: preview.runId,
          confirmed: true,
        })
      );
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  if (loading) return <Spinner />;

  const target = data?.target;
  return (
    <div className="card" style={{ borderColor: 'var(--golden-orange)', marginTop: 20 }}>
      <div className="eyebrow">First reversible live playbook · copies only</div>
      <h3 style={{ marginTop: 6 }}>Add new residents to one copied captain sheet</h3>
      <p className="reading-copy" style={{ marginBottom: 12 }}>
        This is the safety proving ground: preview the exact rows, approve them, add them to one copy, and undo the run
        from the Runs page. SheetSmart will refuse to continue if either copy changes after the preview.
      </p>
      {error && <ErrorState message={error} />}
      {target && !configuring ? (
        <>
          <div className="callout info" style={{ marginBottom: 14 }}>
            <strong>{target.masterName}</strong> · {target.masterTab}
            <br />
            <span aria-hidden="true">↓</span> {target.captainName} · {target.captainTab}
          </div>
          <div className="btn-row">
            <button className="btn highlight" onClick={runSafePreview} disabled={previewing}>
              {previewing ? 'Checking the copies…' : 'Preview safe-copy run'}
            </button>
            <button className="btn secondary small" onClick={() => setConfiguring(true)}>
              Change test copies
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="form-grid" style={{ marginTop: 16 }}>
            <CopyField
              label="Master copy link or ID"
              value={form.masterSpreadsheetId}
              onChange={(value) => setForm({ ...form, masterSpreadsheetId: value })}
            />
            <CopyField
              label="Zone-enriched source tab"
              value={form.masterTab}
              onChange={(value) => setForm({ ...form, masterTab: value })}
            />
            <CopyField
              label="Captain copy link or ID"
              value={form.captainSpreadsheetId}
              onChange={(value) => setForm({ ...form, captainSpreadsheetId: value })}
            />
            <CopyField
              label="Captain tab"
              value={form.captainTab}
              onChange={(value) => setForm({ ...form, captainTab: value })}
            />
            <CopyField
              label="Testing folder link or ID"
              value={form.folderId}
              onChange={(value) => setForm({ ...form, folderId: value })}
            />
          </div>
          <div className="btn-row">
            <button className="btn" onClick={saveTarget} disabled={saving}>
              {saving ? 'Verifying access…' : 'Save and verify copies'}
            </button>
            {target && (
              <button className="btn secondary" onClick={() => setConfiguring(false)}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}
      {actionError && <div className="field-error" style={{ marginTop: 12 }}>{actionError}</div>}

      {preview && (
        <Modal title="Approve additions to the captain copy" onClose={() => setPreview(null)} wide>
          <div className="callout">
            <strong>{preview.impact.headline}</strong>
            <div style={{ marginTop: 6 }}>{preview.impact.detail}</div>
          </div>
          <PushMissingMetrics impact={preview.impact} />
          <p className="reading-copy">
            Destination: <strong>{preview.target.captainName}</strong>, zone{' '}
            <strong>{preview.detectedZone || 'not detected'}</strong>. No existing row will be changed.
          </p>
          {preview.residents.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Resident</th>
                    <th className="mono">resident_id</th>
                    <th>Review note</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.residents.map((resident) => (
                    <tr key={resident.residentId}>
                      <td>{resident.residentName || 'Name not provided'}</td>
                      <td className="mono">{resident.residentId}</td>
                      <td>{resident.flagged ? 'Contains a sensitive field' : 'Ready to add'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!queued && preview.canApply && (
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 18 }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                style={{ marginTop: 4 }}
              />
              <span className="reading-copy">
                I approve these exact additions to the copied captain sheet. I understand the run will be recorded and
                can be undone from Runs.
              </span>
            </label>
          )}
          {queued && (
            <div className="callout info" style={{ marginTop: 18 }}>
              Live run <strong>#{queued.runId}</strong> is queued. Follow its status and use Undo from the{' '}
              <a href="/runs">Runs page</a>.
            </div>
          )}
          {!preview.canApply && (
            <div className="callout info" style={{ marginTop: 18 }}>
              The copied captain sheet is already aligned. There is nothing to approve or write.
            </div>
          )}
          <div className="btn-row" style={{ marginTop: 18 }}>
            <button className="btn secondary" onClick={() => setPreview(null)}>
              Close
            </button>
            {preview.canApply && !queued && (
              <button className="btn highlight" onClick={applyPreview} disabled={!confirmed || applying}>
                {applying ? 'Starting safely…' : 'Add approved rows to copy'}
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function EnrichZonesPlaybook() {
  const { data, loading, error } = useAsync<SafeCopyTargetResponse>(() => api.get('/execution/copy-target'));
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<EnrichZonesPreviewResponse | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [queued, setQueued] = useState<QueuedRunResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function runPreview() {
    setPreviewing(true);
    setActionError(null);
    setPreview(null);
    setQueued(null);
    setConfirmed(false);
    try {
      setPreview(await api.post<EnrichZonesPreviewResponse>('/execution/enrich-zones/preview'));
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function applyPreview() {
    if (!preview || !confirmed) return;
    setApplying(true);
    setActionError(null);
    try {
      setQueued(
        await api.post<QueuedRunResponse>('/execution/enrich-zones/apply', {
          previewRunId: preview.runId,
          confirmed: true,
        })
      );
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  if (loading) return null;
  const target = data?.target;

  return (
    <div className="card" style={{ borderColor: 'var(--golden-orange)', marginTop: 20 }}>
      <div className="eyebrow">Second reversible live playbook · master copy only</div>
      <h3 style={{ marginTop: 6 }}>Enrich zones on the raw master copy</h3>
      <p className="reading-copy" style={{ marginBottom: 12 }}>
        Reads the raw <strong>Master Data File</strong> tab on your master copy, computes ZoneName and captain (NC)
        contacts from Mapbox, and — only after you approve — adds those columns and fills blank cells. Snapshotted and
        undoable. Never writes to production.
      </p>
      {error && <ErrorState message={error} />}
      {!target ? (
        <p className="reading-copy">Configure the safe-copy target above first (same master copy).</p>
      ) : (
        <>
          <div className="callout info" style={{ marginBottom: 14 }}>
            <strong>{target.masterName}</strong> · Master Data File
            <br />
            Fill blanks only · production master is blocked
          </div>
          <div className="btn-row">
            <button className="btn highlight" onClick={runPreview} disabled={previewing}>
              {previewing ? 'Computing enrichment…' : 'Preview zone enrichment'}
            </button>
          </div>
        </>
      )}
      {actionError && (
        <div className="field-error" style={{ marginTop: 12 }}>
          {actionError}
        </div>
      )}

      {preview && (
        <Modal title="Approve zone enrichment on the master copy" onClose={() => setPreview(null)} wide>
          <div className="callout">
            <strong>{preview.impact.headline}</strong>
            <div style={{ marginTop: 6 }}>{preview.impact.detail}</div>
          </div>
          <div className="card-grid" style={{ marginTop: 16 }}>
            <Metric value={preview.impact.columnsToAdd} label="Columns to add" alert={preview.impact.columnsToAdd > 0} />
            <Metric value={preview.impact.cellsToFill} label="Blank cells to fill" />
            <Metric value={preview.impact.residentsTouched} label="Residents touched" />
            <Metric value={preview.impact.unassigned} label="In no zone (left alone)" />
          </div>
          {preview.columnsToAdd.length > 0 && (
            <p className="reading-copy">
              New columns: <strong>{preview.columnsToAdd.join(', ')}</strong> on tab{' '}
              <strong>{preview.enrichmentTab}</strong>.
            </p>
          )}
          {preview.sample.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Resident</th>
                    <th className="mono">resident_id</th>
                    <th>Computed zone</th>
                    <th>Proposed NC values</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((row) => (
                    <tr key={row.residentId}>
                      <td>{row.residentName || '—'}</td>
                      <td className="mono">{row.residentId}</td>
                      <td>{row.computedZone || '—'}</td>
                      <td className="truncate">
                        {[row.values['NC Name'], row.values['NC Phone'], row.values['NC Email']]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!queued && preview.canApply && (
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 18 }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                style={{ marginTop: 4 }}
              />
              <span className="reading-copy">
                I approve filling these blank zone/captain cells on the <strong>master copy only</strong>. The run will
                be recorded and can be undone from Runs. This may take several minutes.
              </span>
            </label>
          )}
          {queued && (
            <div className="callout info" style={{ marginTop: 18 }}>
              Live run <strong>#{queued.runId}</strong> is queued. Follow its status and use Undo from the{' '}
              <a href="/runs">Runs page</a>. Large enrichments can take a few minutes.
            </div>
          )}
          {!preview.canApply && (
            <div className="callout info" style={{ marginTop: 18 }}>
              Nothing to write — the raw master copy already has these values, or no coordinates matched a zone.
            </div>
          )}
          <div className="btn-row" style={{ marginTop: 18 }}>
            <button className="btn secondary" onClick={() => setPreview(null)}>
              Close
            </button>
            {preview.canApply && !queued && (
              <button className="btn highlight" onClick={applyPreview} disabled={!confirmed || applying}>
                {applying ? 'Starting safely…' : 'Enrich approved cells on copy'}
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function MoveResidentsPlaybook() {
  const { data, loading, error, reload } = useAsync<MoveCopyTargetResponse>(() => api.get('/execution/move-target'));
  const [configuring, setConfiguring] = useState(false);
  const [form, setForm] = useState({
    masterSpreadsheetId: '',
    masterTab: 'Zones Join 2026-07-29',
    fromCaptainSpreadsheetId: '',
    fromCaptainTab: 'Sheet1',
    toCaptainSpreadsheetId: '',
    toCaptainTab: 'Sheet1',
    folderId: '',
    fromZoneOverride: '',
    toZoneOverride: '',
  });
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<MoveResidentsPreviewResponse | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [queued, setQueued] = useState<QueuedRunResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.target) {
      setForm({
        masterSpreadsheetId: data.target.masterSpreadsheetId,
        masterTab: data.target.masterTab,
        fromCaptainSpreadsheetId: data.target.fromCaptainSpreadsheetId,
        fromCaptainTab: data.target.fromCaptainTab,
        toCaptainSpreadsheetId: data.target.toCaptainSpreadsheetId,
        toCaptainTab: data.target.toCaptainTab,
        folderId: data.target.folderId,
        fromZoneOverride: data.target.fromZoneOverride || '',
        toZoneOverride: data.target.toZoneOverride || '',
      });
      return;
    }
    if (data?.suggested) {
      setForm((current) => ({
        ...current,
        masterSpreadsheetId: data.suggested!.masterSpreadsheetId,
        masterTab: data.suggested!.masterTab,
        fromCaptainSpreadsheetId: data.suggested!.fromCaptainSpreadsheetId,
        fromCaptainTab: data.suggested!.fromCaptainTab,
        folderId: data.suggested!.folderId,
      }));
    }
  }, [data]);

  async function saveTarget() {
    setSaving(true);
    setActionError(null);
    try {
      await api.put('/execution/move-target', {
        ...form,
        masterSpreadsheetId: googleId(form.masterSpreadsheetId),
        fromCaptainSpreadsheetId: googleId(form.fromCaptainSpreadsheetId),
        toCaptainSpreadsheetId: googleId(form.toCaptainSpreadsheetId),
        folderId: googleId(form.folderId),
      });
      setConfiguring(false);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    setPreviewing(true);
    setActionError(null);
    setPreview(null);
    setQueued(null);
    setConfirmed(false);
    try {
      const result = await api.post<MoveResidentsPreviewResponse>('/execution/move-residents/preview');
      setPreview(result);
      const initial: Record<string, boolean> = {};
      for (const resident of result.residents) initial[resident.residentId] = true;
      setSelected(initial);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }

  async function applyPreview() {
    if (!preview || !confirmed) return;
    const residentIds = preview.residents
      .map((resident) => resident.residentId)
      .filter((id) => selected[id]);
    if (residentIds.length === 0) {
      setActionError('Select at least one resident to move.');
      return;
    }
    setApplying(true);
    setActionError(null);
    try {
      setQueued(
        await api.post<QueuedRunResponse>('/execution/move-residents/apply', {
          previewRunId: preview.runId,
          confirmed: true,
          residentIds,
        })
      );
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }

  if (loading) return null;
  const target = data?.target;
  const selectedCount = preview ? preview.residents.filter((r) => selected[r.residentId]).length : 0;

  return (
    <div className="card" style={{ borderColor: 'var(--golden-orange)', marginTop: 20 }}>
      <div className="eyebrow">Third reversible live playbook · copies only</div>
      <h3 style={{ marginTop: 6 }}>Move residents between captain sheet copies</h3>
      <p className="reading-copy" style={{ marginBottom: 12 }}>
        After a Mapbox redraw, some residents on one captain copy may now belong in another zone. Preview each
        before/after move, approve the ones you want, append to the destination copy, remove from the source, then undo
        from Runs if needed. Requires a second captain copy in the testing folder.
      </p>
      {error && <ErrorState message={error} />}
      {target && !configuring ? (
        <>
          <div className="callout info" style={{ marginBottom: 14 }}>
            <strong>{target.fromCaptainName}</strong>
            {target.fromZoneOverride ? ` · zone ${target.fromZoneOverride}` : ''}
            <br />
            <span aria-hidden="true">→</span> <strong>{target.toCaptainName}</strong>
            {target.toZoneOverride ? ` · zone ${target.toZoneOverride}` : ''}
            <br />
            Master coords from <strong>{target.masterName}</strong> · {target.masterTab}
          </div>
          <div className="btn-row">
            <button className="btn highlight" onClick={runPreview} disabled={previewing}>
              {previewing ? 'Computing moves…' : 'Preview resident moves'}
            </button>
            <button className="btn secondary small" onClick={() => setConfiguring(true)}>
              Change move copies
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="form-grid" style={{ marginTop: 16 }}>
            <CopyField
              label="Master copy link or ID"
              value={form.masterSpreadsheetId}
              onChange={(value) => setForm({ ...form, masterSpreadsheetId: value })}
            />
            <CopyField
              label="Master tab (with lat/lon)"
              value={form.masterTab}
              onChange={(value) => setForm({ ...form, masterTab: value })}
            />
            <CopyField
              label="Source captain copy (from)"
              value={form.fromCaptainSpreadsheetId}
              onChange={(value) => setForm({ ...form, fromCaptainSpreadsheetId: value })}
            />
            <CopyField
              label="Source tab"
              value={form.fromCaptainTab}
              onChange={(value) => setForm({ ...form, fromCaptainTab: value })}
            />
            <CopyField
              label="Destination captain copy (to)"
              value={form.toCaptainSpreadsheetId}
              onChange={(value) => setForm({ ...form, toCaptainSpreadsheetId: value })}
            />
            <CopyField
              label="Destination tab"
              value={form.toCaptainTab}
              onChange={(value) => setForm({ ...form, toCaptainTab: value })}
            />
            <CopyField
              label="Testing folder link or ID"
              value={form.folderId}
              onChange={(value) => setForm({ ...form, folderId: value })}
            />
            <CopyField
              label="Source zone override (optional)"
              value={form.fromZoneOverride}
              onChange={(value) => setForm({ ...form, fromZoneOverride: value })}
            />
            <CopyField
              label="Destination zone override (optional)"
              value={form.toZoneOverride}
              onChange={(value) => setForm({ ...form, toZoneOverride: value })}
            />
          </div>
          <p className="card-meta" style={{ marginTop: 8 }}>
            Zone overrides are for empty destination test sheets that have headers but no ZoneName values yet. Both
            captain copies must live in the testing folder.
          </p>
          <div className="btn-row">
            <button className="btn" onClick={saveTarget} disabled={saving}>
              {saving ? 'Verifying access…' : 'Save and verify move copies'}
            </button>
            {target && (
              <button className="btn secondary" onClick={() => setConfiguring(false)}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}
      {actionError && <div className="field-error" style={{ marginTop: 12 }}>{actionError}</div>}

      {preview && (
        <Modal title="Approve resident moves between copies" onClose={() => setPreview(null)} wide>
          <div className="callout">
            <strong>{preview.impact.headline}</strong>
            <div style={{ marginTop: 6 }}>{preview.impact.detail}</div>
          </div>
          <div className="card-grid" style={{ marginTop: 16 }}>
            <Metric value={preview.impact.moved} label="Proposed moves" />
            <Metric value={selectedCount} label="Selected to approve" />
            <Metric value={preview.impact.skipped} label="Skipped / not moveable" />
          </div>
          <p className="reading-copy">
            Before → after: <strong>{preview.fromZone}</strong> ({preview.target.fromCaptainName}) →{' '}
            <strong>{preview.toZone}</strong> ({preview.target.toCaptainName}). Uncheck any row you do not want to move.
          </p>
          {preview.residents.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Move</th>
                    <th>Resident</th>
                    <th className="mono">resident_id</th>
                    <th>From</th>
                    <th>To (computed)</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.residents.map((resident) => (
                    <tr key={resident.residentId}>
                      <td>
                        <input
                          type="checkbox"
                          checked={Boolean(selected[resident.residentId])}
                          onChange={(event) =>
                            setSelected((current) => ({
                              ...current,
                              [resident.residentId]: event.target.checked,
                            }))
                          }
                          aria-label={`Move ${resident.residentId}`}
                        />
                      </td>
                      <td>{resident.residentName || 'Name not provided'}</td>
                      <td className="mono">{resident.residentId}</td>
                      <td>
                        {resident.currentZoneOnSheet || resident.fromZone}
                        <div className="card-meta">{resident.fromSheet}</div>
                      </td>
                      <td>
                        {resident.computedZone}
                        <div className="card-meta">{resident.toSheet}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!queued && preview.canApply && (
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 18 }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                style={{ marginTop: 4 }}
              />
              <span className="reading-copy">
                I approve moving the {selectedCount} selected resident(s) between these copied captain sheets. The run
                will be recorded and can be undone from Runs.
              </span>
            </label>
          )}
          {queued && (
            <div className="callout info" style={{ marginTop: 18 }}>
              Live run <strong>#{queued.runId}</strong> is queued. Follow its status and use Undo from the{' '}
              <a href="/runs">Runs page</a>.
            </div>
          )}
          {!preview.canApply && (
            <div className="callout info" style={{ marginTop: 18 }}>
              No residents on the source copy currently compute to the destination zone. If you are testing with a
              synthetic resident, place them on the source copy with coordinates inside the destination zone polygon.
            </div>
          )}
          <div className="btn-row" style={{ marginTop: 18 }}>
            <button className="btn secondary" onClick={() => setPreview(null)}>
              Close
            </button>
            {preview.canApply && !queued && (
              <button
                className="btn highlight"
                onClick={applyPreview}
                disabled={!confirmed || applying || selectedCount === 0}
              >
                {applying ? 'Starting safely…' : `Move ${selectedCount} approved resident(s)`}
              </button>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function CopyField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input className="input" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function googleId(value: string): string {
  const trimmed = value.trim();
  const sheet = trimmed.match(/\/spreadsheets\/d\/([^/]+)/);
  if (sheet) return sheet[1];
  const folder = trimmed.match(/\/folders\/([^/?]+)/);
  if (folder) return folder[1];
  return trimmed;
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

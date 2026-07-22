import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { Connection, ConnectionType, TestConnectionResult } from '../lib/types';
import { EmptyState, ErrorState, Modal, SectionHead, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';

const TYPE_LABEL: Record<ConnectionType, string> = {
  master: 'Master',
  captain_folder: 'Captain folder',
  external: 'External',
};

export function Sources() {
  const { data, loading, error, reload } = useAsync<Connection[]>(() => api.get('/connections'));
  const { toast } = useToast();
  const [editing, setEditing] = useState<Connection | 'new' | null>(null);
  const [testResult, setTestResult] = useState<{ name: string; result: TestConnectionResult } | null>(null);
  const [testing, setTesting] = useState<number | null>(null);

  async function del(c: Connection) {
    if (!confirm(`Remove the "${c.name}" source? This only removes the pointer, not the Google file.`)) return;
    await api.del(`/connections/${c.id}`);
    toast('Source removed', 'success');
    reload();
  }

  async function test(c: Connection) {
    setTesting(c.id);
    toast('Testing connection…');
    try {
      const result = await api.post<TestConnectionResult>('/test-connection', { connectionId: c.id });
      setTestResult({ name: c.name, result });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Test failed', 'error');
    } finally {
      setTesting(null);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  const rows = data ?? [];

  return (
    <>
      <SectionHead title="Sources">
        <button className="btn" onClick={() => setEditing('new')}>
          Add source
        </button>
      </SectionHead>
      <p className="reading-copy" style={{ marginTop: 0 }}>
        A source is a named pointer to a Google spreadsheet, a Drive folder of captain sheets, or an external feed like
        the sales tracker. Share each one with the service account as <strong>Editor</strong>, then test it here.
      </p>

      {rows.length === 0 ? (
        <EmptyState
          title="No sources yet"
          body="Add your master spreadsheet, the captain sheets folder, and any external sources."
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Google ID</th>
                <th>Tab</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    <span className="chip">{TYPE_LABEL[c.type]}</span>
                  </td>
                  <td className="mono truncate">{c.google_id}</td>
                  <td>{c.source_tab || ''}</td>
                  <td>
                    <div className="btn-row">
                      <button className="btn secondary small" disabled={testing === c.id} onClick={() => test(c)}>
                        {testing === c.id ? 'Testing…' : 'Test'}
                      </button>
                      <button className="btn secondary small" onClick={() => setEditing(c)}>
                        Edit
                      </button>
                      <button className="btn destructive small" onClick={() => del(c)}>
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <SourceForm
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}

      {testResult && <TestResultModal name={testResult.name} result={testResult.result} onClose={() => setTestResult(null)} />}
    </>
  );
}

function SourceForm({
  existing,
  onClose,
  onSaved,
}: {
  existing: Connection | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    type: existing?.type ?? ('master' as ConnectionType),
    google_id: existing?.google_id ?? '',
    source_tab: existing?.source_tab ?? '',
    notes: existing?.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (existing) await api.put(`/connections/${existing.id}`, form);
      else await api.post('/connections', form);
      toast('Source saved', 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
      setBusy(false);
    }
  }

  return (
    <Modal title={existing ? 'Edit source' : 'Add source'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label>Name</label>
          <input className="input" value={form.name} onChange={set('name')} required />
        </div>
        <div className="field">
          <label>Type</label>
          <select className="select" value={form.type} onChange={set('type')}>
            <option value="master">Master spreadsheet</option>
            <option value="captain_folder">Captain sheets folder</option>
            <option value="external">External source spreadsheet</option>
          </select>
        </div>
        <div className="field">
          <label>Google ID</label>
          <input
            className="input mono"
            value={form.google_id}
            onChange={set('google_id')}
            required
            placeholder="Spreadsheet or folder ID from the URL"
          />
          <div className="hint">
            From the URL: <span className="mono">.../d/THIS_PART/edit</span> for sheets,{' '}
            <span className="mono">/folders/THIS_PART</span> for folders.
          </div>
        </div>
        <div className="field">
          <label>Source tab (optional)</label>
          <input
            className="input"
            value={form.source_tab}
            onChange={set('source_tab')}
            placeholder="Leave blank for the first tab"
          />
        </div>
        <div className="field">
          <label>Notes (optional)</label>
          <textarea className="input" value={form.notes} onChange={set('notes')} />
        </div>
        <div className="btn-row">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Saving…' : existing ? 'Save' : 'Add'}
          </button>
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TestResultModal({
  name,
  result,
  onClose,
}: {
  name: string;
  result: TestConnectionResult;
  onClose: () => void;
}) {
  return (
    <Modal title={`${name} — connected`} onClose={onClose} wide>
      {result.kind === 'folder' ? (
        <>
          <p>
            Found <strong>{result.count}</strong> spreadsheet(s) in the folder.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Modified</th>
                </tr>
              </thead>
              <tbody>
                {(result.spreadsheets ?? []).slice(0, 130).map((s, i) => (
                  <tr key={i}>
                    <td>{s.name}</td>
                    <td>{s.modifiedTime || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <p>
            <strong>{result.title}</strong> — read tab &ldquo;{result.tabRead}&rdquo; with{' '}
            <strong>{result.headerCount}</strong> columns.
          </p>
          <div className="alias-list">
            {(result.headers ?? []).filter(Boolean).map((h, i) => (
              <span className="chip" key={i}>
                {h}
              </span>
            ))}
          </div>
        </>
      )}
      <div className="btn-row" style={{ marginTop: 16 }}>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

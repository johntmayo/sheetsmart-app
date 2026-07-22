import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { DictionaryField, FieldDataType, Policy } from '../lib/types';
import { EmptyState, ErrorState, Modal, PolicyPill, SectionHead, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';

const TYPES: FieldDataType[] = ['text', 'number', 'date', 'checkbox'];
const POLICIES: Policy[] = ['fill_blank', 'overwrite', 'conflict', 'never'];

const TYPE_PILL: Record<FieldDataType, string> = {
  text: 'neutral',
  number: 'info',
  date: 'info',
  checkbox: 'warn',
};

export function FieldDictionary() {
  const { data, loading, error, reload } = useAsync<DictionaryField[]>(() => api.get('/dictionary'));
  const { toast } = useToast();
  const [editing, setEditing] = useState<DictionaryField | 'new' | null>(null);
  const [query, setQuery] = useState('');

  const fields = data ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter(
      (f) =>
        f.canonical_name.toLowerCase().includes(q) ||
        f.aliases.some((a) => a.toLowerCase().includes(q)),
    );
  }, [fields, query]);

  const counts = useMemo(
    () => ({
      total: fields.length,
      identity: fields.filter((f) => f.is_identity).length,
      sensitive: fields.filter((f) => f.is_sensitive).length,
      textSafe: fields.filter((f) => f.is_text_safe).length,
    }),
    [fields],
  );

  async function del(f: DictionaryField) {
    if (f.is_identity) {
      toast('The identity field cannot be deleted.', 'error');
      return;
    }
    if (!confirm(`Remove the logical field "${f.canonical_name}" from the dictionary?`)) return;
    await api.del(`/dictionary/${f.id}`);
    toast('Field removed', 'success');
    reload();
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;

  return (
    <>
      <SectionHead title="Field Dictionary">
        <button className="btn" onClick={() => setEditing('new')}>
          Add field
        </button>
      </SectionHead>
      <p className="reading-copy" style={{ marginTop: 0 }}>
        The canonical list of logical fields SheetSmart reasons about. Each field knows its type, whether it&apos;s an
        identity key or sensitive, whether it must be written as literal text, its default sync policy, and the real
        headers (aliases) it has drifted into. This is where column drift stops being a recurring fire and becomes a
        managed fact — add an alias whenever a captain sheet renames a column, and the tool learns it.
      </p>

      <div className="card-grid" style={{ marginBottom: 24 }}>
        <div className="card">
          <div className="metric">{counts.total}</div>
          <div className="metric-label">Logical fields</div>
        </div>
        <div className="card">
          <div className="metric">{counts.identity}</div>
          <div className="metric-label">Identity key</div>
        </div>
        <div className="card">
          <div className="metric">{counts.sensitive}</div>
          <div className="metric-label">Sensitive fields</div>
        </div>
        <div className="card">
          <div className="metric">{counts.textSafe}</div>
          <div className="metric-label">Text-safe fields</div>
        </div>
      </div>

      <div className="field" style={{ maxWidth: 360 }}>
        <input
          className="input"
          placeholder="Search fields or aliases…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search fields"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No fields match" body="Try a different search, or add a new logical field." />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Canonical field</th>
                <th>Type</th>
                <th>Flags</th>
                <th>Default policy</th>
                <th>Aliases</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((f) => (
                <tr key={f.id}>
                  <td>
                    <span className="mono">{f.canonical_name}</span>
                  </td>
                  <td>
                    <span className={`pill ${TYPE_PILL[f.data_type]}`}>{f.data_type}</span>
                  </td>
                  <td>
                    <div className="fd-badges">
                      {f.is_identity ? <span className="pill urgent">identity</span> : null}
                      {f.is_sensitive ? <span className="pill error">sensitive</span> : null}
                      {f.is_text_safe ? <span className="pill info">text-safe</span> : null}
                      {!f.is_identity && !f.is_sensitive && !f.is_text_safe ? (
                        <span className="card-meta">—</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <PolicyPill policy={f.default_policy} />
                  </td>
                  <td>
                    {f.aliases.length === 0 ? (
                      <span className="card-meta">—</span>
                    ) : (
                      <div className="alias-list">
                        {f.aliases.map((a) => (
                          <span className="chip" key={a}>
                            {a}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="btn-row">
                      <button className="btn secondary small" onClick={() => setEditing(f)}>
                        Edit
                      </button>
                      <button className="btn destructive small" onClick={() => del(f)}>
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
        <FieldForm
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function FieldForm({
  existing,
  onClose,
  onSaved,
}: {
  existing: DictionaryField | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    canonical_name: existing?.canonical_name ?? '',
    data_type: existing?.data_type ?? ('text' as FieldDataType),
    default_policy: existing?.default_policy ?? ('fill_blank' as Policy),
    is_identity: Boolean(existing?.is_identity),
    is_sensitive: Boolean(existing?.is_sensitive),
    is_text_safe: Boolean(existing?.is_text_safe),
    notes: existing?.notes ?? '',
    aliasesText: (existing?.aliases ?? []).join(', '),
  });
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const payload = {
      canonical_name: form.canonical_name.trim(),
      data_type: form.data_type,
      default_policy: form.is_identity ? 'never' : form.default_policy,
      is_identity: form.is_identity,
      is_sensitive: form.is_sensitive,
      is_text_safe: form.is_text_safe,
      notes: form.notes,
      aliases: form.aliasesText
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    };
    try {
      if (existing) await api.put(`/dictionary/${existing.id}`, payload);
      else await api.post('/dictionary', payload);
      toast('Field saved', 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
      setBusy(false);
    }
  }

  const toggle = (k: 'is_identity' | 'is_sensitive' | 'is_text_safe') => () =>
    setForm((f) => ({ ...f, [k]: !f[k] }));

  return (
    <Modal title={existing ? `Edit field — ${existing.canonical_name}` : 'Add logical field'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field">
            <label>Canonical name</label>
            <input
              className="input mono"
              value={form.canonical_name}
              onChange={(e) => setForm((f) => ({ ...f, canonical_name: e.target.value }))}
              required
            />
          </div>
          <div className="field">
            <label>Data type</label>
            <select
              className="select"
              value={form.data_type}
              onChange={(e) => setForm((f) => ({ ...f, data_type: e.target.value as FieldDataType }))}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label>Default sync policy</label>
          <select
            className="select"
            value={form.is_identity ? 'never' : form.default_policy}
            disabled={form.is_identity}
            onChange={(e) => setForm((f) => ({ ...f, default_policy: e.target.value as Policy }))}
          >
            {POLICIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {form.is_identity && (
            <div className="hint">Identity fields are always forced to “never” — they can&apos;t be written by a workflow.</div>
          )}
        </div>

        <div className="field">
          <label>Protection flags</label>
          <div className="btn-row">
            <label className="chip" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={form.is_identity} onChange={toggle('is_identity')} /> Identity key
            </label>
            <label className="chip" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={form.is_sensitive} onChange={toggle('is_sensitive')} /> Sensitive
            </label>
            <label className="chip" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={form.is_text_safe} onChange={toggle('is_text_safe')} /> Text-safe
            </label>
          </div>
          <div className="hint">
            Sensitive fields are flagged (not blocked) when pushed to captain sheets. Text-safe fields are written as
            literal text so IDs and zips aren&apos;t mangled.
          </div>
        </div>

        <div className="field">
          <label>Aliases (real headers this field drifts into)</label>
          <textarea
            className="input"
            value={form.aliasesText}
            onChange={(e) => setForm((f) => ({ ...f, aliasesText: e.target.value }))}
            placeholder="Comma-separated, e.g. resident id, residentid"
          />
          <div className="hint">The canonical name is always matched automatically — only list extra variants here.</div>
        </div>

        <div className="field">
          <label>Notes (optional)</label>
          <textarea
            className="input"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </div>

        <div className="btn-row">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Saving…' : existing ? 'Save field' : 'Add field'}
          </button>
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

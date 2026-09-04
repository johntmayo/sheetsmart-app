import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { DictionaryField, FieldDataType, Policy } from '../lib/types';
import { EmptyState, ErrorState, Modal, PolicyPill, SectionHead, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';

const TYPES: FieldDataType[] = ['text', 'number', 'date', 'checkbox'];
const POLICIES: Policy[] = ['fill_blank', 'overwrite', 'conflict', 'never'];
const SALES_FIELDS = new Set([
  'address - for sale',
  'address - sold since fire',
  'latest sale date',
  'latest sale price',
  'latest new owner',
  'lot sqft',
  'sales history',
]);

function isSalesField(name: string): boolean {
  return SALES_FIELDS.has(name.trim().toLowerCase());
}
const POLICY_LABEL: Record<Policy, string> = {
  fill_blank: 'Fill if blank',
  overwrite: 'Replace existing',
  conflict: 'Ask me',
  never: 'Never write',
};

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
    if (isSalesField(f.canonical_name)) {
      toast('Zone Dashboard-owned sales fields must remain on the master.', 'error');
      return;
    }
    if (f.is_identity) {
      toast('The identity field cannot be deleted.', 'error');
      return;
    }
    if (!confirm(`Remove the field "${f.canonical_name}" from SheetSmart?`)) return;
    await api.del(`/dictionary/${f.id}`);
    toast('Field removed', 'success');
    reload();
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;

  return (
    <>
      <SectionHead title="Fields">
        <button className="btn" onClick={() => setEditing('new')}>
          Add field
        </button>
      </SectionHead>
      <p className="reading-copy" style={{ marginTop: 0 }}>
        These are the field names SheetSmart uses when comparing and updating sheets. If a captain uses a different
        column name, add that name here once and SheetSmart will recognize it in future scans.
      </p>

      <div className="card-grid" style={{ marginBottom: 24 }}>
        <div className="card">
          <div className="metric">{counts.total}</div>
          <div className="metric-label">Fields defined</div>
        </div>
        <div className="card">
          <div className="metric">{counts.identity}</div>
          <div className="metric-label">Unique ID field</div>
        </div>
        <div className="card">
          <div className="metric">{counts.sensitive}</div>
          <div className="metric-label">Private fields</div>
        </div>
        <div className="card">
          <div className="metric">{counts.textSafe}</div>
          <div className="metric-label">Keep-as-text fields</div>
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
        <EmptyState title="No fields match" body="Try a different search, or add a new field." />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Standard name</th>
                <th>Type</th>
                <th>Flags</th>
                <th>Captain sheets</th>
                <th>Update rule</th>
                <th>Other column names</th>
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
                      {f.is_identity ? <span className="pill urgent">Unique ID</span> : null}
                      {f.is_sensitive ? <span className="pill error">Private info</span> : null}
                      {f.is_text_safe ? <span className="pill info">Keep as text</span> : null}
                      {!f.is_identity && !f.is_sensitive && !f.is_text_safe ? (
                        <span className="card-meta">—</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    {f.distribute_to_captain ? (
                      <span className="pill info">Included</span>
                    ) : (
                      <span className="pill neutral">Master only</span>
                    )}
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
    distribute_to_captain: existing ? Boolean(existing.distribute_to_captain) : true,
    notes: existing?.notes ?? '',
    aliasesText: (existing?.aliases ?? []).join(', '),
  });
  const [busy, setBusy] = useState(false);
  const salesOwned = isSalesField(existing?.canonical_name || form.canonical_name);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const payload = {
      canonical_name: form.canonical_name.trim(),
      data_type: form.data_type,
      default_policy: form.is_identity || salesOwned ? 'never' : form.default_policy,
      is_identity: form.is_identity,
      is_sensitive: form.is_sensitive,
      is_text_safe: form.is_text_safe,
      distribute_to_captain: salesOwned ? false : form.distribute_to_captain,
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

  const toggle = (k: 'is_identity' | 'is_sensitive' | 'is_text_safe' | 'distribute_to_captain') => () =>
    setForm((f) => ({ ...f, [k]: !f[k] }));

  return (
    <Modal title={existing ? `Edit field — ${existing.canonical_name}` : 'Add field'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field">
            <label>Standard name</label>
            <input
              className="input mono"
              value={form.canonical_name}
              onChange={(e) => setForm((f) => ({ ...f, canonical_name: e.target.value }))}
              disabled={Boolean(existing && salesOwned)}
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
            value={form.is_identity || salesOwned ? 'never' : form.default_policy}
            disabled={form.is_identity || salesOwned}
            onChange={(e) => setForm((f) => ({ ...f, default_policy: e.target.value as Policy }))}
          >
            {POLICIES.map((p) => (
              <option key={p} value={p}>
                {POLICY_LABEL[p]}
              </option>
            ))}
          </select>
          {form.is_identity && (
            <div className="hint">Unique ID fields are never overwritten by automated updates.</div>
          )}
          {salesOwned && (
            <div className="hint">Zone Dashboard owns this sales field. SheetSmart never writes it from another source.</div>
          )}
        </div>

        <div className="field">
          <label>Where this field belongs</label>
          <label className="chip" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={salesOwned ? false : form.distribute_to_captain}
              onChange={toggle('distribute_to_captain')}
              disabled={salesOwned}
            />{' '}
            Include this field on captain sheets
          </label>
          <div className="hint">
            Turn this off for master-only information. SheetSmart will not copy it to captains or report it as a
            missing captain column.
          </div>
        </div>

        <div className="field">
          <label>Protection flags</label>
          <div className="btn-row">
            <label className="chip" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={form.is_identity} onChange={toggle('is_identity')} /> Unique ID
            </label>
            <label className="chip" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={form.is_sensitive} onChange={toggle('is_sensitive')} /> Private info
            </label>
            <label className="chip" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={form.is_text_safe} onChange={toggle('is_text_safe')} /> Keep as text
            </label>
          </div>
          <div className="hint">
            Private fields get a warning before they are copied to captain sheets. Keep-as-text fields prevent IDs and
            zip codes from turning into dates or numbers.
          </div>
        </div>

        <div className="field">
          <label>Other column names captains use</label>
          <textarea
            className="input"
            value={form.aliasesText}
            onChange={(e) => setForm((f) => ({ ...f, aliasesText: e.target.value }))}
            placeholder="Comma-separated, e.g. resident id, residentid"
          />
          <div className="hint">The standard name is always recognized. List only additional versions here.</div>
        </div>

        <div className="field">
          <label>Notes (optional)</label>
          <textarea
            className="input"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            disabled={salesOwned}
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

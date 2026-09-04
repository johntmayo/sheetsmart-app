import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { ErrorState, Spinner, StatusPill } from './ui';
import { useToast } from './Toast';

interface Source {
  id: number;
  name: string;
}

interface IntakeAddress {
  address_id: string;
  house: string;
  direction: string;
  street: string;
  unit: string;
  city: string;
  zoneFields: Record<string, string>;
}

interface IntakePreview {
  runId: number;
  sourceName: string;
  placeholders: IntakeAddress[];
  matches: Array<{ externalRow: number; addressId: string; tier: string }>;
  review: Array<{
    externalRow: number;
    reason: string;
    input: { house: string; direction: string; street: string; unit: string; city: string; apn: string };
    candidates: Array<{
      addressId: string;
      reasons: string[];
      distanceMeters?: number;
      similarity?: number;
      canonical: { house: string; direction: string; street: string; unit: string; city: string; apn: string };
    }>;
  }>;
  blocked: Array<{ externalRow: number; reason: string }>;
  mapBlocked: Array<{ externalRow: number; reason: string }>;
  errors: string[];
  impact: {
    sourceRows: number;
    alreadyKnown: number;
    needsReview: number;
    blocked: number;
    readyToAdd: number;
  };
  canApply: boolean;
}

export function AddressIntakePlaybook() {
  const { toast } = useToast();
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [preview, setPreview] = useState<IntakePreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ sources: Source[] }>('/address-intake/sources')
      .then((response) => {
        setSources(response.sources);
        if (response.sources.length === 1) setSourceId(String(response.sources[0].id));
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  }, []);

  const selectedCount = selected.size;
  const allVisibleSelected = useMemo(
    () => Boolean(preview?.placeholders.length) && preview!.placeholders.every((item) => selected.has(item.address_id)),
    [preview, selected]
  );

  async function scan() {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const response = await api.post<IntakePreview>('/address-intake/preview', {
        sourceConnectionId: Number(sourceId),
      });
      setPreview(response);
      setSelected(new Set(response.placeholders.slice(0, 250).map((item) => item.address_id)));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview || selectedCount < 1 || selectedCount > 250) return;
    if (
      !confirm(
        `Add ${selectedCount} address-only record${selectedCount === 1 ? '' : 's'} to the real master? Every addition can be undone from Runs.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ runId: number }>('/address-intake/apply', {
        previewRunId: preview.runId,
        addressIds: [...selected],
        confirmed: true,
      });
      toast(`Address intake queued as run #${result.runId}`, 'success');
      setPreview(null);
      setSelected(new Set());
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function toggle(addressId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(addressId)) next.delete(addressId);
      else if (next.size < 250) next.add(addressId);
      return next;
    });
  }

  if (loading) return <Spinner />;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="eyebrow">Occasional data intake</div>
      <h3>Add missing addresses safely</h3>
      <p className="reading-copy">
        Compares an outside address list against the master and every captain sheet. Exact matches are kept, close
        matches wait for review, and only clearly new addresses can be added.
      </p>
      <div className="btn-row">
        <select className="select" value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
          <option value="">Choose an outside address list</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!sourceId || busy} onClick={scan}>
          {busy ? 'Comparing addresses…' : 'Scan address list'}
        </button>
      </div>
      {sources.length === 0 && (
        <p className="reading-copy">Add the missing-address spreadsheet as an optional outside list under Sources first.</p>
      )}
      {error && <ErrorState message={error} />}

      {preview && (
        <>
          <div className="card-grid" style={{ marginTop: 18 }}>
            <Metric value={preview.impact.sourceRows} label="Source rows checked" />
            <Metric value={preview.impact.alreadyKnown} label="Already represented" />
            <Metric value={preview.impact.needsReview} label="Possible matches to review" alert />
            <Metric value={preview.impact.readyToAdd} label="Clearly new addresses" />
          </div>
          {preview.impact.blocked > 0 && (
            <div className="callout">
              <strong>{preview.impact.blocked} address(es) need source-data corrections.</strong> They will not be
              selectable or written.
            </div>
          )}
          {preview.errors.length > 0 && <ErrorState message={preview.errors.join(' ')} />}

          {preview.placeholders.length > 0 && (
            <>
              <div className="section-head" style={{ marginTop: 20 }}>
                <h3>Ready to add</h3>
                <div className="spacer" />
                <span className="pill neutral">{selectedCount.toLocaleString()} selected</span>
                <button
                  className="btn secondary small"
                  onClick={() =>
                    setSelected(
                      allVisibleSelected
                        ? new Set()
                        : new Set(preview.placeholders.slice(0, 250).map((item) => item.address_id))
                    )
                  }
                >
                  {allVisibleSelected ? 'Clear' : 'Select first 250'}
                </button>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th />
                      <th>Address</th>
                      <th>Mapbox zone</th>
                      <th>New address ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.placeholders.map((item) => (
                      <tr key={item.address_id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(item.address_id)}
                            disabled={!selected.has(item.address_id) && selectedCount >= 250}
                            onChange={() => toggle(item.address_id)}
                            aria-label={`Select ${item.house} ${item.street}`}
                          />
                        </td>
                        <td>
                          {[item.house, item.direction, item.street, item.unit, item.city].filter(Boolean).join(' ')}
                        </td>
                        <td>{item.zoneFields.ZoneName || '—'}</td>
                        <td className="mono">{item.address_id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.placeholders.length > 250 && (
                <p className="reading-copy">
                  One run is limited to 250 addresses. After it finishes, scan again for the next batch.
                </p>
              )}
              <div className="btn-row" style={{ marginTop: 16 }}>
                <button className="btn" disabled={busy || selectedCount < 1 || selectedCount > 250} onClick={apply}>
                  Add {selectedCount.toLocaleString()} selected address{selectedCount === 1 ? '' : 'es'}
                </button>
                <StatusPill status="approval required" />
              </div>
            </>
          )}

          {(preview.review.length > 0 || preview.blocked.length > 0 || preview.mapBlocked.length > 0) && (
            <details style={{ marginTop: 18 }}>
              <summary className="reading-copy" style={{ cursor: 'pointer' }}>
                Show addresses needing review or correction
              </summary>
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Source row</th>
                      <th>Incoming address</th>
                      <th>Why it was held back</th>
                      <th>Possible existing matches</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.review.map((item) => (
                      <tr key={`review-${item.externalRow}`}>
                        <td>{item.externalRow}</td>
                        <td>{formatReviewAddress(item.input)}</td>
                        <td>{item.reason}</td>
                        <td>
                          {item.candidates
                            .map((candidate) => {
                              const evidence = [
                                candidate.distanceMeters != null
                                  ? `${Math.round(candidate.distanceMeters)}m away`
                                  : '',
                                candidate.similarity != null
                                  ? `${Math.round(candidate.similarity * 100)}% text match`
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(', ');
                              return `${formatReviewAddress(candidate.canonical)} · ${candidate.addressId}${
                                evidence ? ` (${evidence})` : ''
                              }`;
                            })
                            .join('; ')}
                        </td>
                      </tr>
                    ))}
                    {[...preview.blocked, ...preview.mapBlocked].map((item, index) => (
                      <tr key={`blocked-${item.externalRow}-${index}`}>
                        <td>{item.externalRow}</td>
                        <td>—</td>
                        <td>{item.reason}</td>
                        <td>Correct the source row, then scan again.</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function formatReviewAddress(address: {
  house: string;
  direction: string;
  street: string;
  unit: string;
  city: string;
  apn: string;
}): string {
  const location = [address.house, address.direction, address.street, address.unit, address.city]
    .filter(Boolean)
    .join(' ');
  return address.apn ? `${location} · APN ${address.apn}` : location;
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

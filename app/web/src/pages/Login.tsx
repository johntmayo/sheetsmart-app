import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/login', { password });
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="brand-row">
          <div className="brand-mark">S</div>
          <div>
            <h2 style={{ margin: 0, color: 'var(--deep-space-blue)' }}>SheetSmart</h2>
            <div className="card-meta">Admin sign-in</div>
          </div>
        </div>
        <p className="reading-copy" style={{ marginTop: 0 }}>
          The data-integrity backbone for the Altadena recovery outreach. Sign in to review alignment, preview
          changes, and keep the resident data honest.
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="pw">Password</label>
            <input
              id="pw"
              className="input"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <div className="field-error">{error}</div>}
          </div>
          <button className="btn" type="submit" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './lib/api';
import { Spinner } from './components/ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Sources } from './pages/Sources';
import { FieldDictionary } from './pages/FieldDictionary';
import { Workflows } from './pages/Workflows';
import { Runs } from './pages/Runs';
import { Conflicts } from './pages/Conflicts';

const NAV = [
  { to: '/', label: 'Health', end: true },
  { to: '/sources', label: 'Sources' },
  { to: '/dictionary', label: 'Field Dictionary' },
  { to: '/playbooks', label: 'Playbooks' },
  { to: '/runs', label: 'Runs' },
  { to: '/conflicts', label: 'Conflicts' },
];

export function App() {
  const [authState, setAuthState] = useState<'checking' | 'in' | 'out'>('checking');

  useEffect(() => {
    api
      .get<{ authenticated: boolean }>('/session')
      .then((s) => setAuthState(s.authenticated ? 'in' : 'out'))
      .catch(() => setAuthState('out'));
  }, []);

  const onAuthed = useCallback(() => setAuthState('in'), []);

  if (authState === 'checking') return <Spinner />;
  if (authState === 'out') return <Login onAuthed={onAuthed} />;

  return <Shell onSignOut={() => setAuthState('out')} />;
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const navigate = useNavigate();

  async function signOut() {
    try {
      await api.post('/logout');
    } finally {
      onSignOut();
      navigate('/');
    }
  }

  return (
    <>
      <header className="app-header">
        <div className="brand-mark">S</div>
        <h1>SheetSmart</h1>
        <div className="header-actions">
          <span className="who">Admin</span>
          <button className="btn secondary small" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <div className="page-container">
        <nav className="app-nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/dictionary" element={<FieldDictionary />} />
          <Route path="/playbooks" element={<Workflows />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/conflicts" element={<Conflicts />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </>
  );
}

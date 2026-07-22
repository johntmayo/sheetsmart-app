'use strict';

// SheetSmart frontend — vanilla JS single-page app. No build step (handoff
// Section 3). Talks to the JSON API and redirects to login on a 401.

const App = (() => {
  const root = document.getElementById('app');
  const modalRoot = document.getElementById('modal-root');
  const toastStack = document.getElementById('toast-stack');

  const state = { view: 'dashboard', params: {}, cache: {} };

  // ---------- utilities ----------
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch('/api' + path, opts);
    if (res.status === 401) {
      renderLogin();
      throw new Error('Not authenticated');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const msg = (data && data.error) || `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  function toast(message, kind = '') {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = message;
    toastStack.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function closeModal() { modalRoot.innerHTML = ''; }
  function showModal(innerHtml) {
    modalRoot.innerHTML = `<div class="modal-overlay" data-close-overlay><div class="modal">${innerHtml}</div></div>`;
    modalRoot.querySelector('[data-close-overlay]').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });
  }

  function statusPill(status) {
    const cls = 'status-' + esc(status);
    return `<span class="status-pill ${cls}">${esc(status)}</span>`;
  }

  // ---------- login ----------
  function renderLogin(errorMsg) {
    root.innerHTML = `
      <div class="login-wrap">
        <div class="card login-card">
          <div class="brand-row">
            <div class="brand-mark">S</div>
            <div><h2 style="margin:0">SheetSmart</h2>
            <div class="card-meta" style="margin:0">Admin sign-in</div></div>
          </div>
          <p class="reading-copy" style="margin-top:0">Enter the admin password to manage sheet syncs, audits, and run history.</p>
          <form id="login-form">
            <div class="field">
              <label for="pw">Password</label>
              <input class="input" type="password" id="pw" autocomplete="current-password" autofocus />
              ${errorMsg ? `<div class="field-error">${esc(errorMsg)}</div>` : ''}
            </div>
            <button class="button-primary" type="submit" style="width:100%">Sign in</button>
          </form>
        </div>
      </div>`;
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('pw').value;
      try {
        await api('POST', '/login', { password });
        boot();
      } catch (err) {
        renderLogin(err.message);
      }
    });
  }

  // ---------- shell ----------
  const NAV = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'connections', label: 'Connections' },
    { id: 'workflows', label: 'Workflows' },
    { id: 'sensitive', label: 'Sensitive Columns' },
    { id: 'runs', label: 'Run History' },
    { id: 'conflicts', label: 'Conflicts' },
  ];

  function renderShell() {
    root.innerHTML = `
      <header class="app-header">
        <div class="brand-mark">S</div>
        <h1>SheetSmart</h1>
        <div class="header-actions">
          <span class="who">Admin</span>
          <button class="button-secondary button-small" id="logout-btn">Sign out</button>
        </div>
      </header>
      <div class="page-container">
        <nav class="app-nav" id="nav">
          ${NAV.map((n) => `<button data-nav="${n.id}">${esc(n.label)}</button>`).join('')}
        </nav>
        <div id="view"><div class="state"><span class="spinner"></span></div></div>
      </div>`;
    document.getElementById('logout-btn').addEventListener('click', async () => {
      await api('POST', '/logout');
      renderLogin();
    });
    document.getElementById('nav').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-nav]');
      if (btn) navigate(btn.dataset.nav);
    });
  }

  function setActiveNav() {
    document.querySelectorAll('[data-nav]').forEach((b) => {
      b.setAttribute('aria-current', b.dataset.nav === state.view ? 'true' : 'false');
    });
  }

  function viewEl() { return document.getElementById('view'); }
  function loading() { viewEl().innerHTML = '<div class="state"><span class="spinner"></span></div>'; }
  function errorState(msg) {
    viewEl().innerHTML = `<div class="state"><div class="state-title error-text">Something went wrong</div><div>${esc(msg)}</div></div>`;
  }

  async function navigate(view, params = {}) {
    state.view = view;
    state.params = params;
    setActiveNav();
    loading();
    try {
      await VIEWS[view]();
    } catch (err) {
      if (err.message !== 'Not authenticated') errorState(err.message);
    }
  }

  // ---------- views ----------
  const VIEWS = {
    async dashboard() {
      const s = await api('GET', '/status');
      const g = s.google;
      const conn = s.connections;
      const gPill = g.configured ? statusPill('connected') : statusPill('disconnected');
      const masterPill = conn.master.length ? statusPill('connected') : statusPill('disconnected');
      const folderPill = conn.captain_folder.length ? statusPill('connected') : statusPill('disconnected');
      const extPill = conn.external.length ? statusPill('connected') : statusPill('disconnected');

      viewEl().innerHTML = `
        <div class="callout">
          Welcome to SheetSmart. This is the operations dashboard for keeping the captain sheets aligned with the master
          resident dataset. Every workflow previews changes with a <strong>dry run</strong> before anything is written.
          ${g.configured ? '' : ' <strong>Google is not connected yet</strong> — add your service-account key to <span class="mono">.env</span> (see the project README), then restart.'}
        </div>

        <div class="card-grid">
          <div class="card">
            <h3>Google connection</h3>
            <div>${gPill}</div>
            <div class="card-meta" style="margin-top:8px">
              ${g.configured ? 'Service account: <span class="mono">' + esc(g.clientEmail || '') + '</span>' : 'No service-account key configured.'}
            </div>
          </div>
          <div class="card"><h3>Master spreadsheet</h3><div>${masterPill}</div>
            <div class="card-meta" style="margin-top:8px">${conn.master.length ? esc(conn.master[0].name) : 'Not added yet'}</div></div>
          <div class="card"><h3>Captain folder</h3><div>${folderPill}</div>
            <div class="card-meta" style="margin-top:8px">${conn.captain_folder.length ? esc(conn.captain_folder[0].name) : 'Not added yet'}</div></div>
          <div class="card"><h3>External sources</h3><div>${extPill}</div>
            <div class="card-meta" style="margin-top:8px">${conn.external.length ? conn.external.length + ' connected' : 'Not added yet'}</div></div>
        </div>

        <div class="card-grid" style="margin-top:16px">
          <div class="card"><div class="metric">${s.counts.workflows}</div><div class="metric-label">Workflows configured</div></div>
          <div class="card"><div class="metric">${s.counts.sensitiveColumns}</div><div class="metric-label">Sensitive columns tracked</div></div>
          <div class="card"><div class="metric">${s.counts.openConflicts}</div><div class="metric-label">Open conflicts to review</div></div>
        </div>

        <div class="section-head" style="margin-top:32px"><h2>Recent runs</h2></div>
        ${recentRunsTable(s.recentRuns)}`;
    },

    async connections() {
      const rows = await api('GET', '/connections');
      viewEl().innerHTML = `
        <div class="section-head">
          <h2>Connections</h2><div class="spacer"></div>
          <button class="button-primary" id="add-conn">Add connection</button>
        </div>
        <p class="reading-copy" style="margin-top:0">A connection is a named pointer to a Google spreadsheet, a Drive folder of captain sheets, or an external source. Share each one with the service account as <strong>Editor</strong> first.</p>
        ${rows.length === 0
          ? emptyState('No connections yet', 'Add your master spreadsheet, the captain sheets folder, and any external sources.')
          : `<div class="table-wrap"><table class="data"><thead><tr>
              <th>Name</th><th>Type</th><th>Google ID</th><th>Tab</th><th></th></tr></thead>
              <tbody>${rows.map(connRow).join('')}</tbody></table></div>`}`;
      document.getElementById('add-conn').addEventListener('click', () => connectionForm());
      viewEl().querySelectorAll('[data-test-conn]').forEach((b) =>
        b.addEventListener('click', () => testConnection(b.dataset.testConn)));
      viewEl().querySelectorAll('[data-edit-conn]').forEach((b) =>
        b.addEventListener('click', () => connectionForm(JSON.parse(b.dataset.editConn))));
      viewEl().querySelectorAll('[data-del-conn]').forEach((b) =>
        b.addEventListener('click', () => deleteConnection(b.dataset.delConn)));
    },

    async workflows() {
      const [types, workflows] = await Promise.all([
        api('GET', '/workflow-types'),
        api('GET', '/workflows'),
      ]);
      state.cache.workflowTypes = types;
      const typeLabel = (t) => (types.find((x) => x.type === t) || {}).label || t;
      viewEl().innerHTML = `
        <div class="section-head"><h2>Workflows</h2><div class="spacer"></div>
          <button class="button-primary" id="add-wf">New workflow</button></div>
        <p class="reading-copy" style="margin-top:0">Each workflow is a named operation with its source, target, match column, mappings, and policies. Execution (dry run / live run) arrives in later phases; for now this is where the configuration lives.</p>
        ${workflows.length === 0
          ? emptyState('No workflows yet', 'Create one for each sync you run, e.g. "Update Master From Sales Tracker".')
          : `<div class="card-grid">${workflows.map((w) => `
              <div class="card">
                <h3>${esc(w.name)}</h3>
                <div class="card-meta">${esc(typeLabel(w.type))}</div>
                <div class="button-row">
                  <button class="button-secondary button-small" data-open-wf="${w.id}">Configure</button>
                  <span class="chip">${w.column_mappings.length} mappings</span>
                  <span class="chip">${w.column_policies.length} policies</span>
                </div>
              </div>`).join('')}</div>`}`;
      document.getElementById('add-wf').addEventListener('click', () => workflowForm(types));
      viewEl().querySelectorAll('[data-open-wf]').forEach((b) =>
        b.addEventListener('click', () => navigate('workflowDetail', { id: b.dataset.openWf })));
    },

    async workflowDetail() {
      const id = state.params.id;
      const [wf, types, connections] = await Promise.all([
        api('GET', '/workflows/' + id),
        api('GET', '/workflow-types'),
        api('GET', '/connections'),
      ]);
      const t = types.find((x) => x.type === wf.type) || {};
      const connName = (cid) => { const c = connections.find((x) => x.id === cid); return c ? c.name : '—'; };
      viewEl().innerHTML = `
        <div class="section-head">
          <button class="button-secondary button-small" id="back">← Workflows</button>
          <div class="spacer"></div>
          <button class="button-destructive button-small" id="del-wf">Delete</button>
        </div>
        <div class="card">
          <h3>${esc(wf.name)} ${t.destructive ? '<span class="badge-destructive">Destructive</span>' : ''}</h3>
          <div class="card-meta">${esc(t.label || wf.type)}</div>
          <div class="form-grid">
            <div><div class="metric-label">Source</div><div>${esc(connName(wf.source_connection_id))}</div></div>
            <div><div class="metric-label">Target</div><div>${esc(connName(wf.target_connection_id))}</div></div>
            <div><div class="metric-label">Match column</div><div>${esc(wf.match_column || '—')}</div></div>
            <div><div class="metric-label">Source tab</div><div>${esc(wf.source_tab || '(first tab)')}</div></div>
          </div>
          ${wf.notes ? `<p class="reading-copy">${esc(wf.notes)}</p>` : ''}
          <div class="button-row" style="margin-top:12px">
            <button class="button-secondary button-small" id="edit-wf">Edit details</button>
            <button class="button-highlight button-small" id="dry-run" disabled title="Dry run execution arrives in Phase 2">Dry run</button>
            <button class="button-primary button-small" id="live-run" disabled title="Live run execution arrives in Phase 3">Live run</button>
          </div>
        </div>

        <div class="card">
          <div class="section-head"><h3 style="margin:0">Column mappings</h3><div class="spacer"></div>
            <button class="button-secondary button-small" id="edit-maps">Edit mappings</button></div>
          ${wf.column_mappings.length === 0
            ? '<div class="card-meta">No mappings yet. Add source → target column pairs.</div>'
            : `<div class="table-wrap"><table class="data"><thead><tr><th>Source column</th><th>Target column</th></tr></thead>
               <tbody>${wf.column_mappings.map((m) => `<tr><td>${esc(m.source_column)}</td><td>${esc(m.target_column)}</td></tr>`).join('')}</tbody></table></div>`}
        </div>

        <div class="card">
          <div class="section-head"><h3 style="margin:0">Column policies</h3><div class="spacer"></div>
            <button class="button-secondary button-small" id="edit-pols">Edit policies</button></div>
          <div class="card-meta">Unlisted columns default to <strong>conflict</strong> (log, don't write). <span class="mono">resident_id</span> is always protected.</div>
          ${wf.column_policies.length === 0
            ? '<div class="card-meta">No explicit policies. All mapped columns follow the default.</div>'
            : `<div class="table-wrap"><table class="data"><thead><tr><th>Column</th><th>Policy</th></tr></thead>
               <tbody>${wf.column_policies.map((p) => `<tr><td>${esc(p.column_name)}</td><td>${policyChip(p.policy)}</td></tr>`).join('')}</tbody></table></div>`}
        </div>`;
      document.getElementById('back').addEventListener('click', () => navigate('workflows'));
      document.getElementById('edit-wf').addEventListener('click', () => workflowForm(types, wf, connections));
      document.getElementById('edit-maps').addEventListener('click', () => mappingsForm(wf));
      document.getElementById('edit-pols').addEventListener('click', () => policiesForm(wf));
      document.getElementById('del-wf').addEventListener('click', async () => {
        if (!confirm('Delete this workflow and its mappings/policies?')) return;
        await api('DELETE', '/workflows/' + id);
        toast('Workflow deleted', 'success');
        navigate('workflows');
      });
    },

    async sensitive() {
      const rows = await api('GET', '/sensitive-columns');
      viewEl().innerHTML = `
        <div class="section-head"><h2>Sensitive columns</h2><div class="spacer"></div></div>
        <p class="reading-copy" style="margin-top:0">When pushing missing residents to a captain sheet, a row that has a value in any of these columns is still appended, but also <strong>flagged</strong> so you can confirm it's okay to share. This is informational — it never blocks a push.</p>
        <div class="card">
          <form id="add-sensitive" class="button-row" style="align-items:flex-end">
            <div class="field" style="flex:1;margin:0">
              <label for="sc-name">Column header</label>
              <input class="input" id="sc-name" placeholder="e.g. Phone Number" />
            </div>
            <button class="button-primary" type="submit">Add</button>
          </form>
          <ul class="inline-list" style="margin-top:16px">
            ${rows.length === 0 ? '<li class="card-meta">None yet.</li>' : rows.map((r) => `
              <li><span>${esc(r.column_name)}</span><span class="spacer"></span>
              <button class="button-secondary button-small" data-del-sc="${r.id}">Remove</button></li>`).join('')}
          </ul>
        </div>`;
      document.getElementById('add-sensitive').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('sc-name').value.trim();
        if (!name) return;
        try { await api('POST', '/sensitive-columns', { column_name: name }); navigate('sensitive'); }
        catch (err) { toast(err.message, 'error'); }
      });
      viewEl().querySelectorAll('[data-del-sc]').forEach((b) =>
        b.addEventListener('click', async () => { await api('DELETE', '/sensitive-columns/' + b.dataset.delSc); navigate('sensitive'); }));
    },

    async runs() {
      const rows = await api('GET', '/runs');
      viewEl().innerHTML = `
        <div class="section-head"><h2>Run history</h2></div>
        ${rows.length === 0
          ? emptyState('No runs yet', 'Dry runs and live runs will appear here as a permanent audit trail.')
          : `<div class="table-wrap"><table class="data"><thead><tr>
              <th>ID</th><th>Workflow</th><th>Type</th><th>Mode</th><th>Status</th><th>Started</th><th></th></tr></thead>
              <tbody>${rows.map((r) => `<tr>
                <td class="num">${r.id}</td><td>${esc(r.workflow_name || '—')}</td>
                <td>${esc(r.type)}</td><td>${esc(r.mode)}</td><td>${statusPill(r.status)}</td>
                <td>${esc(r.started_at || r.created_at || '')}</td>
                <td><button class="button-secondary button-small" data-open-run="${r.id}">View</button></td>
              </tr>`).join('')}</tbody></table></div>`}`;
      viewEl().querySelectorAll('[data-open-run]').forEach((b) =>
        b.addEventListener('click', () => navigate('runDetail', { id: b.dataset.openRun })));
    },

    async runDetail() {
      const id = state.params.id;
      const [detail, log] = await Promise.all([
        api('GET', '/runs/' + id),
        api('GET', '/runs/' + id + '/log?limit=1000'),
      ]);
      const r = detail.run;
      viewEl().innerHTML = `
        <div class="section-head"><button class="button-secondary button-small" id="back">← Run history</button></div>
        <div class="card">
          <h3>Run #${r.id} — ${esc(r.workflow_name || r.type)}</h3>
          <div class="card-meta">${esc(r.type)} · ${esc(r.mode)} · ${statusPill(r.status)}</div>
          <div class="form-grid">
            ${detail.typeCounts.map((c) => `<div><div class="metric">${c.n}</div><div class="metric-label">${esc(c.type)}</div></div>`).join('') || '<div class="card-meta">No detail entries.</div>'}
          </div>
        </div>
        <div class="card">
          <h3>Detail log</h3>
          ${log.length === 0 ? '<div class="card-meta">No log entries.</div>' : `<div class="table-wrap"><table class="data"><thead><tr>
            <th>Type</th><th>Spreadsheet</th><th>Row</th><th>Column</th><th>resident_id</th><th>Existing</th><th>Incoming</th><th>Message</th></tr></thead>
            <tbody>${log.map((e) => `<tr><td>${esc(e.type)}</td><td class="truncate">${esc(e.spreadsheet)}</td>
              <td>${esc(e.row)}</td><td>${esc(e.column)}</td><td>${esc(e.resident_id)}</td>
              <td class="truncate">${esc(e.existing_value)}</td><td class="truncate">${esc(e.incoming_value)}</td>
              <td class="truncate">${esc(e.message)}</td></tr>`).join('')}</tbody></table></div>`}
        </div>`;
      document.getElementById('back').addEventListener('click', () => navigate('runs'));
    },

    async conflicts() {
      const rows = await api('GET', '/conflicts?status=open');
      viewEl().innerHTML = `
        <div class="section-head"><h2>Open conflicts</h2></div>
        <p class="reading-copy" style="margin-top:0">Conflicts are disagreements between a source and target value where the policy did not allow an overwrite. SheetSmart logs them instead of overwriting, so you can decide.</p>
        ${rows.length === 0
          ? emptyState('No open conflicts', 'When a sync finds disagreements, they will collect here for review.')
          : `<div class="table-wrap"><table class="data"><thead><tr>
              <th>Workflow</th><th>Spreadsheet</th><th>Row</th><th>Column</th><th>Existing</th><th>Incoming</th><th></th></tr></thead>
              <tbody>${rows.map((c) => `<tr><td>${esc(c.workflow_name || c.run_type)}</td>
                <td class="truncate">${esc(c.spreadsheet)}</td><td>${esc(c.row)}</td><td>${esc(c.column)}</td>
                <td class="truncate">${esc(c.existing_value)}</td><td class="truncate">${esc(c.incoming_value)}</td>
                <td><button class="button-secondary button-small" data-resolve="${c.id}">Mark resolved</button></td></tr>`).join('')}</tbody></table></div>`}`;
      viewEl().querySelectorAll('[data-resolve]').forEach((b) =>
        b.addEventListener('click', async () => {
          await api('PUT', '/conflicts/' + b.dataset.resolve, { status: 'resolved' });
          toast('Conflict marked resolved', 'success');
          navigate('conflicts');
        }));
    },
  };

  // ---------- shared partials ----------
  function emptyState(title, body) {
    return `<div class="card"><div class="state"><div class="state-title">${esc(title)}</div><div>${esc(body)}</div></div></div>`;
  }
  function recentRunsTable(runs) {
    if (!runs || runs.length === 0) return emptyState('No runs yet', 'Dry runs and live runs will show up here.');
    return `<div class="table-wrap"><table class="data"><thead><tr>
      <th>ID</th><th>Workflow</th><th>Mode</th><th>Status</th><th>Started</th></tr></thead>
      <tbody>${runs.map((r) => `<tr><td class="num">${r.id}</td><td>${esc(r.workflow_name || r.type)}</td>
        <td>${esc(r.mode)}</td><td>${statusPill(r.status)}</td><td>${esc(r.started_at || '')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function connRow(c) {
    return `<tr>
      <td>${esc(c.name)}</td>
      <td><span class="chip">${esc(c.type)}</span></td>
      <td class="mono truncate">${esc(c.google_id)}</td>
      <td>${esc(c.source_tab || '')}</td>
      <td><div class="button-row">
        <button class="button-secondary button-small" data-test-conn="${c.id}">Test</button>
        <button class="button-secondary button-small" data-edit-conn='${esc(JSON.stringify(c))}'>Edit</button>
        <button class="button-destructive button-small" data-del-conn="${c.id}">Delete</button>
      </div></td></tr>`;
  }
  function policyChip(policy) {
    const map = { fill_blank: 'status-info', overwrite: 'status-warn', conflict: 'status-queued', never: 'status-disconnected' };
    return `<span class="status-pill ${map[policy] || 'status-disconnected'}">${esc(policy)}</span>`;
  }

  // ---------- forms (modals) ----------
  function connectionForm(existing) {
    const c = existing || { name: '', type: 'master', google_id: '', source_tab: '', notes: '' };
    const isEdit = Boolean(existing);
    showModal(`
      <h3>${isEdit ? 'Edit' : 'Add'} connection</h3>
      <form id="conn-form">
        <div class="field"><label>Name</label><input class="input" name="name" value="${esc(c.name)}" required /></div>
        <div class="field"><label>Type</label>
          <select class="select" name="type">
            <option value="master" ${c.type === 'master' ? 'selected' : ''}>Master spreadsheet</option>
            <option value="captain_folder" ${c.type === 'captain_folder' ? 'selected' : ''}>Captain sheets folder</option>
            <option value="external" ${c.type === 'external' ? 'selected' : ''}>External source spreadsheet</option>
          </select></div>
        <div class="field"><label>Google ID</label>
          <input class="input mono" name="google_id" value="${esc(c.google_id)}" required placeholder="Spreadsheet or folder ID from the URL" />
          <div class="hint">From the URL: <span class="mono">.../d/THIS_PART/edit</span> for sheets, <span class="mono">/folders/THIS_PART</span> for folders.</div></div>
        <div class="field"><label>Source tab (optional)</label><input class="input" name="source_tab" value="${esc(c.source_tab)}" placeholder="Leave blank for the first tab" /></div>
        <div class="field"><label>Notes (optional)</label><textarea class="input" name="notes">${esc(c.notes)}</textarea></div>
        <div class="button-row"><button class="button-primary" type="submit">${isEdit ? 'Save' : 'Add'}</button>
          <button class="button-secondary" type="button" data-cancel>Cancel</button></div>
      </form>`);
    modalRoot.querySelector('[data-cancel]').addEventListener('click', closeModal);
    modalRoot.querySelector('#conn-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      try {
        if (isEdit) await api('PUT', '/connections/' + c.id, body);
        else await api('POST', '/connections', body);
        closeModal(); toast('Connection saved', 'success'); navigate('connections');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  async function testConnection(id) {
    toast('Testing connection…');
    try {
      const r = await api('POST', '/test-connection', { connectionId: id });
      if (r.kind === 'folder') {
        showModal(`<h3>Folder connected ✓</h3>
          <p>Found <strong>${r.count}</strong> spreadsheet(s).</p>
          <div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Modified</th></tr></thead>
          <tbody>${r.spreadsheets.slice(0, 100).map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.modifiedTime || '')}</td></tr>`).join('')}</tbody></table></div>
          <div class="button-row" style="margin-top:16px"><button class="button-primary" data-cancel>Close</button></div>`);
      } else {
        showModal(`<h3>Spreadsheet connected ✓</h3>
          <p><strong>${esc(r.title)}</strong> — read tab "${esc(r.tabRead)}" with <strong>${r.headerCount}</strong> columns.</p>
          <div class="field"><label>Headers</label>
          <div>${r.headers.filter(Boolean).map((h) => `<span class="chip" style="margin:2px">${esc(h)}</span>`).join('')}</div></div>
          <div class="button-row" style="margin-top:16px"><button class="button-primary" data-cancel>Close</button></div>`);
      }
      modalRoot.querySelector('[data-cancel]').addEventListener('click', closeModal);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deleteConnection(id) {
    if (!confirm('Delete this connection?')) return;
    await api('DELETE', '/connections/' + id);
    toast('Connection deleted', 'success');
    navigate('connections');
  }

  function workflowForm(types, existing, connectionsMaybe) {
    const isEdit = Boolean(existing);
    const w = existing || { name: '', type: types[0].type, match_column: '', source_tab: '', notes: '', source_connection_id: '', target_connection_id: '' };
    const build = (connections) => {
      const opts = (sel) => `<option value="">—</option>` + connections.map((c) =>
        `<option value="${c.id}" ${String(sel) === String(c.id) ? 'selected' : ''}>${esc(c.name)} (${esc(c.type)})</option>`).join('');
      showModal(`
        <h3>${isEdit ? 'Edit' : 'New'} workflow</h3>
        <form id="wf-form">
          <div class="field"><label>Name</label><input class="input" name="name" value="${esc(w.name)}" required /></div>
          <div class="field"><label>Type</label>
            <select class="select" name="type" ${isEdit ? 'disabled' : ''}>
              ${types.map((t) => `<option value="${t.type}" ${t.type === w.type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
            </select></div>
          <div class="form-grid">
            <div class="field"><label>Source connection</label><select class="select" name="source_connection_id">${opts(w.source_connection_id)}</select></div>
            <div class="field"><label>Target connection</label><select class="select" name="target_connection_id">${opts(w.target_connection_id)}</select></div>
          </div>
          <div class="form-grid">
            <div class="field"><label>Match column</label><input class="input" name="match_column" value="${esc(w.match_column)}" placeholder="e.g. resident_id or APN" /></div>
            <div class="field"><label>Source tab</label><input class="input" name="source_tab" value="${esc(w.source_tab)}" placeholder="(first tab)" /></div>
          </div>
          <div class="field"><label>Notes</label><textarea class="input" name="notes">${esc(w.notes)}</textarea></div>
          <div class="button-row"><button class="button-primary" type="submit">${isEdit ? 'Save' : 'Create'}</button>
            <button class="button-secondary" type="button" data-cancel>Cancel</button></div>
        </form>`);
      modalRoot.querySelector('[data-cancel]').addEventListener('click', closeModal);
      modalRoot.querySelector('#wf-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(e.target).entries());
        if (isEdit) delete body.type;
        try {
          const saved = isEdit ? await api('PUT', '/workflows/' + w.id, body) : await api('POST', '/workflows', body);
          closeModal(); toast('Workflow saved', 'success');
          navigate('workflowDetail', { id: saved.id });
        } catch (err) { toast(err.message, 'error'); }
      });
    };
    if (connectionsMaybe) build(connectionsMaybe);
    else api('GET', '/connections').then(build);
  }

  function mappingsForm(wf) {
    let maps = wf.column_mappings.length ? wf.column_mappings.slice() : [{ source_column: '', target_column: '' }];
    const render = () => {
      showModal(`
        <h3>Column mappings — ${esc(wf.name)}</h3>
        <div class="hint" style="margin-bottom:12px">Each row maps a source column to the target column it should fill.</div>
        <div id="map-rows">${maps.map((m, i) => mapRow(m, i)).join('')}</div>
        <div class="button-row"><button class="button-secondary button-small" id="add-row" type="button">+ Add row</button></div>
        <div class="button-row" style="margin-top:16px"><button class="button-primary" id="save-maps">Save mappings</button>
          <button class="button-secondary" data-cancel type="button">Cancel</button></div>`);
      modalRoot.querySelector('[data-cancel]').addEventListener('click', closeModal);
      modalRoot.querySelector('#add-row').addEventListener('click', () => { collect(); maps.push({ source_column: '', target_column: '' }); render(); });
      modalRoot.querySelectorAll('[data-del-row]').forEach((b) => b.addEventListener('click', () => { collect(); maps.splice(Number(b.dataset.delRow), 1); render(); }));
      modalRoot.querySelector('#save-maps').addEventListener('click', async () => {
        collect();
        const clean = maps.filter((m) => m.source_column.trim() && m.target_column.trim());
        try { await api('PUT', '/workflows/' + wf.id + '/mappings', { mappings: clean }); closeModal(); toast('Mappings saved', 'success'); navigate('workflowDetail', { id: wf.id }); }
        catch (err) { toast(err.message, 'error'); }
      });
    };
    const collect = () => {
      modalRoot.querySelectorAll('[data-map-row]').forEach((row) => {
        const i = Number(row.dataset.mapRow);
        maps[i] = {
          source_column: row.querySelector('[name=source]').value,
          target_column: row.querySelector('[name=target]').value,
        };
      });
    };
    const mapRow = (m, i) => `<div class="button-row" data-map-row="${i}" style="margin-bottom:8px">
      <input class="input" name="source" placeholder="Source column" value="${esc(m.source_column)}" />
      <input class="input" name="target" placeholder="Target column" value="${esc(m.target_column)}" />
      <button class="button-secondary button-small" type="button" data-del-row="${i}">✕</button></div>`;
    render();
  }

  function policiesForm(wf) {
    const POLICIES = ['fill_blank', 'overwrite', 'conflict', 'never'];
    let pols = wf.column_policies.length ? wf.column_policies.slice() : [{ column_name: '', policy: 'fill_blank' }];
    const render = () => {
      showModal(`
        <h3>Column policies — ${esc(wf.name)}</h3>
        <div class="hint" style="margin-bottom:12px">Unlisted columns default to <strong>conflict</strong>. <span class="mono">resident_id</span> is always protected.</div>
        <div id="pol-rows">${pols.map((p, i) => polRow(p, i)).join('')}</div>
        <div class="button-row"><button class="button-secondary button-small" id="add-row" type="button">+ Add row</button></div>
        <div class="button-row" style="margin-top:16px"><button class="button-primary" id="save-pols">Save policies</button>
          <button class="button-secondary" data-cancel type="button">Cancel</button></div>`);
      modalRoot.querySelector('[data-cancel]').addEventListener('click', closeModal);
      modalRoot.querySelector('#add-row').addEventListener('click', () => { collect(); pols.push({ column_name: '', policy: 'fill_blank' }); render(); });
      modalRoot.querySelectorAll('[data-del-row]').forEach((b) => b.addEventListener('click', () => { collect(); pols.splice(Number(b.dataset.delRow), 1); render(); }));
      modalRoot.querySelector('#save-pols').addEventListener('click', async () => {
        collect();
        const clean = pols.filter((p) => p.column_name.trim());
        try { await api('PUT', '/workflows/' + wf.id + '/policies', { policies: clean }); closeModal(); toast('Policies saved', 'success'); navigate('workflowDetail', { id: wf.id }); }
        catch (err) { toast(err.message, 'error'); }
      });
    };
    const collect = () => {
      modalRoot.querySelectorAll('[data-pol-row]').forEach((row) => {
        const i = Number(row.dataset.polRow);
        pols[i] = { column_name: row.querySelector('[name=col]').value, policy: row.querySelector('[name=pol]').value };
      });
    };
    const polRow = (p, i) => `<div class="button-row" data-pol-row="${i}" style="margin-bottom:8px">
      <input class="input" name="col" placeholder="Column name" value="${esc(p.column_name)}" />
      <select class="select" name="pol">${POLICIES.map((x) => `<option value="${x}" ${x === p.policy ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <button class="button-secondary button-small" type="button" data-del-row="${i}">✕</button></div>`;
    render();
  }

  // ---------- boot ----------
  async function boot() {
    renderShell();
    navigate('dashboard');
  }

  async function init() {
    try {
      const s = await api('GET', '/session');
      if (s.authenticated) boot();
      else renderLogin();
    } catch (e) {
      renderLogin();
    }
  }

  return { init };
})();

App.init();

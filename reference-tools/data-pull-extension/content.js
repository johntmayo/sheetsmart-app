const SHEET_ID = (window.CONFIG || globalThis.CONFIG).SHEET_ID;

function getSheetIdFromUrl() {
  try {
    const m = window.location.pathname.match(/\/spreadsheets\/d\/([^\/]+)/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function ensureUI() {
  if (document.getElementById('data-pull-btn')) return;
  const container = document.createElement('div');
  container.id = 'data-pull-container';

  const btn = document.createElement('button');
  btn.id = 'data-pull-btn';
  btn.textContent = 'Do a data pull';

  const progress = document.createElement('div');
  progress.id = 'data-pull-progress';
  progress.innerHTML = `<div class="bar"><div class="fill" style="width:0%"></div></div><div class="label">Idle</div>`;

  container.appendChild(btn);
  container.appendChild(progress);
  document.body.appendChild(container);

  btn.addEventListener('click', () => {
    btn.disabled = true;
    document.querySelector('#data-pull-progress .label').textContent = 'Starting…';
    try {
      if (!chrome.runtime?.id) {
        document.querySelector('#data-pull-progress .label').textContent = 'Extension reloaded. Refresh this tab and try again.';
        btn.disabled = false;
        return;
      }
      chrome.runtime.sendMessage({ type: 'RUN_DATA_PULL' }, (res) => {
        const runtimeErr = chrome.runtime?.lastError;
        if (runtimeErr) {
          document.querySelector('#data-pull-progress .label').textContent = 'Extension reloaded. Refresh this tab and try again.';
          btn.disabled = false;
          return;
        }
        if (!res || !res.ok) {
          document.querySelector('#data-pull-progress .label').textContent = (res && res.error) ? res.error : 'Error';
        }
        btn.disabled = false;
      });
    } catch (e) {
      document.querySelector('#data-pull-progress .label').textContent = 'Extension reloaded. Refresh this tab and try again.';
      btn.disabled = false;
    }
  });
}

function removeUI() {
  const el = document.getElementById('data-pull-container');
  if (el) el.remove();
}

function showOrHide() {
  const currentId = getSheetIdFromUrl();
  if (currentId === SHEET_ID) ensureUI();
  else removeUI();
}

showOrHide();
const observer = new MutationObserver(() => showOrHide());
observer.observe(document.documentElement, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'DATA_PULL_PROGRESS') return;
  const fill = document.querySelector('#data-pull-progress .fill');
  const label = document.querySelector('#data-pull-progress .label');
  if (!fill || !label) return;
  fill.style.width = (msg.percent ?? 0) + '%';
  label.textContent = msg.message || '';
  if (msg.stage === 'error') label.textContent = 'Error: ' + (msg.message || '');
  else if (msg.stage === 'done') label.textContent = 'Done! Wrote results to a new tab.';
});

import './config.js';
import { randomString, sha256 } from './pkce.js';
const CONFIG = globalThis.CONFIG;
const BUILD_STAMP = CONFIG.BUILD_STAMP || '2026-02-16-debug-b';
const TEMPLATE_VALIDATION = CONFIG.TEMPLATE_VALIDATION || {
  DATA_SHEET_TITLE: '',
  TEMPLATE_SHEET_TITLE: '',
  TEMPLATE_ROW_NUMBER: 2,
  SKIP_TEMPLATE_ROW_IN_OUTPUT: true,
  COLUMN_HEADERS: [],
  DEBUG_VALIDATION: false
};
function swLog(...args) {
  console.log(`[SpreadsheetDataPull ${BUILD_STAMP}]`, ...args);
}
swLog('service worker script loaded');
chrome.runtime.onInstalled.addListener((details) => {
  swLog('onInstalled', details?.reason || 'unknown');
});
chrome.runtime.onStartup.addListener(() => {
  swLog('onStartup');
});

// --- OAuth storage ---
let oauth = { access_token: null, refresh_token: null, expiry: 0 };
chrome.storage.local.get(['oauth']).then(data => { if (data && data.oauth) oauth = data.oauth; });
async function saveOAuth() { await chrome.storage.local.set({ oauth }); }
function isTokenValid() { return oauth.access_token && (Date.now() < oauth.expiry - 60_000); }

async function refreshTokenIfNeeded() {
  if (isTokenValid()) return;
  if (!oauth.refresh_token) return;
  const redirectUri = chrome.identity.getRedirectURL();
  const body = new URLSearchParams({
    client_id: CONFIG.CLIENT_ID, 
    grant_type: 'refresh_token',
    refresh_token: oauth.refresh_token
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  if (!res.ok) { oauth = { access_token:null, refresh_token:null, expiry:0 }; await saveOAuth(); return; }
  const data = await res.json();
  oauth.access_token = data.access_token;
  oauth.expiry = Date.now() + (data.expires_in * 1000);
  await saveOAuth();
}

async function googleAuth() {
  await refreshTokenIfNeeded();
  if (isTokenValid()) return oauth;
  
  // Use chrome.identity API for OAuth flow
  const redirectUri = chrome.identity.getRedirectURL();
  const scope = 'https://www.googleapis.com/auth/spreadsheets';
  
  // For Chrome extensions, we can use chrome.identity.getAuthToken or launchWebAuthFlow
  // Using launchWebAuthFlow with implicit flow for simplicity
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth' +
    `?client_id=${encodeURIComponent(CONFIG.CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=token` +  // Changed to implicit flow
    `&scope=${encodeURIComponent(scope)}` +
    `&access_type=online`;
  
  try {
    const redirect = await chrome.identity.launchWebAuthFlow({ 
      interactive: true, 
      url: authUrl 
    });
    
    // Parse the access token from the URL fragment
    const url = new URL(redirect);
    const params = new URLSearchParams(url.hash.substring(1)); // Remove the #
    const accessToken = params.get('access_token');
    const expiresIn = params.get('expires_in');
    
    if (!accessToken) throw new Error('No access token returned');
    
    oauth.access_token = accessToken;
    oauth.expiry = Date.now() + (parseInt(expiresIn || '3600') * 1000);
    // Note: Implicit flow doesn't provide refresh tokens
    await saveOAuth();
    return oauth;
  } catch (error) {
    console.error('Auth error:', error);
    throw error;
  }
}

// Alternative: If you must use authorization code flow with PKCE
async function googleAuthWithPKCE() {
  await refreshTokenIfNeeded();
  if (isTokenValid()) return oauth;
  
  const verifier = randomString(64);
  const challenge = await sha256(verifier);
  const scope = 'https://www.googleapis.com/auth/spreadsheets';
  const redirectUri = chrome.identity.getRedirectURL();
  
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth' +
    `?client_id=${encodeURIComponent(CONFIG.CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scope)}` +
    `&access_type=offline` +
    `&prompt=consent` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&code_challenge_method=S256`;
  
  try {
    const redirect = await chrome.identity.launchWebAuthFlow({ 
      interactive: true, 
      url: authUrl 
    });
    
    const url = new URL(redirect); 
    const code = url.searchParams.get('code');
    if (!code) throw new Error('No authorization code returned');
    
    // For web application client type, include client_secret
    // For Chrome extension (installed application), omit it
    const tokenBody = {
      client_id: CONFIG.CLIENT_ID,
      code: code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    };
    
    // Only include client_secret if it exists and is not a placeholder
    if (CONFIG.CLIENT_SECRET && CONFIG.CLIENT_SECRET !== 'YOUR_CLIENT_SECRET_HERE') {
      tokenBody.client_secret = CONFIG.CLIENT_SECRET;
    }
    
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenBody)
    });
    
    if (!tokenRes.ok) {
      const errorText = await tokenRes.text();
      throw new Error('Token exchange failed: ' + errorText);
    }
    
    const data = await tokenRes.json();
    oauth.access_token = data.access_token;
    oauth.refresh_token = data.refresh_token || oauth.refresh_token;
    oauth.expiry = Date.now() + (data.expires_in * 1000);
    await saveOAuth();
    return oauth;
  } catch (error) {
    console.error('Auth error:', error);
    throw error;
  }
}

// --- Sheets helpers ---
async function sheetsGet(spreadsheetId) {
  await refreshTokenIfNeeded(); 
  if (!isTokenValid()) await googleAuthWithPKCE(); // or use googleAuth() for implicit flow
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
    headers: { Authorization: `Bearer ${oauth.access_token}` }
  });
  if (!res.ok) throw new Error('sheetsGet failed'); 
  return await res.json();
}

async function sheetsValuesGet(spreadsheetId, rangeA1) {
  await refreshTokenIfNeeded(); 
  if (!isTokenValid()) await googleAuthWithPKCE();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(rangeA1)}`, {
    headers: { Authorization: `Bearer ${oauth.access_token}` }
  });
  if (!res.ok) throw new Error('values.get failed'); 
  return await res.json();
}

async function sheetsBatchUpdate(spreadsheetId, body) {
  await refreshTokenIfNeeded(); 
  if (!isTokenValid()) await googleAuthWithPKCE();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST', 
    headers: { 
      Authorization: `Bearer ${oauth.access_token}`, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('batchUpdate failed: ' + (await res.text()));
  return await res.json();
}

async function sheetsValuesUpdate(spreadsheetId, rangeA1, values) {
  await refreshTokenIfNeeded(); 
  if (!isTokenValid()) await googleAuthWithPKCE();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(rangeA1)}?valueInputOption=RAW`, {
    method: 'PUT', 
    headers: { 
      Authorization: `Bearer ${oauth.access_token}`, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ range: rangeA1, majorDimension: 'ROWS', values })
  });
  if (!res.ok) throw new Error('values.update failed: ' + (await res.text()));
  return await res.json();
}

async function sheetsGetValidationGrid(spreadsheetId, rangeA1) {
  await refreshTokenIfNeeded();
  if (!isTokenValid()) await googleAuthWithPKCE();
  const fields = 'sheets(data(startRow,startColumn,rowData(values(dataValidation))))';
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` +
    `?includeGridData=true&fields=${encodeURIComponent(fields)}` +
    `&ranges=${encodeURIComponent(rangeA1)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${oauth.access_token}` }
  });
  if (!res.ok) throw new Error('sheetsGetValidationGrid failed: ' + (await res.text()));
  return await res.json();
}

function normalizeHeaderName(value) {
  return (value || '')
    .toString()
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-') // Normalize Unicode dash variants.
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .replace(/[^a-z0-9- ]/g, '')
    .trim();
}

function pickSheetByTitle(sheets, title) {
  const wanted = (title || '').toString().trim().toLowerCase();
  if (!wanted) return null;
  return (sheets || []).find(s => ((s?.title || '').toString().trim().toLowerCase() === wanted)) || null;
}

async function copyTemplateValidationsToOutput({
  spreadsheetId,
  sourceSheetTitle,
  destSheetId,
  outHeader,
  outRowsCount,
  templateRowNumber,
  validationColumnHeaders,
  debugValidation,
  progressCb
}) {
  if (!Number.isInteger(destSheetId)) {
    return { matchedHeaders: 0, targetHeaders: 0, requestCount: 0 };
  }
  if (!Array.isArray(validationColumnHeaders) || validationColumnHeaders.length === 0) {
    throw new Error('No TEMPLATE_VALIDATION.COLUMN_HEADERS configured in config.js.');
  }
  if (outRowsCount <= 1) {
    return { matchedHeaders: 0, targetHeaders: validationColumnHeaders.length, requestCount: 0 };
  }

  const destRowStart = 1; // Skip header row.
  const destRowEnd = outRowsCount; // End index is exclusive.
  const requests = [];
  const normalizedHeaderToIndices = new Map();
  for (let i = 0; i < outHeader.length; i++) {
    const normalized = normalizeHeaderName(outHeader[i]);
    if (!normalized) continue;
    if (!normalizedHeaderToIndices.has(normalized)) normalizedHeaderToIndices.set(normalized, []);
    normalizedHeaderToIndices.get(normalized).push(i);
  }

  const uniqueTargetHeaders = Array.from(
    new Set(validationColumnHeaders.map(h => (h || '').toString().trim()).filter(Boolean))
  );
  const missingHeaders = [];
  const ambiguousHeaders = [];
  const matchedColumns = [];

  for (const headerName of uniqueTargetHeaders) {
    const normalized = normalizeHeaderName(headerName);
    const indices = normalizedHeaderToIndices.get(normalized) || [];
    if (indices.length === 0) {
      missingHeaders.push(headerName);
      continue;
    }
    if (indices.length > 1) {
      ambiguousHeaders.push(`${headerName} (${indices.length} matches)`);
      continue;
    }
    matchedColumns.push({ headerName, columnIndex: indices[0] });
  }

  if (debugValidation) {
    swLog('validation target headers', uniqueTargetHeaders);
    swLog('validation matched columns', matchedColumns);
    swLog('validation missing headers', missingHeaders);
    swLog('validation ambiguous headers', ambiguousHeaders);
  }

  if (missingHeaders.length || ambiguousHeaders.length) {
    const parts = [];
    if (missingHeaders.length) parts.push(`missing: ${missingHeaders.join(', ')}`);
    if (ambiguousHeaders.length) parts.push(`ambiguous: ${ambiguousHeaders.join(', ')}`);
    throw new Error(`Validation header lookup failed (${parts.join(' | ')}).`);
  }

  if (matchedColumns.length === 0) {
    throw new Error('No validation columns matched. Check TEMPLATE_VALIDATION.COLUMN_HEADERS in config.js.');
  }

  if (!sourceSheetTitle) throw new Error('Template sheet title is required for validation copy.');
  const maxCol = matchedColumns.reduce((m, x) => Math.max(m, x.columnIndex), 0);
  const scanWidth = maxCol + 1;
  const a1Title = sourceSheetTitle.replace(/'/g, "''");
  const templateRowA1 = `'${a1Title}'!A${templateRowNumber}:` +
    `${columnIndexToA1(scanWidth - 1)}${templateRowNumber}`;
  const grid = await sheetsGetValidationGrid(spreadsheetId, templateRowA1);
  const rowValues = grid?.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || [];
  const sourceValidationSummary = matchedColumns.map(({ headerName, columnIndex }) => {
    const dv = rowValues[columnIndex]?.dataValidation || null;
    return {
      header: headerName,
      colIndex: columnIndex,
      hasValidation: Boolean(dv),
      conditionType: dv?.condition?.type || null,
      strict: dv?.strict ?? null,
      rule: dv
    };
  });
  if (debugValidation) swLog('template row validation summary', sourceValidationSummary.map(x => ({
    header: x.header,
    colIndex: x.colIndex,
    hasValidation: x.hasValidation,
    conditionType: x.conditionType,
    strict: x.strict
  })));
  const columnsWithValidation = sourceValidationSummary.filter(x => x.hasValidation);
  const headersWithoutValidation = sourceValidationSummary.filter(x => !x.hasValidation).map(x => x.header);
  if (headersWithoutValidation.length && debugValidation) {
    swLog(`skipping headers without validation on template row ${templateRowNumber}`, headersWithoutValidation);
    progressCb?.({
      stage: 'write',
      percent: 99,
      message: `Skipping ${headersWithoutValidation.length} columns missing validation on template row ${templateRowNumber}`
    });
  }
  if (columnsWithValidation.length === 0) {
    throw new Error(
      `Template row ${templateRowNumber} has no validation for configured columns: ${uniqueTargetHeaders.join(', ')}`
    );
  }

  for (const { colIndex, rule } of columnsWithValidation) {
    requests.push({
      repeatCell: {
        range: {
          sheetId: destSheetId,
          startRowIndex: destRowStart,
          endRowIndex: destRowEnd,
          startColumnIndex: colIndex,
          endColumnIndex: colIndex + 1
        },
        cell: {
          dataValidation: JSON.parse(JSON.stringify(rule))
        },
        fields: 'dataValidation'
      }
    });
  }

  if (debugValidation) {
    progressCb?.({
      stage: 'write',
      percent: 99,
      message: `Validation match: ${matchedColumns.length}/${uniqueTargetHeaders.length}; copy requests: ${requests.length}`
    });
  }

  if (requests.length === 0) return { matchedHeaders: 0, targetHeaders: uniqueTargetHeaders.length, requestCount: 0 };
  await sheetsBatchUpdate(spreadsheetId, { requests });
  return {
    matchedHeaders: columnsWithValidation.length,
    targetHeaders: uniqueTargetHeaders.length,
    requestCount: requests.length
  };
}

function columnIndexToA1(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// --- Mapbox fetch ---
async function fetchMapboxFeatures() {
  const url = `https://api.mapbox.com/datasets/v1/${CONFIG.MAPBOX.USERNAME}/${CONFIG.MAPBOX.DATASET_ID}/features?access_token=${CONFIG.MAPBOX.TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch Mapbox dataset features');
  return await res.json();
}

// --- Geometry helpers (bbox + ray casting) ---
function computeBBoxForGeom(geom) {
  const coords = [];
  const gather = (arr) => { 
    for (const item of arr) { 
      if (typeof item[0] === 'number') coords.push(item); 
      else gather(item); 
    } 
  };
  if (geom && geom.coordinates) gather(geom.coordinates);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) { 
    if (x < minX) minX = x; 
    if (y < minY) minY = y; 
    if (x > maxX) maxX = x; 
    if (y > maxY) maxY = y; 
  }
  return [minX, minY, maxX, maxY];
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(pt, poly) {
  if (!pointInRing(pt, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) 
    if (pointInRing(pt, poly[k])) return false;
  return true;
}

function pointInMultiPolygon(pt, multi) { 
  for (const p of multi) 
    if (pointInPolygon(pt, p)) return true; 
  return false; 
}

function buildSpatialIndex(fc) {
  const index = []; 
  for (const f of fc.features) { 
    if (!f.geometry) continue; 
    index.push({ bbox: computeBBoxForGeom(f.geometry), feature: f }); 
  } 
  return index;
}

function bboxContains([minX, minY, maxX, maxY], [x, y]) { 
  return x >= minX && x <= maxX && y >= minY && y <= maxY; 
}

function findContainingFeature(index, pt) {
  for (const e of index) {
    if (!bboxContains(e.bbox, pt)) continue;
    const g = e.feature.geometry;
    if (g.type === 'Polygon') { 
      if (pointInPolygon(pt, g.coordinates)) return e.feature; 
    }
    else if (g.type === 'MultiPolygon') { 
      if (pointInMultiPolygon(pt, g.coordinates)) return e.feature; 
    }
  }
  return null;
}

// --- Main processing ---
async function processSheet(progressCb) {
  progressCb({ stage: 'auth', percent: 1, message: `Build ${BUILD_STAMP}` });
  swLog('processSheet start');
  progressCb({ stage: 'auth', percent: 5, message: 'Authorizing with Google…' }); 
  await googleAuthWithPKCE();
  
  progressCb({ stage: 'mapbox', percent: 15, message: 'Fetching Mapbox zones…' }); 
  const zones = await fetchMapboxFeatures(); 
  const index = buildSpatialIndex(zones);
  
  progressCb({ stage: 'read', percent: 25, message: 'Reading sheet data…' });
  const meta = await sheetsGet(CONFIG.SHEET_ID);
  const allSheets = (meta.sheets || []).map(s => s.properties).sort((a, b) => a.index - b.index);
  const firstSheet = allSheets[0];
  if (!firstSheet) throw new Error('No sheets found');

  const dataSheet =
    pickSheetByTitle(allSheets, TEMPLATE_VALIDATION.DATA_SHEET_TITLE);
  if (!TEMPLATE_VALIDATION.DATA_SHEET_TITLE) throw new Error('Set TEMPLATE_VALIDATION.DATA_SHEET_TITLE in config.js.');
  if (!dataSheet) throw new Error(`Data tab not found: ${TEMPLATE_VALIDATION.DATA_SHEET_TITLE}`);
  swLog('data sheet selected', dataSheet.title);

  const templateSheet =
    pickSheetByTitle(allSheets, TEMPLATE_VALIDATION.TEMPLATE_SHEET_TITLE);
  if (!TEMPLATE_VALIDATION.TEMPLATE_SHEET_TITLE) throw new Error('Set TEMPLATE_VALIDATION.TEMPLATE_SHEET_TITLE in config.js.');
  if (!templateSheet) throw new Error(`Template tab not found: ${TEMPLATE_VALIDATION.TEMPLATE_SHEET_TITLE}`);
  swLog('template sheet selected', templateSheet.title);

  const sheetTitle = dataSheet.title;
  const valuesResp = await sheetsValuesGet(CONFIG.SHEET_ID, `${sheetTitle}!A1:ZZ`);
  const rows = valuesResp.values || []; 
  if (rows.length === 0) throw new Error('Empty sheet');

  let lonIdx = CONFIG.LONG_COL_INDEX, latIdx = CONFIG.LAT_COL_INDEX;
  const header = rows[0] || []; 
  const headerLower = header.map(h => (h || '').toString().toLowerCase());
  const candLon = headerLower.findIndex(h => ['lon', 'longitude', 'long'].includes(h));
  const candLat = headerLower.findIndex(h => ['lat', 'latitude'].includes(h));
  if (candLon >= 0) lonIdx = candLon; 
  if (candLat >= 0) latIdx = candLat;

  const OUTPUT_FIELDS = [
    { source: 'ZoneName', label: 'ZoneName' },
    { source: 'ContactName', label: 'NC Name' },
    { source: 'ContactPhone', label: 'NC Phone' },
    { source: 'ContactEmail', label: 'NC Email' }
  ];
  const baseHeader = header.length ? header : [];
  const outHeader = baseHeader.concat(OUTPUT_FIELDS.map(f => f.label));
  const outRows = [outHeader];
  const templateRowIndex = Math.max(1, (TEMPLATE_VALIDATION.TEMPLATE_ROW_NUMBER || 2) - 1);

  for (let i = 1; i < rows.length; i++) {
    if (TEMPLATE_VALIDATION.SKIP_TEMPLATE_ROW_IN_OUTPUT && i === templateRowIndex) continue;
    if (i % 50 === 0) 
      progressCb({ 
        stage: 'join', 
        percent: Math.min(90, 25 + Math.floor((i / rows.length) * 60)), 
        message: `Processing row ${i}/${rows.length - 1}…` 
      });
    
    const row = rows[i]; 
    const padded = row.slice(); 
    while (padded.length < baseHeader.length) padded.push('');
    
    const lon = Number(padded[lonIdx]); 
    const lat = Number(padded[latIdx]);
    
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      const additions = OUTPUT_FIELDS.map(() => '');
      outRows.push(padded.concat(additions)); 
      continue;
    }
    
    const feat = findContainingFeature(index, [lon, lat]); 
    const props = feat ? (feat.properties || {}) : {};
    const additions = OUTPUT_FIELDS.map(({ source }) => props[source] ?? '');
    outRows.push(padded.concat(additions));
  }

  progressCb({ stage: 'write', percent: 92, message: 'Creating output sheet…' });
  const newTitle = `Zones Join ${new Date().toISOString().slice(0, 10)}`;
  const createResp = await sheetsBatchUpdate(CONFIG.SHEET_ID, { 
    requests: [{ addSheet: { properties: { title: newTitle } } }] 
  });
  const outSheetId = createResp?.replies?.[0]?.addSheet?.properties?.sheetId;
  
  const range = `${newTitle}!A1`;
  progressCb({ stage: 'write', percent: 96, message: 'Writing results…' });
  await sheetsValuesUpdate(CONFIG.SHEET_ID, range, outRows);
  progressCb({ stage: 'write', percent: 98, message: 'Applying dropdowns and checkboxes…' });
  const validationResult = await copyTemplateValidationsToOutput({
    spreadsheetId: CONFIG.SHEET_ID,
    sourceSheetTitle: templateSheet.title,
    destSheetId: outSheetId,
    outHeader,
    outRowsCount: outRows.length,
    templateRowNumber: TEMPLATE_VALIDATION.TEMPLATE_ROW_NUMBER,
    validationColumnHeaders: TEMPLATE_VALIDATION.COLUMN_HEADERS,
    debugValidation: Boolean(TEMPLATE_VALIDATION.DEBUG_VALIDATION),
    progressCb
  });
  if (TEMPLATE_VALIDATION.DEBUG_VALIDATION) {
    swLog('validation copy result', validationResult);
    progressCb({
      stage: 'write',
      percent: 99,
      message: `Validation copied: ${validationResult.requestCount} columns from template row ${TEMPLATE_VALIDATION.TEMPLATE_ROW_NUMBER}`
    });
  }
  progressCb({ stage: 'done', percent: 100, message: 'Done!' });
}

function sendProgressToTab(tabId, payload) {
  if (!Number.isInteger(tabId)) return;
  try {
    chrome.tabs.sendMessage(tabId, payload, () => {
      // Consume lastError to avoid noisy extension error entries when the tab refreshes.
      const err = chrome.runtime.lastError;
      if (err && TEMPLATE_VALIDATION.DEBUG_VALIDATION) {
        swLog('progress delivery skipped', err.message || String(err));
      }
    });
  } catch (err) {
    if (TEMPLATE_VALIDATION.DEBUG_VALIDATION) {
      swLog('progress delivery failed', String(err));
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'RUN_DATA_PULL') {
    swLog('received RUN_DATA_PULL message');
    (async () => {
      try {
        const tabId = sender?.tab?.id;
        const progressCb = (p) => { 
          sendProgressToTab(tabId, { type: 'DATA_PULL_PROGRESS', ...p });
        };
        await processSheet(progressCb);
        sendResponse({ ok: true });
      } catch (e) {
        const tabId = sender?.tab?.id;
        sendProgressToTab(tabId, {
          type: 'DATA_PULL_PROGRESS', 
          stage: 'error', 
          percent: 100, 
          message: String(e) 
        });
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});
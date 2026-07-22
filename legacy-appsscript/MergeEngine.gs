// ============================================================
// MergeEngine.gs — Core Merge Infrastructure
// ============================================================
// Lookup-and-merge engine for integrating data across Google
// Spreadsheets. Reads a config spreadsheet to know which source
// to pull from, which column to match on, and which columns to
// map. Fills blank target cells from the source and logs
// conflicts (non-blank cells with differing values) for manual
// review. Designed to be pasted into the same Apps Script
// project as Corrections.gs; all functions share one namespace.
// ============================================================

var SOURCE_LOOKUP_ROW_NUMBER_KEY_ = '__sheetSmartSourceRowNumber';

/**
 * Reads the Settings and Column Mapping tabs from the config
 * spreadsheet and returns a structured config object.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSpreadsheet
 * @return {{ sourceId: string, sourceTabName: string, matchColumn: string, folderId: string, masterId: string, renameFrom: string, renameTo: string, columnMap: Array<{source: string, target: string}>, sensitiveColumns: Array<string>, pullColumnPolicies: Object }}
 */
function readMergeConfig_(configSpreadsheet) {
  var settingsSheet = configSpreadsheet.getSheetByName('Settings');
  var settingsData = settingsSheet.getDataRange().getValues();

  var settings = {};
  for (var i = 0; i < settingsData.length; i++) {
    var key = String(settingsData[i][0]).trim();
    var val = String(settingsData[i][1]).trim();
    if (key !== '') settings[key] = val;
  }

  var mappingSheet = configSpreadsheet.getSheetByName('Column Mapping');
  var mappingData = mappingSheet.getDataRange().getValues();
  var columnMap = [];

  for (var j = 1; j < mappingData.length; j++) {
    var src = String(mappingData[j][0]).trim();
    var tgt = String(mappingData[j][1]).trim();
    // Skip blank rows and placeholder text like "(header name in master)"
    if (src === '' || tgt === '') continue;
    if (src.charAt(0) === '(' && src.charAt(src.length - 1) === ')') continue;
    if (tgt.charAt(0) === '(' && tgt.charAt(tgt.length - 1) === ')') continue;
    columnMap.push({ source: src, target: tgt });
  }

  return {
    masterId:         settings['Master Spreadsheet'] || '',
    sourceId:         settings['External Source'] || settings['Source Spreadsheet'] || '',
    sourceTabName:    settings['Source Tab Name'] || '',
    userSheetId:      settings['User Sheet'] || '',
    folderId:         settings['User Sheets Folder'] || settings['Target Folder'] || '',
    matchColumn:      settings['Match Column'] || '',
    renameFrom:       settings['Rename Column - From'] || '',
    renameTo:         settings['Rename Column - To'] || '',
    columnMap:        columnMap,
    sensitiveColumns: parseSensitiveColumns_(settings['Sensitive Columns'] || ''),
    pullColumnPolicies: readPullColumnPolicies_(configSpreadsheet)
  };
}

/**
 * Reads task-oriented workflow presets from the "Workflow Presets" tab.
 * These presets power the sidebar UI while keeping the existing Settings
 * and Column Mapping tabs available for the legacy menu operations.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSpreadsheet
 * @return {Array<Object>}
 */
function readWorkflowPresets_(configSpreadsheet) {
  var tab = configSpreadsheet.getSheetByName('Workflow Presets');
  if (!tab) return [];

  var data = tab.getDataRange().getValues();
  if (data.length < 2) return [];

  var headers = data[0].map(function (h) { return String(h).trim(); });
  var presets = [];

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var preset = {
      id: getRowValueByHeader_(row, headers, 'Workflow ID'),
      name: getRowValueByHeader_(row, headers, 'Workflow Name'),
      operation: getRowValueByHeader_(row, headers, 'Operation'),
      enabled: normalizeYesNo_(getRowValueByHeader_(row, headers, 'Enabled')),
      sourceId: getRowValueByHeader_(row, headers, 'Source Spreadsheet'),
      sourceTabName: getRowValueByHeader_(row, headers, 'Source Tab'),
      masterId: getRowValueByHeader_(row, headers, 'Master Spreadsheet'),
      userSheetId: getRowValueByHeader_(row, headers, 'User Sheet'),
      folderId: getRowValueByHeader_(row, headers, 'User Sheets Folder') || getRowValueByHeader_(row, headers, 'Target Folder'),
      matchColumn: getRowValueByHeader_(row, headers, 'Match Column'),
      columnMap: parseWorkflowColumnMap_(getRowValueByHeader_(row, headers, 'Column Mappings')),
      importColumnPolicies: parseWorkflowColumnPolicies_(getRowValueByHeader_(row, headers, 'Column Policies')),
      notes: getRowValueByHeader_(row, headers, 'Notes')
    };

    if (preset.id === '' && preset.name === '') continue;
    if (preset.id === '') preset.id = makeWorkflowId_(preset.name);
    presets.push(preset);
  }

  return presets;
}

/**
 * Finds a workflow preset by ID.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSpreadsheet
 * @param {string} workflowId
 * @return {Object|null}
 */
function getWorkflowPreset_(configSpreadsheet, workflowId) {
  var id = String(workflowId || '').trim();
  var presets = readWorkflowPresets_(configSpreadsheet);
  for (var i = 0; i < presets.length; i++) {
    if (presets[i].id === id) return presets[i];
  }
  return null;
}

/**
 * Reads one cell from a row by header name.
 *
 * @param {Array} row
 * @param {Array<string>} headers
 * @param {string} header
 * @return {string}
 */
function getRowValueByHeader_(row, headers, header) {
  var idx = headers.indexOf(header);
  if (idx === -1) return '';
  return String(row[idx] || '').trim();
}

/**
 * Parses a multiline "Source -> Target" mapping list from a workflow preset.
 *
 * @param {string} raw
 * @return {Array<{source: string, target: string}>}
 */
function parseWorkflowColumnMap_(raw) {
  var text = String(raw || '').trim();
  if (text === '') return [];

  var lines = text.split(/\r?\n/);
  var mappings = [];
  for (var i = 0; i < lines.length; i++) {
    var line = String(lines[i] || '').trim();
    if (line === '') continue;

    var parts = line.indexOf('->') !== -1 ? line.split('->') : line.split('|');
    var source = String(parts[0] || '').trim();
    var target = String(parts.length > 1 ? parts.slice(1).join('->') : parts[0]).trim();

    if (source === '' || target === '') continue;
    mappings.push({ source: source, target: target });
  }

  return mappings;
}

/**
 * Parses a multiline "Column -> Policy" list from a workflow preset.
 * Policies use the same labels as Pull Column Policy.
 *
 * @param {string} raw
 * @return {Object}
 */
function parseWorkflowColumnPolicies_(raw) {
  var text = String(raw || '').trim();
  var policies = {};
  if (text === '') return policies;

  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = String(lines[i] || '').trim();
    if (line === '') continue;

    var parts = line.indexOf('->') !== -1 ? line.split('->') : line.split('|');
    var column = String(parts[0] || '').trim();
    var policy = normalizePullPolicy_(parts.length > 1 ? parts.slice(1).join('->') : '');

    if (column === '' || !policy) continue;
    policies[column] = policy;
  }

  return policies;
}

/**
 * Normalizes a yes/no-ish value to a boolean. Blank means enabled.
 *
 * @param {string} value
 * @return {boolean}
 */
function normalizeYesNo_(value) {
  var text = String(value || '').trim().toLowerCase();
  if (text === '' || text === 'yes' || text === 'y' || text === 'true' || text === 'enabled') return true;
  return false;
}

/**
 * Converts a display workflow name to a stable-ish ID.
 *
 * @param {string} name
 * @return {string}
 */
function makeWorkflowId_(name) {
  return String(name || 'workflow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workflow';
}

/**
 * Selects a sheet by name, falling back to the first tab when no name is set.
 *
 * @param {SpreadsheetApp.Spreadsheet} spreadsheet
 * @param {string} sheetName
 * @return {SpreadsheetApp.Sheet}
 */
function getConfiguredSheet_(spreadsheet, sheetName) {
  var requested = String(sheetName || '').trim();
  if (requested === '') return spreadsheet.getSheets()[0];

  var sheet = spreadsheet.getSheetByName(requested);
  if (!sheet) {
    throw new Error('Tab "' + requested + '" was not found in "' + spreadsheet.getName() + '".');
  }
  return sheet;
}

/**
 * Checks whether the given headers contain all named columns.
 *
 * @param {Array<string>} headers
 * @param {Array<string>} required
 * @return {Array<string>}
 */
function findMissingHeaders_(headers, required) {
  var missing = [];
  for (var i = 0; i < required.length; i++) {
    var header = String(required[i] || '').trim();
    if (header !== '' && headers.indexOf(header) === -1 && missing.indexOf(header) === -1) {
      missing.push(header);
    }
  }
  return missing;
}

/**
 * Reads the Pull Column Policy tab into a map of header name → policy.
 * Supported policies:
 * - fill_blank: fill master only when the master cell is blank
 * - overwrite: replace non-blank master values with source values
 * - conflict: log differences without writing
 * - never: skip this column entirely
 *
 * Missing policy rows default to conflict in the pull-data operation.
 * resident_id is always forced to never because it is the row identity.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSpreadsheet
 * @return {Object}
 */
function readPullColumnPolicies_(configSpreadsheet) {
  var policies = { resident_id: 'never' };
  var tab = findPullColumnPolicySheet_(configSpreadsheet);
  if (!tab) return policies;

  var data = tab.getDataRange().getValues();
  if (data.length === 0) return policies;

  var table = findPullPolicyTable_(data);
  if (!table) return policies;

  for (var i = table.firstDataRow; i < data.length; i++) {
    var row = data[i];
    var column = String(row[table.nameCol] || '').trim();
    var policyRaw = row[table.policyCol];
    if (column === '') continue;
    if (column.charAt(0) === '(' && column.charAt(column.length - 1) === ')') continue;

    var policy = normalizePullPolicy_(policyRaw);
    if (!policy && table.nameCol !== table.policyCol) {
      // Some sheets accidentally swap Column Name and Policy.
      policy = normalizePullPolicy_(column);
      column = String(policyRaw || '').trim();
    }
    if (column === '' || !policy) continue;
    policies[column] = policy;
  }

  policies.resident_id = 'never';
  return policies;
}

/**
 * Finds the Pull Column Policy tab by exact name, case-insensitive name,
 * or a sheet name containing "pull column policy".
 *
 * @param {SpreadsheetApp.Spreadsheet} configSpreadsheet
 * @return {SpreadsheetApp.Sheet|null}
 */
function findPullColumnPolicySheet_(configSpreadsheet) {
  var exact = getConfigSheetByName_(configSpreadsheet, 'Pull Column Policy');
  if (exact) return exact;

  var needle = 'pull column policy';
  var sheets = configSpreadsheet.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var name = String(sheets[i].getName()).trim().toLowerCase();
    if (name.indexOf(needle) !== -1) return sheets[i];
  }
  return null;
}

/**
 * Locates the header row and Column Name / Policy column indexes.
 *
 * @param {Array<Array>} data
 * @return {{firstDataRow: number, nameCol: number, policyCol: number}|null}
 */
function findPullPolicyTable_(data) {
  var maxScan = Math.min(data.length, 15);
  for (var r = 0; r < maxScan; r++) {
    var row = data[r];
    var nameCol = -1;
    var policyCol = -1;
    for (var c = 0; c < row.length; c++) {
      var cell = normalizePolicyHeaderCell_(row[c]);
      if (cell === 'column name' || cell === 'column' || cell === 'header') nameCol = c;
      if (cell === 'policy') policyCol = c;
    }
    if (nameCol !== -1 && policyCol !== -1) {
      return { firstDataRow: r + 1, nameCol: nameCol, policyCol: policyCol };
    }
  }

  if (data.length > 0) {
    return { firstDataRow: 1, nameCol: 0, policyCol: 1 };
  }
  return null;
}

/**
 * @param {*} value
 * @return {string}
 */
function normalizePolicyHeaderCell_(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Finds a config tab by exact name, then by case-insensitive match.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSpreadsheet
 * @param {string} sheetName
 * @return {SpreadsheetApp.Sheet|null}
 */
function getConfigSheetByName_(configSpreadsheet, sheetName) {
  var wanted = String(sheetName || '').trim();
  if (wanted === '') return null;

  var tab = configSpreadsheet.getSheetByName(wanted);
  if (tab) return tab;

  var wantedLower = wanted.toLowerCase();
  var sheets = configSpreadsheet.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (String(sheets[i].getName()).trim().toLowerCase() === wantedLower) {
      return sheets[i];
    }
  }
  return null;
}

/**
 * Merges workflow preset policies with the Pull Column Policy tab, preferring
 * the tab when both define the same column.
 *
 * @param {SpreadsheetApp.Spreadsheet} configSpreadsheet
 * @param {Object=} workflowPolicies
 * @return {Object}
 */
function resolvePullColumnPoliciesForRun_(configSpreadsheet, workflowPolicies) {
  var merged = {};
  var presetPolicies = workflowPolicies || {};
  var tabPolicies = readPullColumnPolicies_(configSpreadsheet);

  for (var presetKey in presetPolicies) {
    if (Object.prototype.hasOwnProperty.call(presetPolicies, presetKey)) {
      merged[presetKey] = presetPolicies[presetKey];
    }
  }
  for (var tabKey in tabPolicies) {
    if (Object.prototype.hasOwnProperty.call(tabPolicies, tabKey)) {
      merged[tabKey] = tabPolicies[tabKey];
    }
  }

  merged.resident_id = 'never';
  return merged;
}

/**
 * @param {Object} policies
 * @return {number}
 */
function countEditablePullPolicies_(policies) {
  var count = 0;
  policies = policies || {};
  for (var key in policies) {
    if (!Object.prototype.hasOwnProperty.call(policies, key)) continue;
    if (key !== 'resident_id') count++;
  }
  return count;
}

/**
 * Fails fast when Pull Data would otherwise treat every column as conflict.
 *
 * @param {Object} policies
 */
function assertPullColumnPoliciesLoaded_(policies) {
  if (countEditablePullPolicies_(policies) > 0) return;
  throw new Error(
    'No Pull Column Policy rows were loaded from the config spreadsheet.\n\n' +
    'Make sure this project is bound to Sheet Smart Config and that the tab ' +
    '"Pull Column Policy" has Column Name / Policy rows (for example, Address Plan -> fill_blank).'
  );
}

/**
 * Normalizes policy labels from the Pull Column Policy tab.
 *
 * @param {*} raw
 * @return {string}
 */
function normalizePullPolicy_(raw) {
  var policy = String(raw || '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (policy === 'fill' || policy === 'fill_blank' || policy === 'fill_blanks' || policy === 'fill_blank_only') return 'fill_blank';
  if (policy === 'overwrite' || policy === 'replace') return 'overwrite';
  if (policy === 'conflict' || policy === 'log_conflict' || policy === 'log_only') return 'conflict';
  if (policy === 'never' || policy === 'skip' || policy === 'ignore') return 'never';
  return '';
}

/**
 * Debug helper: run from Apps Script to verify policy loading.
 */
function debugPullColumnPolicies() {
  var configSs = SpreadsheetApp.getActiveSpreadsheet();
  var tab = findPullColumnPolicySheet_(configSs);
  var policies = resolvePullColumnPoliciesForRun_(configSs, {});
  var tabName = tab ? tab.getName() : '(not found)';
  var count = countEditablePullPolicies_(policies);
  var sample = Object.keys(policies).filter(function (key) { return key !== 'resident_id'; }).slice(0, 8).join(', ');
  SpreadsheetApp.getUi().alert(
    'Pull Column Policy debug\n\n' +
    'Config spreadsheet: ' + configSs.getName() + '\n' +
    'Policy tab found: ' + tabName + '\n' +
    'Editable policies loaded: ' + count + '\n' +
    (sample ? 'Sample columns: ' + sample : 'No editable policies were loaded.')
  );
}

/**
 * Parses the "Sensitive Columns" setting value (a comma-separated list
 * of column headers) into a trimmed array of header names. Blank
 * entries are removed.
 *
 * @param {string} raw
 * @return {Array<string>}
 */
function parseSensitiveColumns_(raw) {
  if (!raw) return [];
  return String(raw).split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s !== ''; });
}

/**
 * Compares cell values by meaning instead of raw JavaScript identity. This
 * avoids false conflicts when Sheets returns equivalent dates as different
 * Date instances or as a formatted date string.
 *
 * @param {*} left
 * @param {*} right
 * @return {boolean}
 */
function cellValuesEqual_(left, right) {
  var leftKey = normalizeCellValueForCompare_(left);
  var rightKey = normalizeCellValueForCompare_(right);
  return leftKey === rightKey;
}

/**
 * Produces a stable comparison key for common spreadsheet values.
 *
 * @param {*} value
 * @return {string}
 */
function normalizeCellValueForCompare_(value) {
  if (isSpreadsheetCellBlank_(value)) return 'blank:';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return 'date:' + value.getFullYear() + '-' + pad2_(value.getMonth() + 1) + '-' + pad2_(value.getDate());
  }
  if (typeof value === 'boolean') return 'boolean:' + String(value);
  if (typeof value === 'number' && isFinite(value)) return 'number:' + String(value);

  var text = String(value).trim();
  if (text === '') return 'blank:';

  var booleanKey = normalizeBooleanTextForCompare_(text);
  if (booleanKey !== '') return booleanKey;

  var numericKey = normalizeNumericTextForCompare_(text);
  if (numericKey !== '') return numericKey;

  var parsedDate = parseDisplayDate_(text);
  if (parsedDate) return parsedDate;
  return 'string:' + text;
}

/**
 * Treats blank cells and unchecked checkbox defaults as empty.
 *
 * @param {*} value
 * @return {boolean}
 */
function isSpreadsheetCellBlank_(value) {
  return value === '' || value === null || value === undefined || value === false;
}

/**
 * Source-side blank check. Unchecked checkbox values are real data.
 *
 * @param {*} value
 * @return {boolean}
 */
function isSpreadsheetSourceCellBlank_(value) {
  return value === '' || value === null || value === undefined;
}

/**
 * @param {string} text
 * @return {string}
 */
function normalizeBooleanTextForCompare_(text) {
  var lower = String(text || '').trim().toLowerCase();
  if (lower === 'true') return 'boolean:true';
  if (lower === 'false') return 'boolean:false';
  return '';
}

/**
 * @param {string} text
 * @return {string}
 */
function normalizeNumericTextForCompare_(text) {
  if (!/^-?\d+(\.\d+)?$/.test(String(text || '').trim())) return '';
  return 'number:' + String(Number(text));
}

/**
 * Parses common Sheets display dates like M/D/YYYY or YYYY-MM-DD.
 *
 * @param {string} text
 * @return {string}
 */
function parseDisplayDate_(text) {
  var match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    return 'date:' + match[3] + '-' + pad2_(match[1]) + '-' + pad2_(match[2]);
  }

  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    return 'date:' + match[1] + '-' + pad2_(match[2]) + '-' + pad2_(match[3]);
  }

  return '';
}

/**
 * Normalizes a source cell before writing it into a mapped target column.
 * Apps Script may read imported dates as raw Sheets serial numbers, so date
 * columns need conversion back to Date objects before setValue().
 *
 * @param {*} value
 * @param {{source: string, target: string}} mapping
 * @return {*}
 */
function normalizeMappedSourceValueForWrite_(value, mapping) {
  if (typeof value === 'string') {
    var lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }

  if (isDateColumnName_(mapping.source) || isDateColumnName_(mapping.target)) {
    var dateValue = coerceToDateValue_(value);
    if (dateValue) return dateValue;
  }

  return value;
}

/**
 * Returns the number format needed for a normalized write value.
 *
 * @param {*} value
 * @param {{source: string, target: string}} mapping
 * @return {string}
 */
function getWriteNumberFormat_(value, mapping) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return 'm/d/yyyy';
  }
  if (typeof value === 'boolean') return 'General';
  if (isDateColumnName_(mapping.source) || isDateColumnName_(mapping.target)) return 'm/d/yyyy';
  return '';
}

/**
 * Identifies mapped columns that should behave as dates.
 *
 * @param {string} columnName
 * @return {boolean}
 */
function isDateColumnName_(columnName) {
  return /\bdate\b/i.test(String(columnName || ''));
}

/**
 * Converts common date-like source values to Date objects.
 *
 * @param {*} value
 * @return {Date|null}
 */
function coerceToDateValue_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'number' && isFinite(value)) {
    if (value < 1 || value > 60000) return null;
    var wholeDays = Math.floor(value);
    var date = new Date(1899, 11, 30);
    date.setDate(date.getDate() + wholeDays);
    return date;
  }

  if (typeof value === 'string') {
    var text = value.trim();
    var match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) return new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]));

    match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  return null;
}

/**
 * Left-pads month/day numbers used in comparison keys.
 *
 * @param {*} value
 * @return {string}
 */
function pad2_(value) {
  var text = String(value);
  return text.length === 1 ? '0' + text : text;
}

/**
 * Builds a lookup object keyed by the match-column value.
 * Each value is an object mapping column headers to cell values
 * for that row.
 *
 * @param {Array<Array>} sourceData  2D array including header row
 * @param {Array<string>} headers    Header row (already trimmed)
 * @param {string} matchColumn       Column name to key on
 * @return {Object}  e.g. { '123-456': { 'APN': '123-456', 'Sale Price': 500000 } }
 */
function buildSourceLookup_(sourceData, headers, matchColumn) {
  var matchIdx = headers.indexOf(matchColumn);
  if (matchIdx === -1) return {};

  var lookup = {};
  for (var i = 1; i < sourceData.length; i++) {
    var row = sourceData[i];
    var key = String(row[matchIdx]).trim();
    if (key === '' || key === 'undefined' || key === 'null') continue;

    var record = {};
    for (var c = 0; c < headers.length; c++) {
      record[headers[c]] = row[c];
    }
    record[SOURCE_LOOKUP_ROW_NUMBER_KEY_] = i + 1;
    lookup[key] = record;
  }

  return lookup;
}

/**
 * Finds source records whose match key was never seen in the target sheet.
 *
 * @param {Object} sourceLookup
 * @param {Object} targetKeys
 * @param {string} matchColumn
 * @return {Array<{row: number, column: string, existingValue: string, newValue: string, reason: string}>}
 */
function collectUnmatchedSourceRows_(sourceLookup, targetKeys, matchColumn) {
  var unmatched = [];
  for (var key in sourceLookup) {
    if (!Object.prototype.hasOwnProperty.call(sourceLookup, key)) continue;
    if (targetKeys[key]) continue;

    var sourceRow = sourceLookup[key] || {};
    unmatched.push({
      row: sourceRow[SOURCE_LOOKUP_ROW_NUMBER_KEY_] || 0,
      column: matchColumn,
      existingValue: '(not found in target)',
      newValue: key,
      reason: 'Source row has no matching target row'
    });
  }
  return unmatched;
}

/**
 * Merges source data into a single target sheet. Fills blank
 * cells and records conflicts without overwriting.
 *
 * @param {SpreadsheetApp.Sheet} targetSheet   First tab of a target spreadsheet
 * @param {Object} sourceLookup                From buildSourceLookup_
 * @param {string} matchColumn                 Column name to match on
 * @param {Array<{source: string, target: string}>} columnMap
 * @param {boolean} dryRun                     If true, log only — never write
 * @param {Array<string>=} virtualAddedColumns Column headers that the caller
 *        just "added" in dry-run mode (i.e. not actually written to the sheet
 *        yet). Treated as if present in the target header row so fills can be
 *        logged instead of reported as missing-column errors.
 * @param {boolean=} logUnmatchedSourceRows    If true, source keys absent from
 *        the target are returned for logging.
 * @return {{ filled: Array, conflicts: Array, unmatchedSourceRows: Array, errors: Array }}
 */
function mergeIntoTarget_(targetSheet, sourceLookup, matchColumn, columnMap, dryRun, virtualAddedColumns, logUnmatchedSourceRows) {
  var filled = [];
  var conflicts = [];
  var unmatchedSourceRows = [];
  var errors = [];

  var data = targetSheet.getDataRange().getValues();
  if (data.length === 0) {
    errors.push({ row: 0, column: '', existingValue: '', newValue: 'Target sheet is empty' });
    return { filled: filled, conflicts: conflicts, errors: errors };
  }

  var targetHeaders = data[0].map(function (h) { return String(h).trim(); });

  // Dry-run bridge: addColumnsToTarget_ doesn't actually write headers in dry
  // mode, so those columns are absent from the sheet we just read. Treat them
  // as present here; their per-row cells will index out of the real row array
  // and resolve to undefined, which the blank check below handles correctly.
  if (virtualAddedColumns && virtualAddedColumns.length) {
    for (var v = 0; v < virtualAddedColumns.length; v++) {
      var vcol = String(virtualAddedColumns[v]).trim();
      if (vcol !== '' && targetHeaders.indexOf(vcol) === -1) {
        targetHeaders.push(vcol);
      }
    }
  }

  var matchIdx = targetHeaders.indexOf(matchColumn);
  if (matchIdx === -1) {
    errors.push({
      row: 0,
      column: matchColumn,
      existingValue: '',
      newValue: 'Match column "' + matchColumn + '" not found in target headers'
    });
    return { filled: filled, conflicts: conflicts, errors: errors };
  }

  var targetColIndices = [];
  for (var m = 0; m < columnMap.length; m++) {
    var tgtIdx = targetHeaders.indexOf(columnMap[m].target);
    if (tgtIdx === -1) {
      errors.push({
        row: 0,
        column: columnMap[m].target,
        existingValue: '',
        newValue: 'Mapped target column "' + columnMap[m].target + '" not found in target sheet'
      });
      targetColIndices.push(-1);
    } else {
      targetColIndices.push(tgtIdx);
    }
  }

  var writeQueue = [];
  var targetKeys = {};

  for (var r = 1; r < data.length; r++) {
    var matchKey = String(data[r][matchIdx]).trim();
    if (matchKey === '' || matchKey === 'undefined' || matchKey === 'null') continue;
    targetKeys[matchKey] = true;

    var sourceRow = sourceLookup[matchKey];
    if (!sourceRow) continue;

    for (var c = 0; c < columnMap.length; c++) {
      if (targetColIndices[c] === -1) continue;

      var sourceVal = normalizeMappedSourceValueForWrite_(sourceRow[columnMap[c].source], columnMap[c]);
      var targetVal = data[r][targetColIndices[c]];

      // Treat boolean false as blank: it is the default state of an unchecked
      // checkbox, not a user-entered value. This prevents checkbox-formatted
      // columns from generating spurious conflicts.
      var targetBlank = (targetVal === '' || targetVal === null || targetVal === undefined || targetVal === false);
      var sourceBlank = (sourceVal === '' || sourceVal === null || sourceVal === undefined);

      if (targetBlank && !sourceBlank) {
        filled.push({
          row: r + 1,
          column: columnMap[c].target,
          existingValue: '',
          newValue: sourceVal
        });
        if (!dryRun) {
          // wasCheckbox: cell held the boolean false default, so its column
          // likely has checkbox data validation — clear that before writing
          // so the new value displays as plain text/number, not a checkbox.
          writeQueue.push({
            row: r + 1,
            col: targetColIndices[c] + 1,
            val: sourceVal,
            numberFormat: getWriteNumberFormat_(sourceVal, columnMap[c]),
            wasCheckbox: (targetVal === false)
          });
        }
      } else if (!targetBlank && !sourceBlank && !cellValuesEqual_(targetVal, sourceVal)) {
        conflicts.push({
          row: r + 1,
          column: columnMap[c].target,
          existingValue: targetVal,
          newValue: sourceVal
        });
      }
    }
  }
  if (logUnmatchedSourceRows) {
    unmatchedSourceRows = collectUnmatchedSourceRows_(sourceLookup, targetKeys, matchColumn);
  }

  if (!dryRun) {
    for (var w = 0; w < writeQueue.length; w++) {
      var cell = targetSheet.getRange(writeQueue[w].row, writeQueue[w].col);
      if (writeQueue[w].wasCheckbox) {
        cell.clearDataValidations();
      }
      if (writeQueue[w].numberFormat) {
        cell.setNumberFormat(writeQueue[w].numberFormat);
      }
      cell.setValue(writeQueue[w].val);
    }
  }

  return { filled: filled, conflicts: conflicts, unmatchedSourceRows: unmatchedSourceRows, errors: errors };
}

/**
 * Merges source data into a target sheet using per-column import policies.
 * This is used by sidebar workflows that need a dry-run review of proposed
 * overwrites before a live write.
 *
 * @param {SpreadsheetApp.Sheet} targetSheet
 * @param {Object} sourceLookup
 * @param {string} matchColumn
 * @param {Array<{source: string, target: string}>} columnMap
 * @param {Object} columnPolicies
 * @param {boolean} dryRun
 * @param {Array<string>=} virtualAddedColumns
 * @param {boolean=} logUnmatchedSourceRows
 * @return {{ filled: Array, overwritten: Array, conflicts: Array, skipped: Array, unmatchedSourceRows: Array, errors: Array }}
 */
function mergeIntoTargetWithPolicies_(targetSheet, sourceLookup, matchColumn, columnMap, columnPolicies, dryRun, virtualAddedColumns, logUnmatchedSourceRows) {
  var filled = [];
  var overwritten = [];
  var conflicts = [];
  var skipped = [];
  var unmatchedSourceRows = [];
  var errors = [];
  var policies = columnPolicies || {};

  var data = targetSheet.getDataRange().getValues();
  if (data.length === 0) {
    errors.push({ row: 0, column: '', existingValue: '', newValue: 'Target sheet is empty' });
    return { filled: filled, overwritten: overwritten, conflicts: conflicts, skipped: skipped, errors: errors };
  }

  var targetHeaders = data[0].map(function (h) { return String(h).trim(); });
  if (virtualAddedColumns && virtualAddedColumns.length) {
    for (var v = 0; v < virtualAddedColumns.length; v++) {
      var vcol = String(virtualAddedColumns[v]).trim();
      if (vcol !== '' && targetHeaders.indexOf(vcol) === -1) {
        targetHeaders.push(vcol);
      }
    }
  }

  var matchIdx = targetHeaders.indexOf(matchColumn);
  if (matchIdx === -1) {
    errors.push({
      row: 0,
      column: matchColumn,
      existingValue: '',
      newValue: 'Match column "' + matchColumn + '" not found in target headers'
    });
    return { filled: filled, overwritten: overwritten, conflicts: conflicts, skipped: skipped, errors: errors };
  }

  var targetColIndices = [];
  for (var m = 0; m < columnMap.length; m++) {
    var tgtIdx = targetHeaders.indexOf(columnMap[m].target);
    if (tgtIdx === -1) {
      errors.push({
        row: 0,
        column: columnMap[m].target,
        existingValue: '',
        newValue: 'Mapped target column "' + columnMap[m].target + '" not found in target sheet'
      });
      targetColIndices.push(-1);
    } else {
      targetColIndices.push(tgtIdx);
    }
  }

  var writeQueue = [];
  var targetKeys = {};
  for (var r = 1; r < data.length; r++) {
    var matchKey = String(data[r][matchIdx]).trim();
    if (matchKey === '' || matchKey === 'undefined' || matchKey === 'null') continue;
    targetKeys[matchKey] = true;

    var sourceRow = sourceLookup[matchKey];
    if (!sourceRow) continue;

    for (var c = 0; c < columnMap.length; c++) {
      if (targetColIndices[c] === -1) continue;

      var mapping = columnMap[c];
      var policy = policies[mapping.target] || policies[mapping.source] || 'fill_blank';
      var sourceVal = normalizeMappedSourceValueForWrite_(sourceRow[mapping.source], mapping);

      var targetVal = data[r][targetColIndices[c]];
      var targetBlank = (targetVal === '' || targetVal === null || targetVal === undefined || targetVal === false);
      var sourceBlank = (sourceVal === '' || sourceVal === null || sourceVal === undefined);
      if (sourceBlank) continue;

      if (policy === 'never') {
        skipped.push({
          row: r + 1,
          column: mapping.target,
          existingValue: targetVal,
          newValue: sourceVal,
          reason: 'Policy is never'
        });
        continue;
      }

      if (cellValuesEqual_(targetVal, sourceVal)) continue;

      if (targetBlank) {
        filled.push({
          row: r + 1,
          column: mapping.target,
          existingValue: '',
          newValue: sourceVal,
          policy: policy
        });
        if (!dryRun) {
          writeQueue.push({
            row: r + 1,
            col: targetColIndices[c] + 1,
            val: sourceVal,
            numberFormat: getWriteNumberFormat_(sourceVal, mapping),
            wasCheckbox: (targetVal === false)
          });
        }
      } else if (policy === 'overwrite') {
        overwritten.push({
          row: r + 1,
          column: mapping.target,
          existingValue: targetVal,
          newValue: sourceVal,
          policy: policy
        });
        if (!dryRun) {
          writeQueue.push({
            row: r + 1,
            col: targetColIndices[c] + 1,
            val: sourceVal,
            numberFormat: getWriteNumberFormat_(sourceVal, mapping),
            wasCheckbox: (targetVal === false)
          });
        }
      } else {
        conflicts.push({
          row: r + 1,
          column: mapping.target,
          existingValue: targetVal,
          newValue: sourceVal,
          policy: policy
        });
      }
    }
  }
  if (logUnmatchedSourceRows) {
    unmatchedSourceRows = collectUnmatchedSourceRows_(sourceLookup, targetKeys, matchColumn);
  }

  if (!dryRun) {
    for (var w = 0; w < writeQueue.length; w++) {
      var cell = targetSheet.getRange(writeQueue[w].row, writeQueue[w].col);
      if (writeQueue[w].wasCheckbox) {
        cell.clearDataValidations();
      }
      if (writeQueue[w].numberFormat) {
        cell.setNumberFormat(writeQueue[w].numberFormat);
      }
      cell.setValue(writeQueue[w].val);
    }
  }

  return { filled: filled, overwritten: overwritten, conflicts: conflicts, skipped: skipped, unmatchedSourceRows: unmatchedSourceRows, errors: errors };
}

/**
 * Creates (or clears) a results log tab and writes all merge
 * results as a batch.
 *
 * @param {SpreadsheetApp.Spreadsheet} spreadsheet  Where to write the log
 * @param {string} tabName                          Tab name for the log
 * @param {string} sheetName                        Name of the sheet being merged (for context)
 * @param {Array} filled                            Fill entries from mergeIntoTarget_
 * @param {Array} conflicts                         Conflict entries
 * @param {Array} errors                            Error entries
 */
function writeResultsLog_(spreadsheet, tabName, sheetName, filled, conflicts, errors) {
  var tab = spreadsheet.getSheetByName(tabName);
  if (tab) {
    tab.clear();
  } else {
    tab = spreadsheet.insertSheet(tabName);
  }

  var header = ['Type', 'Spreadsheet', 'Row', 'Column', 'Existing Value', 'New Value'];
  var rows = [header];

  for (var i = 0; i < filled.length; i++) {
    rows.push(['Filled', sheetName, filled[i].row, filled[i].column, filled[i].existingValue, filled[i].newValue]);
  }
  for (var j = 0; j < conflicts.length; j++) {
    rows.push(['Conflict', sheetName, conflicts[j].row, conflicts[j].column, conflicts[j].existingValue, conflicts[j].newValue]);
  }
  for (var k = 0; k < errors.length; k++) {
    rows.push(['Error', sheetName, errors[k].row, errors[k].column, errors[k].existingValue, errors[k].newValue]);
  }

  if (rows.length > 0) {
    tab.getRange(1, 1, rows.length, header.length).setValues(rows);
  }

  formatHeaderRow_(tab, header.length);
  tab.setFrozenRows(1);
}

/**
 * Bolds and freezes the header row of a log tab.
 *
 * @param {SpreadsheetApp.Sheet} tab
 * @param {number} numCols
 */
function formatHeaderRow_(tab, numCols) {
  var headerRange = tab.getRange(1, 1, 1, numCols);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#f3f3f3');
}

/**
 * Adds missing column headers to the first row of a target sheet.
 * New headers are appended after the last existing column in a
 * single batch write. Already-present columns are skipped silently.
 *
 * @param {SpreadsheetApp.Sheet} targetSheet
 * @param {Array<string>} columnNames  Ordered list of column names to ensure exist
 * @param {boolean} dryRun             If true, log only — never write
 * @return {{ added: Array<{column: string}>, skipped: Array<{column: string}>, errors: Array<{column: string, message: string}> }}
 */
function addColumnsToTarget_(targetSheet, columnNames, dryRun) {
  var added = [];
  var skipped = [];
  var errors = [];

  var data = targetSheet.getDataRange().getValues();
  if (data.length === 0) {
    errors.push({ column: '', message: 'Target sheet is empty' });
    return { added: added, skipped: skipped, errors: errors };
  }

  var existingHeaders = data[0].map(function (h) { return String(h).trim(); });
  var toAdd = [];

  for (var i = 0; i < columnNames.length; i++) {
    var colName = String(columnNames[i]).trim();
    if (colName === '') continue;
    if (existingHeaders.indexOf(colName) !== -1) {
      skipped.push({ column: colName });
    } else {
      added.push({ column: colName });
      toAdd.push(colName);
    }
  }

  if (!dryRun && toAdd.length > 0) {
    var startCol = existingHeaders.length + 1;
    targetSheet.getRange(1, startCol, 1, toAdd.length).setValues([toAdd]);
    // Flush so the header write is committed before subsequent reads.
    SpreadsheetApp.flush();
    // Data rows: clear inherited checkbox validation, any false values that
    // Google Sheets propagates from an adjacent checkbox column, and reset
    // format to plain General so cells start genuinely empty.
    var lastRow = targetSheet.getMaxRows();
    if (lastRow > 1) {
      var dataRange = targetSheet.getRange(2, startCol, lastRow - 1, toAdd.length);
      dataRange.clearDataValidations();
      dataRange.clearContent();
      dataRange.setNumberFormat('General');
    }
  }

  return { added: added, skipped: skipped, errors: errors };
}

/**
 * Deletes configured columns from a target sheet. A live run removes the full
 * sheet column, including row-1 header, values, notes, validation, and format.
 *
 * @param {SpreadsheetApp.Sheet} targetSheet
 * @param {Array<string>} columnNames  Ordered list of column names to delete
 * @param {boolean} dryRun             If true, log only — never write
 * @return {{ deleted: Array<{column: string, index: number, nonBlankCells: number}>, skipped: Array<{column: string, note: string}>, errors: Array<{column: string, message: string}> }}
 */
function deleteColumnsFromTarget_(targetSheet, columnNames, dryRun) {
  var deleted = [];
  var skipped = [];
  var errors = [];

  var data = targetSheet.getDataRange().getValues();
  if (data.length === 0) {
    errors.push({ column: '', message: 'Target sheet is empty' });
    return { deleted: deleted, skipped: skipped, errors: errors };
  }

  var headers = data[0].map(function (h) { return String(h).trim(); });
  for (var i = 0; i < columnNames.length; i++) {
    var colName = String(columnNames[i]).trim();
    if (colName === '') continue;

    var idx = headers.indexOf(colName);
    if (idx === -1) {
      skipped.push({ column: colName, note: 'Header not found' });
      continue;
    }

    deleted.push({
      column: colName,
      index: idx + 1,
      nonBlankCells: countNonBlankCellsBelowHeader_(data, idx)
    });
  }

  if (!dryRun && deleted.length > 0) {
    if (targetSheet.getMaxColumns() - deleted.length < 1) {
      for (var e = 0; e < deleted.length; e++) {
        errors.push({ column: deleted[e].column, message: 'Cannot delete every column in the sheet' });
      }
      return { deleted: [], skipped: skipped, errors: errors };
    }

    var toDelete = deleted.slice().sort(function (a, b) { return b.index - a.index; });
    for (var d = 0; d < toDelete.length; d++) {
      targetSheet.deleteColumn(toDelete[d].index);
    }
    SpreadsheetApp.flush();
  }

  return { deleted: deleted, skipped: skipped, errors: errors };
}

/**
 * Counts data cells below the header that are not empty/null/undefined.
 *
 * @param {Array<Array>} data
 * @param {number} columnIndex
 * @return {number}
 */
function countNonBlankCellsBelowHeader_(data, columnIndex) {
  var count = 0;
  for (var r = 1; r < data.length; r++) {
    var value = data[r][columnIndex];
    if (value !== '' && value !== null && value !== undefined) count++;
  }
  return count;
}

/**
 * Appends combined sync results (column additions + fills + conflicts + errors)
 * to a single log tab, creating it with a header row if needed.
 * Used by the unified Sync operations so all results land in one place.
 *
 * @param {SpreadsheetApp.Spreadsheet} spreadsheet
 * @param {string} tabName
 * @param {string} sheetName
 * @param {{ added: Array, skipped: Array, errors: Array }} addResult   From addColumnsToTarget_
 * @param {{ filled: Array, conflicts: Array, errors: Array }} mergeResult  From mergeIntoTarget_
 */
function appendToSyncLog_(spreadsheet, tabName, sheetName, addResult, mergeResult) {
  var tab = spreadsheet.getSheetByName(tabName);
  var header = ['Type', 'Spreadsheet', 'Row', 'Column', 'Existing Value', 'New / Source Value'];

  if (!tab) {
    tab = spreadsheet.insertSheet(tabName);
    tab.getRange(1, 1, 1, header.length).setValues([header]);
    formatHeaderRow_(tab, header.length);
    tab.setFrozenRows(1);
  }

  var newRows = [];

  for (var i = 0; i < addResult.added.length; i++) {
    newRows.push(['Column Added', sheetName, 1, addResult.added[i].column, '(new column)', '']);
  }
  for (var j = 0; j < addResult.errors.length; j++) {
    newRows.push(['Error', sheetName, 0, addResult.errors[j].column, '', addResult.errors[j].message]);
  }
  for (var k = 0; k < mergeResult.filled.length; k++) {
    var f = mergeResult.filled[k];
    newRows.push(['Filled', sheetName, f.row, f.column, '(blank)', f.newValue]);
  }
  if (mergeResult.overwritten) {
    for (var o = 0; o < mergeResult.overwritten.length; o++) {
      var ow = mergeResult.overwritten[o];
      newRows.push(['Overwritten', sheetName, ow.row, ow.column, ow.existingValue, ow.newValue]);
    }
  }
  for (var l = 0; l < mergeResult.conflicts.length; l++) {
    var c = mergeResult.conflicts[l];
    newRows.push(['Conflict', sheetName, c.row, c.column, c.existingValue, c.newValue]);
  }
  if (mergeResult.skipped) {
    for (var s = 0; s < mergeResult.skipped.length; s++) {
      var skipped = mergeResult.skipped[s];
      newRows.push(['Skipped', sheetName, skipped.row, skipped.column, skipped.existingValue, skipped.reason || 'Skipped by policy']);
    }
  }
  if (mergeResult.unmatchedSourceRows) {
    for (var u = 0; u < mergeResult.unmatchedSourceRows.length; u++) {
      var unmatched = mergeResult.unmatchedSourceRows[u];
      newRows.push(['Unmatched Source', sheetName, unmatched.row, unmatched.column, unmatched.existingValue, unmatched.newValue]);
    }
  }
  for (var m = 0; m < mergeResult.errors.length; m++) {
    var e = mergeResult.errors[m];
    newRows.push(['Error', sheetName, e.row, e.column, e.existingValue, e.newValue]);
  }

  if (newRows.length > 0) {
    var startRow = tab.getLastRow() + 1;
    tab.getRange(startRow, 1, newRows.length, header.length).setValues(newRows);
  }
}

/**
 * Appends add-columns results to a log tab, creating the tab with
 * a header row if it does not yet exist. Used when accumulating
 * results across many target sheets.
 *
 * @param {SpreadsheetApp.Spreadsheet} spreadsheet
 * @param {string} tabName
 * @param {string} sheetName
 * @param {{ added: Array, skipped: Array, errors: Array }} results
 */
function appendToAddColumnsLog_(spreadsheet, tabName, sheetName, results) {
  var tab = spreadsheet.getSheetByName(tabName);
  var header = ['Type', 'Spreadsheet', 'Column', 'Notes'];

  if (!tab) {
    tab = spreadsheet.insertSheet(tabName);
    tab.getRange(1, 1, 1, header.length).setValues([header]);
    formatHeaderRow_(tab, header.length);
    tab.setFrozenRows(1);
  }

  var newRows = [];

  for (var i = 0; i < results.added.length; i++) {
    newRows.push(['Added', sheetName, results.added[i].column, '']);
  }
  for (var j = 0; j < results.skipped.length; j++) {
    newRows.push(['Skipped', sheetName, results.skipped[j].column, 'Already exists']);
  }
  for (var k = 0; k < results.errors.length; k++) {
    newRows.push(['Error', sheetName, results.errors[k].column, results.errors[k].message]);
  }

  if (newRows.length > 0) {
    var startRow = tab.getLastRow() + 1;
    tab.getRange(startRow, 1, newRows.length, header.length).setValues(newRows);
  }
}

/**
 * Appends delete-columns results to a log tab, creating the tab with
 * a header row if it does not yet exist. Used when accumulating
 * results across many target sheets.
 *
 * @param {SpreadsheetApp.Spreadsheet} spreadsheet
 * @param {string} tabName
 * @param {string} sheetName
 * @param {{ deleted: Array, skipped: Array, errors: Array }} results
 * @param {boolean=} dryRun
 */
function appendToDeleteColumnsLog_(spreadsheet, tabName, sheetName, results, dryRun) {
  var tab = spreadsheet.getSheetByName(tabName);
  var header = ['Type', 'Spreadsheet', 'Column', 'Original Index', 'Non-Blank Data Cells', 'Notes'];

  if (!tab) {
    tab = spreadsheet.insertSheet(tabName);
    tab.getRange(1, 1, 1, header.length).setValues([header]);
    formatHeaderRow_(tab, header.length);
    tab.setFrozenRows(1);
  }

  var newRows = [];

  for (var i = 0; i < results.deleted.length; i++) {
    var deleted = results.deleted[i];
    newRows.push([
      dryRun ? 'Would Delete' : 'Deleted',
      sheetName,
      deleted.column,
      deleted.index,
      deleted.nonBlankCells,
      dryRun ? 'Dry run only; column and data were not changed' : 'Column and all data removed'
    ]);
  }
  for (var j = 0; j < results.skipped.length; j++) {
    newRows.push(['Skipped', sheetName, results.skipped[j].column, '', '', results.skipped[j].note || 'Header not found']);
  }
  for (var k = 0; k < results.errors.length; k++) {
    newRows.push(['Error', sheetName, results.errors[k].column, '', '', results.errors[k].message]);
  }

  if (newRows.length > 0) {
    var startRow = tab.getLastRow() + 1;
    tab.getRange(startRow, 1, newRows.length, header.length).setValues(newRows);
  }
}

/**
 * Appends merge results to an existing log tab, creating it
 * with a header row if it doesn't exist yet. Used when
 * accumulating results across many target sheets.
 *
 * @param {SpreadsheetApp.Spreadsheet} spreadsheet
 * @param {string} tabName
 * @param {string} sheetName
 * @param {{ filled: Array, conflicts: Array, errors: Array }} results
 */
function appendToResultsLog_(spreadsheet, tabName, sheetName, results) {
  var tab = spreadsheet.getSheetByName(tabName);
  var header = ['Type', 'Spreadsheet', 'Row', 'Column', 'Existing Value', 'New Value'];

  if (!tab) {
    tab = spreadsheet.insertSheet(tabName);
    tab.getRange(1, 1, 1, header.length).setValues([header]);
    formatHeaderRow_(tab, header.length);
    tab.setFrozenRows(1);
  }

  var newRows = [];

  for (var i = 0; i < results.filled.length; i++) {
    var f = results.filled[i];
    newRows.push(['Filled', sheetName, f.row, f.column, f.existingValue, f.newValue]);
  }
  for (var j = 0; j < results.conflicts.length; j++) {
    var c = results.conflicts[j];
    newRows.push(['Conflict', sheetName, c.row, c.column, c.existingValue, c.newValue]);
  }
  for (var k = 0; k < results.errors.length; k++) {
    var e = results.errors[k];
    newRows.push(['Error', sheetName, e.row, e.column, e.existingValue, e.newValue]);
  }

  if (newRows.length > 0) {
    var startRow = tab.getLastRow() + 1;
    tab.getRange(startRow, 1, newRows.length, header.length).setValues(newRows);
  }
}

/**
 * Renames a header in the first row of a target sheet.
 * Only the header row is changed; data rows are untouched.
 *
 * @param {SpreadsheetApp.Sheet} targetSheet
 * @param {string} oldHeader
 * @param {string} newHeader
 * @param {boolean} dryRun
 * @return {{ renamed: boolean, skipped: boolean, error: string, note: string }}
 */
function renameColumnInTarget_(targetSheet, oldHeader, newHeader, dryRun) {
  var data = targetSheet.getDataRange().getValues();
  if (data.length === 0) {
    return { renamed: false, skipped: false, error: 'Target sheet is empty', note: '' };
  }

  var oldName = String(oldHeader).trim();
  var newName = String(newHeader).trim();
  if (oldName === '' || newName === '') {
    return { renamed: false, skipped: false, error: 'Old and new header names are required', note: '' };
  }
  if (oldName === newName) {
    return { renamed: false, skipped: true, error: '', note: 'Old and new header are identical' };
  }

  var headers = data[0].map(function (h) { return String(h).trim(); });
  var oldIdx = headers.indexOf(oldName);
  if (oldIdx === -1) {
    return { renamed: false, skipped: true, error: '', note: 'Old header not found' };
  }

  var newIdx = headers.indexOf(newName);
  if (newIdx !== -1 && newIdx !== oldIdx) {
    return { renamed: false, skipped: true, error: '', note: 'New header already exists' };
  }

  if (!dryRun) {
    data[0][oldIdx] = newName;
    targetSheet.getRange(1, 1, 1, data[0].length).setValues([data[0]]);
  }

  return { renamed: true, skipped: false, error: '', note: '' };
}

/**
 * Appends folder-wide rename results to a log tab.
 *
 * @param {SpreadsheetApp.Spreadsheet} spreadsheet
 * @param {string} tabName
 * @param {string} sheetName
 * @param {string} oldHeader
 * @param {string} newHeader
 * @param {{ renamed: boolean, skipped: boolean, error: string, note: string }} result
 */
function appendToRenameLog_(spreadsheet, tabName, sheetName, oldHeader, newHeader, result) {
  var tab = spreadsheet.getSheetByName(tabName);
  var header = ['Type', 'Spreadsheet', 'Old Header', 'New Header', 'Notes'];
  if (!tab) {
    tab = spreadsheet.insertSheet(tabName);
    tab.getRange(1, 1, 1, header.length).setValues([header]);
    formatHeaderRow_(tab, header.length);
    tab.setFrozenRows(1);
  }

  var rowType = result.renamed ? 'Renamed' : (result.skipped ? 'Skipped' : 'Error');
  var note = result.error || result.note || '';
  tab.getRange(tab.getLastRow() + 1, 1, 1, header.length).setValues([
    [rowType, sheetName, oldHeader, newHeader, note]
  ]);
}

/**
 * Appends rows from master into a target user sheet for residents whose
 * ZoneName matches the target's detected zone but whose resident_id
 * isn't already present in the target. The target's assigned zone is
 * inferred by taking the most common non-blank value in its ZoneName
 * column (same approach as the Phase 1 audit).
 *
 * Column values on the new rows are populated by header-name join:
 * every column where the target header exactly matches a master header
 * is filled from master. Columns present in the target but absent in
 * master are left blank on the new rows.
 *
 * Pure addition. Existing rows are never modified, and rows are never
 * removed. Duplicate resident_ids in master for the same zone are
 * appended once (the first occurrence wins); on subsequent runs, the
 * resident_id will already exist in the target and be skipped.
 *
 * @param {SpreadsheetApp.Sheet} targetSheet
 * @param {Array<Array>} masterData            Full 2D array of master, including header row
 * @param {Array<string>} masterHeaders        Trimmed master header row
 * @param {Array<string>} sensitiveColumns     Column headers considered privacy-sensitive
 * @param {boolean} dryRun                     If true, compute only — never write
 * @return {{ appended: Array, flagged: Array, skipped: Array, errors: Array, detectedZone: string }}
 */
function appendMissingRowsToSheet_(targetSheet, masterData, masterHeaders, sensitiveColumns, dryRun) {
  var result = {
    appended: [],
    flagged: [],
    skipped: [],
    errors: [],
    detectedZone: ''
  };

  var targetData = targetSheet.getDataRange().getValues();
  if (targetData.length === 0) {
    result.errors.push({ message: 'Target sheet is empty (no header row)' });
    return result;
  }

  var targetHeaders = targetData[0].map(function (h) { return String(h).trim(); });
  var targetZoneCol = targetHeaders.indexOf('ZoneName');
  var targetIdCol = targetHeaders.indexOf('resident_id');

  if (targetZoneCol === -1) {
    result.errors.push({ message: 'Target sheet has no ZoneName column' });
    return result;
  }
  if (targetIdCol === -1) {
    result.errors.push({ message: 'Target sheet has no resident_id column' });
    return result;
  }

  var existing = {};
  var zoneCounts = {};
  for (var r = 1; r < targetData.length; r++) {
    var row = targetData[r];

    var id = String(row[targetIdCol] || '').trim();
    if (id !== '' && id !== 'undefined' && id !== 'null') {
      existing[id] = true;
    }

    var zv = String(row[targetZoneCol] || '').trim();
    if (zv !== '') zoneCounts[zv] = (zoneCounts[zv] || 0) + 1;
  }

  var detectedZone = '';
  var topCount = 0;
  Object.keys(zoneCounts).forEach(function (z) {
    if (zoneCounts[z] > topCount) {
      detectedZone = z;
      topCount = zoneCounts[z];
    }
  });
  if (detectedZone === '') {
    result.errors.push({ message: 'No zone detected (ZoneName column has no non-blank values)' });
    return result;
  }
  result.detectedZone = detectedZone;

  var masterIdCol = masterHeaders.indexOf('resident_id');
  var masterZoneCol = masterHeaders.indexOf('ZoneName');
  var masterNameCol = masterHeaders.indexOf('Resident Name');
  if (masterIdCol === -1) {
    result.errors.push({ message: 'Master has no resident_id column' });
    return result;
  }
  if (masterZoneCol === -1) {
    result.errors.push({ message: 'Master has no ZoneName column' });
    return result;
  }

  // Header-name join: target column index -> master column index (or -1 if
  // the target column has no matching master header).
  var colMap = [];
  for (var tc = 0; tc < targetHeaders.length; tc++) {
    var h = targetHeaders[tc];
    colMap.push(h === '' ? -1 : masterHeaders.indexOf(h));
  }

  var sensitiveMasterCols = [];
  var sensitiveColumnNames = [];
  for (var s = 0; s < sensitiveColumns.length; s++) {
    var sName = String(sensitiveColumns[s]).trim();
    if (sName === '') continue;
    var sIdx = masterHeaders.indexOf(sName);
    if (sIdx !== -1) {
      sensitiveMasterCols.push(sIdx);
      sensitiveColumnNames.push(sName);
    }
  }

  var newRows = [];
  for (var mr = 1; mr < masterData.length; mr++) {
    var masterRow = masterData[mr];
    var masterId = String(masterRow[masterIdCol] || '').trim();
    var masterZone = String(masterRow[masterZoneCol] || '').trim();
    if (masterZone !== detectedZone) continue;
    if (masterId === '' || masterId === 'undefined' || masterId === 'null') {
      result.skipped.push({
        residentId: '',
        residentName: '',
        masterRow: mr + 1,
        reason: 'Blank resident_id'
      });
      continue;
    }

    var newRow = [];
    for (var c = 0; c < targetHeaders.length; c++) {
      var src = colMap[c];
      newRow.push(src === -1 ? '' : masterRow[src]);
    }

    var residentName = (masterNameCol !== -1) ? String(masterRow[masterNameCol] || '').trim() : '';

    if (existing[masterId]) {
      result.skipped.push({
        residentId: masterId,
        residentName: residentName,
        masterRow: mr + 1,
        reason: 'resident_id already exists in target sheet or earlier master row'
      });
      continue;
    }

    var flaggedCols = [];
    for (var sc = 0; sc < sensitiveMasterCols.length; sc++) {
      var sv = masterRow[sensitiveMasterCols[sc]];
      if (sv !== '' && sv !== null && sv !== undefined) {
        flaggedCols.push(sensitiveColumnNames[sc]);
      }
    }

    result.appended.push({
      residentId: masterId,
      residentName: residentName,
      masterRow: mr + 1
    });

    if (flaggedCols.length > 0) {
      result.flagged.push({
        residentId: masterId,
        residentName: residentName,
        flaggedColumns: flaggedCols.join(', ')
      });
    }

    newRows.push(newRow);

    // Guard against duplicate master rows with the same resident_id in the
    // same zone — first occurrence wins for this run.
    existing[masterId] = true;
  }

  if (!dryRun && newRows.length > 0) {
    var startRow = targetSheet.getLastRow() + 1;
    targetSheet.getRange(startRow, 1, newRows.length, targetHeaders.length).setValues(newRows);
  }

  return result;
}

/**
 * Builds shared master state for Pull Missing Rows operations. Folder-wide
 * pulls pass this state through each source sheet so dry runs and live runs
 * both skip duplicate resident_ids discovered earlier in the same run.
 *
 * @param {SpreadsheetApp.Sheet} masterSheet
 * @return {{ headers: Array<string>, existingIds: Object, nextMasterRow: number }}
 */
function buildMasterPullState_(masterSheet) {
  var masterData = masterSheet.getDataRange().getValues();
  var headers = masterData.length > 0
    ? masterData[0].map(function (h) { return String(h).trim(); })
    : [];
  var idCol = headers.indexOf('resident_id');
  var existingIds = {};

  if (idCol !== -1) {
    for (var r = 1; r < masterData.length; r++) {
      var id = String(masterData[r][idCol] || '').trim();
      if (id !== '' && id !== 'undefined' && id !== 'null') {
        existingIds[id] = true;
      }
    }
  }

  return {
    headers: headers,
    existingIds: existingIds,
    nextMasterRow: masterSheet.getLastRow() + 1
  };
}

/**
 * Appends rows from a captain/user sheet into the master when their
 * resident_id is not already present in the master. Source-only headers are
 * added to the master first so captain-created fields are preserved.
 *
 * Column values on new master rows are populated by header-name join:
 * every master column where the source has the same header is filled from
 * the source row. Master columns absent from the source are left blank.
 *
 * Pure addition. Existing master rows are never modified, and rows are never
 * removed. Duplicate resident_ids already present in master, or seen earlier
 * in the same pull run, are skipped.
 *
 * @param {SpreadsheetApp.Sheet} masterSheet
 * @param {SpreadsheetApp.Sheet} sourceSheet
 * @param {string} sourceName
 * @param {boolean} dryRun
 * @param {{ headers: Array<string>, existingIds: Object, nextMasterRow: number }} masterState
 * @return {{ columnsAdded: Array, appended: Array, skipped: Array, errors: Array }}
 */
function appendMissingRowsToMaster_(masterSheet, sourceSheet, sourceName, dryRun, masterState) {
  var result = {
    columnsAdded: [],
    appended: [],
    skipped: [],
    errors: []
  };

  if (!masterState || !masterState.headers) {
    masterState = buildMasterPullState_(masterSheet);
  }

  var masterIdCol = masterState.headers.indexOf('resident_id');
  if (masterIdCol === -1) {
    result.errors.push({ message: 'Master has no resident_id column' });
    return result;
  }

  var sourceData = sourceSheet.getDataRange().getValues();
  if (sourceData.length === 0) {
    result.errors.push({ message: 'Source sheet is empty (no header row)' });
    return result;
  }

  var sourceHeaders = sourceData[0].map(function (h) { return String(h).trim(); });
  var sourceIdCol = sourceHeaders.indexOf('resident_id');
  if (sourceIdCol === -1) {
    result.errors.push({ message: 'Source sheet has no resident_id column' });
    return result;
  }

  var sourceIndexByHeader = {};
  var missingHeaders = [];
  var missingSeen = {};
  for (var sh = 0; sh < sourceHeaders.length; sh++) {
    var sourceHeader = sourceHeaders[sh];
    if (sourceHeader === '') continue;
    if (sourceIndexByHeader[sourceHeader] === undefined) {
      sourceIndexByHeader[sourceHeader] = sh;
    }
    if (masterState.headers.indexOf(sourceHeader) === -1 && !missingSeen[sourceHeader]) {
      missingHeaders.push(sourceHeader);
      missingSeen[sourceHeader] = true;
    }
  }

  if (missingHeaders.length > 0) {
    var addResult = addColumnsToTarget_(masterSheet, missingHeaders, dryRun);
    for (var a = 0; a < addResult.added.length; a++) {
      var addedColumn = addResult.added[a].column;
      result.columnsAdded.push({ column: addedColumn });
      masterState.headers.push(addedColumn);
    }
    for (var e = 0; e < addResult.errors.length; e++) {
      result.errors.push({ message: 'Could not add column "' + addResult.errors[e].column + '": ' + addResult.errors[e].message });
    }
  }

  var residentNameCol = sourceHeaders.indexOf('Resident Name');
  var newRows = [];

  for (var r = 1; r < sourceData.length; r++) {
    var sourceRow = sourceData[r];
    var residentId = String(sourceRow[sourceIdCol] || '').trim();
    var residentName = residentNameCol !== -1 ? String(sourceRow[residentNameCol] || '').trim() : '';

    if (residentId === '' || residentId === 'undefined' || residentId === 'null') {
      result.skipped.push({
        sourceRow: r + 1,
        residentId: '',
        residentName: residentName,
        reason: 'Blank resident_id'
      });
      continue;
    }

    if (masterState.existingIds[residentId]) {
      result.skipped.push({
        sourceRow: r + 1,
        residentId: residentId,
        residentName: residentName,
        reason: 'resident_id already exists in master or earlier source row'
      });
      continue;
    }

    var newRow = [];
    for (var mh = 0; mh < masterState.headers.length; mh++) {
      var masterHeader = masterState.headers[mh];
      var sourceIdx = sourceIndexByHeader[masterHeader];
      newRow.push(sourceIdx === undefined ? '' : sourceRow[sourceIdx]);
    }

    var masterRowNumber = masterState.nextMasterRow + newRows.length;
    result.appended.push({
      sourceRow: r + 1,
      masterRow: masterRowNumber,
      residentId: residentId,
      residentName: residentName
    });
    newRows.push(newRow);
    masterState.existingIds[residentId] = true;
  }

  if (!dryRun && newRows.length > 0) {
    var startRow = masterSheet.getLastRow() + 1;
    masterSheet.getRange(startRow, 1, newRows.length, masterState.headers.length).setValues(newRows);
  }

  masterState.nextMasterRow += newRows.length;
  return result;
}

/**
 * Builds shared master state for Pull Data operations. The state carries
 * current master values across all source sheets in one run so later sources
 * see rows/values added or changed by earlier sources.
 *
 * @param {SpreadsheetApp.Sheet} masterSheet
 * @return {{ headers: Array<string>, data: Array<Array>, idToRowIndex: Object, processedIds: Object, nextMasterRow: number }}
 */
function buildMasterPullDataState_(masterSheet) {
  var masterData = masterSheet.getDataRange().getValues();
  var headers = masterData.length > 0
    ? masterData[0].map(function (h) { return String(h).trim(); })
    : [];
  var idCol = headers.indexOf('resident_id');
  var idToRowIndex = {};

  if (idCol !== -1) {
    for (var r = 1; r < masterData.length; r++) {
      var id = String(masterData[r][idCol] || '').trim();
      if (id !== '' && id !== 'undefined' && id !== 'null' && idToRowIndex[id] === undefined) {
        idToRowIndex[id] = r;
      }
    }
  }

  return {
    headers: headers,
    data: masterData,
    idToRowIndex: idToRowIndex,
    processedIds: {},
    nextMasterRow: masterSheet.getLastRow() + 1
  };
}

/**
 * Pulls captain-entered data from a source sheet into the master. Existing
 * master rows are updated according to Pull Column Policy; source rows whose
 * resident_id is absent from master are appended as new master rows.
 *
 * Policy behavior for existing rows:
 * - fill_blank: write only when master is blank; differing non-blank values
 *   are logged as conflicts
 * - overwrite: write any non-blank source value that differs from master
 * - conflict: log differences without writing
 * - never: do not touch the column
 *
 * @param {SpreadsheetApp.Sheet} masterSheet
 * @param {SpreadsheetApp.Sheet} sourceSheet
 * @param {string} sourceName
 * @param {Object} pullColumnPolicies
 * @param {boolean} dryRun
 * @param {{ headers: Array<string>, data: Array<Array>, idToRowIndex: Object, processedIds: Object, nextMasterRow: number }} pullState
 * @return {{ columnsAdded: Array, appended: Array, filled: Array, overwritten: Array, conflicts: Array, skipped: Array, errors: Array }}
 */
function pullDataIntoMaster_(masterSheet, sourceSheet, sourceName, pullColumnPolicies, dryRun, pullState) {
  var result = {
    columnsAdded: [],
    appended: [],
    filled: [],
    overwritten: [],
    conflicts: [],
    skipped: [],
    errors: []
  };

  if (!pullState || !pullState.headers) {
    pullState = buildMasterPullDataState_(masterSheet);
  }
  pullColumnPolicies = pullColumnPolicies || {};
  pullColumnPolicies.resident_id = 'never';

  var masterIdCol = pullState.headers.indexOf('resident_id');
  if (masterIdCol === -1) {
    result.errors.push({ message: 'Master has no resident_id column' });
    return result;
  }

  var sourceData = sourceSheet.getDataRange().getValues();
  if (sourceData.length === 0) {
    result.errors.push({ message: 'Source sheet is empty (no header row)' });
    return result;
  }

  var sourceHeaders = sourceData[0].map(function (h) { return String(h).trim(); });
  var sourceIdCol = sourceHeaders.indexOf('resident_id');
  if (sourceIdCol === -1) {
    result.errors.push({ message: 'Source sheet has no resident_id column' });
    return result;
  }

  var sourceIndexByHeader = {};
  var missingHeaders = [];
  var missingSeen = {};
  for (var sh = 0; sh < sourceHeaders.length; sh++) {
    var sourceHeader = sourceHeaders[sh];
    if (sourceHeader === '') continue;
    if (sourceIndexByHeader[sourceHeader] === undefined) {
      sourceIndexByHeader[sourceHeader] = sh;
    }
    if (pullState.headers.indexOf(sourceHeader) === -1 && !missingSeen[sourceHeader]) {
      missingHeaders.push(sourceHeader);
      missingSeen[sourceHeader] = true;
    }
  }

  if (missingHeaders.length > 0) {
    var addResult = addColumnsToTarget_(masterSheet, missingHeaders, dryRun);
    for (var a = 0; a < addResult.added.length; a++) {
      var addedColumn = addResult.added[a].column;
      result.columnsAdded.push({ column: addedColumn });
      pullState.headers.push(addedColumn);
      for (var dr = 0; dr < pullState.data.length; dr++) {
        pullState.data[dr].push(dr === 0 ? addedColumn : '');
      }
    }
    for (var e = 0; e < addResult.errors.length; e++) {
      result.errors.push({ message: 'Could not add column "' + addResult.errors[e].column + '": ' + addResult.errors[e].message });
    }
  }

  var residentNameCol = sourceHeaders.indexOf('Resident Name');
  var writeQueue = [];
  var newRows = [];

  for (var r = 1; r < sourceData.length; r++) {
    var sourceRow = sourceData[r];
    var residentId = String(sourceRow[sourceIdCol] || '').trim();
    var residentName = residentNameCol !== -1 ? String(sourceRow[residentNameCol] || '').trim() : '';

    if (residentId === '' || residentId === 'undefined' || residentId === 'null') {
      result.skipped.push({
        sourceRow: r + 1,
        masterRow: '',
        residentId: '',
        residentName: residentName,
        column: '',
        policy: '',
        existingValue: '',
        newValue: '',
        reason: 'Blank resident_id'
      });
      continue;
    }

    if (pullState.processedIds[residentId]) {
      result.skipped.push({
        sourceRow: r + 1,
        masterRow: '',
        residentId: residentId,
        residentName: residentName,
        column: '',
        policy: '',
        existingValue: '',
        newValue: '',
        reason: 'resident_id already processed earlier in this pull run'
      });
      continue;
    }

    var masterRowIndex = pullState.idToRowIndex[residentId];
    if (masterRowIndex === undefined) {
      var newRow = [];
      for (var mh = 0; mh < pullState.headers.length; mh++) {
        var masterHeader = pullState.headers[mh];
        var sourceIdx = sourceIndexByHeader[masterHeader];
        newRow.push(sourceIdx === undefined ? '' : sourceRow[sourceIdx]);
      }

      var masterRowNumber = pullState.nextMasterRow + newRows.length;
      result.appended.push({
        sourceRow: r + 1,
        masterRow: masterRowNumber,
        residentId: residentId,
        residentName: residentName
      });
      newRows.push(newRow);
      pullState.data.push(newRow);
      pullState.idToRowIndex[residentId] = pullState.data.length - 1;
      pullState.processedIds[residentId] = true;
      continue;
    }

    var masterRow = pullState.data[masterRowIndex];
    var masterRowNum = masterRowIndex + 1;
    for (var h = 0; h < pullState.headers.length; h++) {
      var header = pullState.headers[h];
      if (header === '') continue;
      var srcIdx = sourceIndexByHeader[header];
      if (srcIdx === undefined) continue;

      var sourceVal = sourceRow[srcIdx];
      if (isSpreadsheetSourceCellBlank_(sourceVal)) continue;

      var masterVal = masterRow[h];
      var masterBlank = isSpreadsheetCellBlank_(masterVal);
      var policy = pullColumnPolicies[header] || 'conflict';

      if (policy === 'never') {
        if (header !== 'resident_id') {
          result.skipped.push({
            sourceRow: r + 1,
            masterRow: masterRowNum,
            residentId: residentId,
            residentName: residentName,
            column: header,
            policy: policy,
            existingValue: masterVal,
            newValue: sourceVal,
            reason: 'Policy is never'
          });
        }
        continue;
      }

      if (cellValuesEqual_(masterVal, sourceVal)) continue;

      if (policy === 'fill_blank') {
        if (masterBlank) {
          result.filled.push(makePullDataCellResult_(r + 1, masterRowNum, residentId, residentName, header, policy, masterVal, sourceVal));
          writeQueue.push({ row: masterRowNum, col: h + 1, val: sourceVal, wasCheckbox: (masterVal === false) });
          masterRow[h] = sourceVal;
        } else {
          result.conflicts.push(makePullDataCellResult_(r + 1, masterRowNum, residentId, residentName, header, policy, masterVal, sourceVal));
        }
      } else if (policy === 'overwrite') {
        if (masterBlank) {
          result.filled.push(makePullDataCellResult_(r + 1, masterRowNum, residentId, residentName, header, policy, masterVal, sourceVal));
        } else {
          result.overwritten.push(makePullDataCellResult_(r + 1, masterRowNum, residentId, residentName, header, policy, masterVal, sourceVal));
        }
        writeQueue.push({ row: masterRowNum, col: h + 1, val: sourceVal, wasCheckbox: (masterVal === false) });
        masterRow[h] = sourceVal;
      } else {
        result.conflicts.push(makePullDataCellResult_(r + 1, masterRowNum, residentId, residentName, header, policy, masterVal, sourceVal));
      }
    }

    pullState.processedIds[residentId] = true;
  }

  if (!dryRun) {
    for (var w = 0; w < writeQueue.length; w++) {
      var cell = masterSheet.getRange(writeQueue[w].row, writeQueue[w].col);
      if (writeQueue[w].wasCheckbox) {
        cell.clearDataValidations();
        cell.setNumberFormat('General');
      }
      cell.setValue(writeQueue[w].val);
    }

    if (newRows.length > 0) {
      var startRow = masterSheet.getLastRow() + 1;
      masterSheet.getRange(startRow, 1, newRows.length, pullState.headers.length).setValues(newRows);
    }
  }

  pullState.nextMasterRow += newRows.length;
  return result;
}

/**
 * Creates a standard cell-level pull-data result entry.
 */
function makePullDataCellResult_(sourceRow, masterRow, residentId, residentName, column, policy, existingValue, newValue) {
  return {
    sourceRow: sourceRow,
    masterRow: masterRow,
    residentId: residentId,
    residentName: residentName,
    column: column,
    policy: policy,
    existingValue: existingValue,
    newValue: newValue
  };
}

/**
 * Appends rows-appended results to a log tab, creating the tab with
 * a header row on first write. Errors are recorded inline.
 *
 * @param {SpreadsheetApp.Spreadsheet} spreadsheet
 * @param {string} tabName
 * @param {string} sheetName
 * @param {string} detectedZone
 * @param {{ appended: Array, flagged: Array, skipped: Array, errors: Array, detectedZone: string }} result
 */
function appendToMissingRowsLog_(spreadsheet, tabName, sheetName, detectedZone, result) {
  var tab = spreadsheet.getSheetByName(tabName);
  var header = ['Spreadsheet', 'Detected Zone', 'resident_id', 'Resident Name', 'Master Row #', 'Status', 'Notes'];
  if (!tab) {
    tab = spreadsheet.insertSheet(tabName);
    tab.getRange(1, 1, 1, header.length).setValues([header]);
    formatHeaderRow_(tab, header.length);
    tab.setFrozenRows(1);
  }

  var newRows = [];
  for (var i = 0; i < result.appended.length; i++) {
    var a = result.appended[i];
    newRows.push([sheetName, detectedZone, a.residentId, a.residentName, a.masterRow, 'Appended', '']);
  }
  if (result.skipped) {
    for (var j = 0; j < result.skipped.length; j++) {
      var skipped = result.skipped[j];
      newRows.push([sheetName, detectedZone, skipped.residentId, skipped.residentName, skipped.masterRow, 'Skipped', skipped.reason]);
    }
  }
  for (var k = 0; k < result.errors.length; k++) {
    newRows.push([sheetName, detectedZone || '(none)', '', '', '', 'Error', result.errors[k].message]);
  }

  if (newRows.length > 0) {
    var startRow = tab.getLastRow() + 1;
    tab.getRange(startRow, 1, newRows.length, header.length).setValues(newRows);
  }
}

/**
 * Appends flagged-sensitive-data entries to a log tab, creating the
 * tab with a header row on first write. Only rows that had a non-blank
 * value in at least one sensitive column are written here.
 *
 * @param {SpreadsheetApp.Spreadsheet} spreadsheet
 * @param {string} tabName
 * @param {string} sheetName
 * @param {string} detectedZone
 * @param {{ flagged: Array }} result
 */
function appendToFlaggedSensitiveLog_(spreadsheet, tabName, sheetName, detectedZone, result) {
  var tab = spreadsheet.getSheetByName(tabName);
  var header = ['Spreadsheet', 'Detected Zone', 'resident_id', 'Resident Name', 'Flagged Columns'];
  if (!tab) {
    tab = spreadsheet.insertSheet(tabName);
    tab.getRange(1, 1, 1, header.length).setValues([header]);
    formatHeaderRow_(tab, header.length);
    tab.setFrozenRows(1);
  }

  var newRows = [];
  for (var i = 0; i < result.flagged.length; i++) {
    var f = result.flagged[i];
    newRows.push([sheetName, detectedZone, f.residentId, f.residentName, f.flaggedColumns]);
  }

  if (newRows.length > 0) {
    var startRow = tab.getLastRow() + 1;
    tab.getRange(startRow, 1, newRows.length, header.length).setValues(newRows);
  }
}

/**
 * Appends pull-missing-rows results to a log tab, creating the tab with
 * a header row on first write. Includes columns added to master, rows
 * appended to master, skipped source rows, and errors.
 *
 * @param {SpreadsheetApp.Spreadsheet} spreadsheet
 * @param {string} tabName
 * @param {string} sourceName
 * @param {{ columnsAdded: Array, appended: Array, skipped: Array, errors: Array }} result
 */
function appendToPullMissingRowsLog_(spreadsheet, tabName, sourceName, result) {
  var tab = spreadsheet.getSheetByName(tabName);
  var header = ['Type', 'Source Spreadsheet', 'Source Row #', 'Master Row #', 'resident_id', 'Resident Name', 'Column', 'Notes'];
  if (!tab) {
    tab = spreadsheet.insertSheet(tabName);
    tab.getRange(1, 1, 1, header.length).setValues([header]);
    formatHeaderRow_(tab, header.length);
    tab.setFrozenRows(1);
  }

  var newRows = [];
  for (var c = 0; c < result.columnsAdded.length; c++) {
    newRows.push(['Column Added', sourceName, '', 1, '', '', result.columnsAdded[c].column, 'Added to master']);
  }
  for (var a = 0; a < result.appended.length; a++) {
    var appended = result.appended[a];
    newRows.push([
      'Appended',
      sourceName,
      appended.sourceRow,
      appended.masterRow,
      appended.residentId,
      appended.residentName,
      '',
      'Appended to master'
    ]);
  }
  for (var s = 0; s < result.skipped.length; s++) {
    var skipped = result.skipped[s];
    newRows.push([
      'Skipped',
      sourceName,
      skipped.sourceRow,
      '',
      skipped.residentId,
      skipped.residentName,
      '',
      skipped.reason
    ]);
  }
  for (var e = 0; e < result.errors.length; e++) {
    newRows.push(['Error', sourceName, '', '', '', '', '', result.errors[e].message]);
  }

  if (newRows.length > 0) {
    var startRow = tab.getLastRow() + 1;
    tab.getRange(startRow, 1, newRows.length, header.length).setValues(newRows);
  }
}

/**
 * Appends policy-driven pull-data results to a log tab, creating the tab with
 * a header row on first write.
 *
 * @param {SpreadsheetApp.Spreadsheet} spreadsheet
 * @param {string} tabName
 * @param {string} sourceName
 * @param {{ columnsAdded: Array, appended: Array, filled: Array, overwritten: Array, conflicts: Array, skipped: Array, errors: Array }} result
 */
function appendToPullDataLog_(spreadsheet, tabName, sourceName, result) {
  var tab = spreadsheet.getSheetByName(tabName);
  var header = [
    'Type',
    'Source Spreadsheet',
    'Source Row #',
    'Master Row #',
    'resident_id',
    'Resident Name',
    'Column',
    'Policy',
    'Existing Master Value',
    'Source Value',
    'Notes'
  ];
  if (!tab) {
    tab = spreadsheet.insertSheet(tabName);
    tab.getRange(1, 1, 1, header.length).setValues([header]);
    formatHeaderRow_(tab, header.length);
    tab.setFrozenRows(1);
  }

  var newRows = [];

  for (var c = 0; c < result.columnsAdded.length; c++) {
    newRows.push(['Column Added', sourceName, '', 1, '', '', result.columnsAdded[c].column, '', '', '', 'Added to master']);
  }

  for (var a = 0; a < result.appended.length; a++) {
    var appended = result.appended[a];
    newRows.push([
      'Appended',
      sourceName,
      appended.sourceRow,
      appended.masterRow,
      appended.residentId,
      appended.residentName,
      '',
      '',
      '',
      '',
      'Appended source row to master'
    ]);
  }

  appendPullDataCellRows_(newRows, sourceName, 'Filled', result.filled, 'Filled master from source');
  appendPullDataCellRows_(newRows, sourceName, 'Overwritten', result.overwritten, 'Overwrote master from source');
  appendPullDataCellRows_(newRows, sourceName, 'Conflict', result.conflicts, 'Policy did not allow write');

  for (var s = 0; s < result.skipped.length; s++) {
    var skipped = result.skipped[s];
    newRows.push([
      'Skipped',
      sourceName,
      skipped.sourceRow,
      skipped.masterRow,
      skipped.residentId,
      skipped.residentName,
      skipped.column,
      skipped.policy,
      skipped.existingValue,
      skipped.newValue,
      skipped.reason
    ]);
  }

  for (var e = 0; e < result.errors.length; e++) {
    newRows.push(['Error', sourceName, '', '', '', '', '', '', '', '', result.errors[e].message]);
  }

  if (newRows.length > 0) {
    var startRow = tab.getLastRow() + 1;
    tab.getRange(startRow, 1, newRows.length, header.length).setValues(newRows);
  }
}

/**
 * Adds cell-level pull-data entries to an output row array.
 *
 * @param {Array<Array>} rows
 * @param {string} sourceName
 * @param {string} type
 * @param {Array} entries
 * @param {string} note
 */
function appendPullDataCellRows_(rows, sourceName, type, entries, note) {
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    rows.push([
      type,
      sourceName,
      entry.sourceRow,
      entry.masterRow,
      entry.residentId,
      entry.residentName,
      entry.column,
      entry.policy,
      entry.existingValue,
      entry.newValue,
      note
    ]);
  }
}

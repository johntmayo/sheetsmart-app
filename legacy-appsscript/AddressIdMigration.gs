/**
 * Google Apps Script - address_id migration.
 *
 * Paste this into the master spreadsheet's Apps Script project, then run:
 * - auditAddressIds() first: writes an audit tab only, no data changes.
 * - backfillAddressIds() after review: fills blank address_id values.
 *
 * address_id is one UUID per normalized Situs address, shared by every
 * resident row at that same address.
 */

var ADDRESS_ID_COLUMN_NAME_ = 'address_id';
var ADDRESS_ID_PREFIX_ = 'addr_';
var ADDRESS_ID_AUDIT_TAB_NAME_ = 'Address ID Audit';
var ADDRESS_ID_CANONICAL_COLUMNS_ = [
  '_SitusHouseNo',
  '_SitusDirection',
  '_SitusStreet',
  '_SitusUnit',
  'City',
  'State',
  'Zip'
];
var ADDRESS_ID_TEXT_COLUMNS_ = [
  '_SitusHouseNo',
  '_SitusUnit',
  'Zip',
  ADDRESS_ID_COLUMN_NAME_
];

/**
 * Audit-only entry point. Produces a fresh "Address ID Audit" tab and does
 * not write address_id values into the data sheet.
 */
function auditAddressIds() {
  runAddressIdMigration_(true);
}

/**
 * Live entry point. Produces the same audit tab, then fills blank address_id
 * cells when no existing-ID conflicts are found.
 */
function backfillAddressIds() {
  runAddressIdMigration_(false);
}

/**
 * @param {boolean} dryRun
 */
function runAddressIdMigration_(dryRun) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  var ui = SpreadsheetApp.getUi();
  if (sheet.getName() === ADDRESS_ID_AUDIT_TAB_NAME_) {
    ui.alert('Select the master data tab before running the address_id migration.');
    return;
  }

  var data = sheet.getDataRange().getValues();

  if (data.length < 2) {
    ui.alert('The active sheet has no data rows.');
    return;
  }

  var headers = data[0].map(function (h) { return String(h).trim(); });
  var headerMap = buildAddressIdHeaderMap_(headers);
  var missing = findMissingAddressIdHeaders_(headerMap);
  if (missing.length > 0) {
    ui.alert('Missing required address columns:\n\n' + missing.join('\n'));
    return;
  }

  var addressIdCol = ensureAddressIdColumn_(sheet, headers, headerMap, dryRun);
  var analysis = analyzeAddressIdRows_(data, headerMap, addressIdCol);
  writeAddressIdAudit_(ss, analysis, dryRun);

  if (!dryRun && analysis.conflictCount > 0) {
    ui.alert(
      'Address ID audit complete, but live backfill was blocked.\n\n' +
      'Existing address_id conflicts found: ' + analysis.conflictCount + '\n' +
      'Review the "' + ADDRESS_ID_AUDIT_TAB_NAME_ + '" tab before writing IDs.'
    );
    return;
  }

  if (!dryRun) {
    protectAddressIdTextColumns_(sheet, headerMap, addressIdCol, data.length);
    writeBackfilledAddressIds_(sheet, data, addressIdCol, analysis.rowAssignments);
    SpreadsheetApp.flush();
  }

  var prefix = dryRun ? 'DRY RUN - Address ID audit complete.\n\n' : 'Address ID backfill complete.\n\n';
  ui.alert(
    prefix +
    'Rows examined: ' + (data.length - 1) + '\n' +
    'Address groups: ' + analysis.groupCount + '\n' +
    'Rows already with address_id: ' + analysis.existingIdRows + '\n' +
    (dryRun ? 'Rows that would be filled: ' : 'Rows filled: ') + analysis.rowsToFill + '\n' +
    'Rows skipped: ' + analysis.skippedRows.length + '\n' +
    'Blocking conflicts: ' + analysis.conflictCount + '\n' +
    'Warnings: ' + analysis.warningCount + '\n\n' +
    'See the "' + ADDRESS_ID_AUDIT_TAB_NAME_ + '" tab for details.'
  );
}

/**
 * @param {Array<string>} headers
 * @return {Object}
 */
function buildAddressIdHeaderMap_(headers) {
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var header = String(headers[i] || '').trim();
    if (header !== '' && map[header] === undefined) {
      map[header] = i;
    }
  }
  return map;
}

/**
 * @param {Object} headerMap
 * @return {Array<string>}
 */
function findMissingAddressIdHeaders_(headerMap) {
  var missing = [];
  for (var i = 0; i < ADDRESS_ID_CANONICAL_COLUMNS_.length; i++) {
    var column = ADDRESS_ID_CANONICAL_COLUMNS_[i];
    if (headerMap[column] === undefined) missing.push(column);
  }
  return missing;
}

/**
 * @param {SpreadsheetApp.Sheet} sheet
 * @param {Array<string>} headers
 * @param {Object} headerMap
 * @param {boolean} dryRun
 * @return {number}
 */
function ensureAddressIdColumn_(sheet, headers, headerMap, dryRun) {
  if (headerMap[ADDRESS_ID_COLUMN_NAME_] !== undefined) {
    return headerMap[ADDRESS_ID_COLUMN_NAME_];
  }

  var nextCol = headers.length + 1;
  headerMap[ADDRESS_ID_COLUMN_NAME_] = headers.length;
  if (!dryRun) {
    sheet.getRange(1, nextCol).setValue(ADDRESS_ID_COLUMN_NAME_);
  }
  return headers.length;
}

/**
 * Sets fragile address-like columns to plain text so future sheet edits are
 * less likely to turn "1/2" into a date.
 *
 * @param {SpreadsheetApp.Sheet} sheet
 * @param {Object} headerMap
 * @param {number} addressIdCol
 * @param {number} dataRowsIncludingHeader
 */
function protectAddressIdTextColumns_(sheet, headerMap, addressIdCol, dataRowsIncludingHeader) {
  var rows = Math.max(sheet.getMaxRows(), dataRowsIncludingHeader);
  for (var i = 0; i < ADDRESS_ID_TEXT_COLUMNS_.length; i++) {
    var column = ADDRESS_ID_TEXT_COLUMNS_[i];
    var idx = column === ADDRESS_ID_COLUMN_NAME_ ? addressIdCol : headerMap[column];
    if (idx === undefined || idx < 0) continue;
    sheet.getRange(1, idx + 1, rows, 1).setNumberFormat('@');
  }
}

/**
 * @param {Array<Array>} data
 * @param {Object} headerMap
 * @param {number} addressIdCol
 * @return {Object}
 */
function analyzeAddressIdRows_(data, headerMap, addressIdCol) {
  var groups = {};
  var groupOrder = [];
  var existingIds = {};
  var existingIdRows = 0;
  var skippedRows = [];
  var rowAssignments = {};
  var warningCount = 0;

  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var parts = buildAddressIdKeyParts_(row, headerMap);
    var key = parts.key;
    var existingId = String(row[addressIdCol] || '').trim();
    var warnings = collectAddressIdRowWarnings_(row, headerMap);
    if (existingId !== '' && existingId.indexOf(ADDRESS_ID_PREFIX_) !== 0) {
      warnings.push('Existing address_id does not start with "' + ADDRESS_ID_PREFIX_ + '"');
    }

    warningCount += warnings.length;
    if (existingId !== '') existingIdRows++;

    if (key === '') {
      skippedRows.push({
        row: r + 1,
        existingId: existingId,
        reason: 'Blank canonical address key',
        warnings: warnings.join('; ')
      });
      continue;
    }

    if (!groups[key]) {
      groups[key] = {
        key: key,
        parts: parts.displayParts,
        rows: [],
        existingIds: {},
        proposedId: '',
        warnings: {}
      };
      groupOrder.push(key);
    }

    groups[key].rows.push(r);
    if (existingId !== '') {
      groups[key].existingIds[existingId] = true;
      existingIds[existingId] = existingIds[existingId] || {};
      existingIds[existingId][key] = true;
    }
    for (var w = 0; w < warnings.length; w++) {
      groups[key].warnings[warnings[w]] = true;
    }
  }

  var usedIds = {};
  for (var existingIdKey in existingIds) {
    if (Object.prototype.hasOwnProperty.call(existingIds, existingIdKey)) {
      usedIds[existingIdKey] = true;
    }
  }

  var rowsToFill = 0;
  var conflictCount = 0;
  var groupsWithConflictingIds = {};
  var idsUsedByMultipleKeys = {};

  for (var i = 0; i < groupOrder.length; i++) {
    var groupKey = groupOrder[i];
    var group = groups[groupKey];
    var groupExistingIds = Object.keys(group.existingIds);

    if (groupExistingIds.length > 1) {
      conflictCount++;
      groupsWithConflictingIds[groupKey] = groupExistingIds;
    }

    group.proposedId = groupExistingIds.length === 1
      ? groupExistingIds[0]
      : generateAddressIdUniqueUuid_(usedIds);
    usedIds[group.proposedId] = true;

    for (var gr = 0; gr < group.rows.length; gr++) {
      var rowIndex = group.rows[gr];
      var rowExistingId = String(data[rowIndex][addressIdCol] || '').trim();
      if (rowExistingId === '') {
        rowAssignments[rowIndex] = group.proposedId;
        rowsToFill++;
      }
    }
  }

  for (var id in existingIds) {
    if (!Object.prototype.hasOwnProperty.call(existingIds, id)) continue;
    var keys = Object.keys(existingIds[id]);
    if (keys.length > 1) {
      conflictCount++;
      idsUsedByMultipleKeys[id] = keys;
    }
  }

  return {
    groups: groups,
    groupOrder: groupOrder,
    groupCount: groupOrder.length,
    skippedRows: skippedRows,
    rowAssignments: rowAssignments,
    rowsToFill: rowsToFill,
    existingIdRows: existingIdRows,
    warningCount: warningCount,
    conflictCount: conflictCount,
    groupsWithConflictingIds: groupsWithConflictingIds,
    idsUsedByMultipleKeys: idsUsedByMultipleKeys
  };
}

/**
 * @param {Array} row
 * @param {Object} headerMap
 * @return {{key: string, displayParts: Object}}
 */
function buildAddressIdKeyParts_(row, headerMap) {
  var house = normalizeAddressIdLooseText_(row[headerMap['_SitusHouseNo']]);
  var direction = normalizeAddressIdDirection_(row[headerMap['_SitusDirection']]);
  var street = normalizeAddressIdStreet_(row[headerMap['_SitusStreet']]);
  var unit = normalizeAddressIdUnit_(row[headerMap['_SitusUnit']]);
  var city = normalizeAddressIdLooseText_(row[headerMap['City']]);
  var state = normalizeAddressIdState_(row[headerMap['State']]);
  var zip = normalizeAddressIdZip_(row[headerMap['Zip']]);

  var allBlank = [house, direction, street, unit, city, state, zip].join('') === '';
  return {
    key: allBlank ? '' : [house, direction, street, unit, city, state, zip].join('|'),
    displayParts: {
      house: house,
      direction: direction,
      street: street,
      unit: unit,
      city: city,
      state: state,
      zip: zip
    }
  };
}

/**
 * @param {*} value
 * @return {string}
 */
function normalizeAddressIdLooseText_(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,#]/g, '');
}

/**
 * @param {*} value
 * @return {string}
 */
function normalizeAddressIdDirection_(value) {
  var text = normalizeAddressIdLooseText_(value);
  var map = {
    N: 'NORTH',
    S: 'SOUTH',
    E: 'EAST',
    W: 'WEST',
    NE: 'NORTHEAST',
    NW: 'NORTHWEST',
    SE: 'SOUTHEAST',
    SW: 'SOUTHWEST'
  };
  return map[text] || text;
}

/**
 * @param {*} value
 * @return {string}
 */
function normalizeAddressIdStreet_(value) {
  var text = normalizeAddressIdLooseText_(value);
  if (text === '') return '';

  var tokens = text.split(' ');
  var suffixMap = {
    ALY: 'ALLEY',
    AV: 'AVENUE',
    AVE: 'AVENUE',
    AVEN: 'AVENUE',
    BL: 'BOULEVARD',
    BLVD: 'BOULEVARD',
    CIR: 'CIRCLE',
    CT: 'COURT',
    DR: 'DRIVE',
    DRV: 'DRIVE',
    HWY: 'HIGHWAY',
    LN: 'LANE',
    PL: 'PLACE',
    PKWY: 'PARKWAY',
    RD: 'ROAD',
    SQ: 'SQUARE',
    ST: 'STREET',
    TER: 'TERRACE',
    TRL: 'TRAIL',
    WAY: 'WAY'
  };
  var last = tokens[tokens.length - 1];
  if (suffixMap[last]) {
    tokens[tokens.length - 1] = suffixMap[last];
  }
  return tokens.join(' ');
}

/**
 * @param {*} value
 * @return {string}
 */
function normalizeAddressIdUnit_(value) {
  return normalizeAddressIdLooseText_(value);
}

/**
 * @param {*} value
 * @return {string}
 */
function normalizeAddressIdState_(value) {
  return normalizeAddressIdLooseText_(value);
}

/**
 * @param {*} value
 * @return {string}
 */
function normalizeAddressIdZip_(value) {
  var text = normalizeAddressIdLooseText_(value);
  var match = text.match(/^(\d{5})(?:-\d{4})?$/);
  return match ? match[1] : text;
}

/**
 * @param {Array} row
 * @param {Object} headerMap
 * @return {Array<string>}
 */
function collectAddressIdRowWarnings_(row, headerMap) {
  var warnings = [];
  var fragileColumns = ['_SitusHouseNo', '_SitusUnit'];
  for (var i = 0; i < fragileColumns.length; i++) {
    var column = fragileColumns[i];
    var value = row[headerMap[column]];
    if (Object.prototype.toString.call(value) === '[object Date]') {
      warnings.push(column + ' is a Date object');
      continue;
    }

    var text = String(value || '').trim();
    if (text === '') continue;
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text)) {
      warnings.push(column + ' looks like a slash-date: ' + text);
    } else if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*[- ]\d{1,2}$/i.test(text)) {
      warnings.push(column + ' looks like a month-day value: ' + text);
    } else if (/^\d{1,2}[- ](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*$/i.test(text)) {
      warnings.push(column + ' looks like a day-month value: ' + text);
    }
  }
  return warnings;
}

/**
 * @param {SpreadsheetApp.Spreadsheet} ss
 * @param {Object} analysis
 * @param {boolean} dryRun
 */
function writeAddressIdAudit_(ss, analysis, dryRun) {
  var old = ss.getSheetByName(ADDRESS_ID_AUDIT_TAB_NAME_);
  if (old) ss.deleteSheet(old);

  var tab = ss.insertSheet(ADDRESS_ID_AUDIT_TAB_NAME_);
  var rows = [];
  rows.push(['Section', 'Value']);
  rows.push(['Mode', dryRun ? 'Dry Run' : 'Live Backfill']);
  rows.push(['Address groups', analysis.groupCount]);
  rows.push(['Rows already with address_id', analysis.existingIdRows]);
  rows.push([dryRun ? 'Rows that would be filled' : 'Rows filled', analysis.rowsToFill]);
  rows.push(['Skipped rows', analysis.skippedRows.length]);
  rows.push(['Warnings', analysis.warningCount]);
  rows.push(['Blocking conflicts', analysis.conflictCount]);
  rows.push(['', '']);

  rows.push([
    'Group',
    'Proposed address_id',
    'Row count',
    'Sample sheet rows',
    '_SitusHouseNo',
    '_SitusDirection',
    '_SitusStreet',
    '_SitusUnit',
    'City',
    'State',
    'Zip',
    'Existing address_id values',
    'Warnings'
  ]);

  for (var i = 0; i < analysis.groupOrder.length; i++) {
    var key = analysis.groupOrder[i];
    var group = analysis.groups[key];
    var sampleRows = group.rows.slice(0, 10).map(function (rowIndex) { return rowIndex + 1; }).join(', ');
    var existingIds = Object.keys(group.existingIds).join(', ');
    var warnings = Object.keys(group.warnings).join('; ');
    rows.push([
      key,
      group.proposedId,
      group.rows.length,
      sampleRows,
      group.parts.house,
      group.parts.direction,
      group.parts.street,
      group.parts.unit,
      group.parts.city,
      group.parts.state,
      group.parts.zip,
      existingIds,
      warnings
    ]);
  }

  rows.push(['', '']);
  rows.push(['Skipped Row', 'Existing address_id', 'Reason', 'Warnings']);
  for (var s = 0; s < analysis.skippedRows.length; s++) {
    var skipped = analysis.skippedRows[s];
    rows.push([skipped.row, skipped.existingId, skipped.reason, skipped.warnings]);
  }

  rows.push(['', '']);
  rows.push(['Conflict Type', 'ID or Address Key', 'Conflicting Values']);
  for (var groupKey in analysis.groupsWithConflictingIds) {
    if (!Object.prototype.hasOwnProperty.call(analysis.groupsWithConflictingIds, groupKey)) continue;
    rows.push(['One address has multiple IDs', groupKey, analysis.groupsWithConflictingIds[groupKey].join(', ')]);
  }
  for (var id in analysis.idsUsedByMultipleKeys) {
    if (!Object.prototype.hasOwnProperty.call(analysis.idsUsedByMultipleKeys, id)) continue;
    rows.push(['One ID used by multiple addresses', id, analysis.idsUsedByMultipleKeys[id].join(' || ')]);
  }

  var paddedRows = padAddressIdAuditRows_(rows);
  tab.getRange(1, 1, paddedRows.length, paddedRows[0].length).setValues(paddedRows);
  tab.setFrozenRows(1);
  tab.autoResizeColumns(1, Math.min(paddedRows[0].length, 13));
}

/**
 * @param {Array<Array>} rows
 * @return {Array<Array>}
 */
function padAddressIdAuditRows_(rows) {
  var width = 0;
  for (var i = 0; i < rows.length; i++) {
    width = Math.max(width, rows[i].length);
  }
  for (var r = 0; r < rows.length; r++) {
    while (rows[r].length < width) rows[r].push('');
  }
  return rows;
}

/**
 * @param {SpreadsheetApp.Sheet} sheet
 * @param {Array<Array>} data
 * @param {number} addressIdCol
 * @param {Object} rowAssignments
 */
function writeBackfilledAddressIds_(sheet, data, addressIdCol, rowAssignments) {
  var colRange = sheet.getRange(2, addressIdCol + 1, data.length - 1, 1);
  var colVals = colRange.getValues();

  for (var rowIndexText in rowAssignments) {
    if (!Object.prototype.hasOwnProperty.call(rowAssignments, rowIndexText)) continue;
    var rowIndex = Number(rowIndexText);
    colVals[rowIndex - 1][0] = rowAssignments[rowIndexText];
  }

  colRange.setValues(colVals);
}

/**
 * @param {Object} existingSet
 * @return {string}
 */
function generateAddressIdUniqueUuid_(existingSet) {
  for (var attempt = 0; attempt < 10; attempt++) {
    var uuid = ADDRESS_ID_PREFIX_ + generateAddressIdUuidV4_();
    if (!existingSet[uuid]) return uuid;
  }
  throw new Error('Failed to generate a unique address_id after 10 attempts.');
}

/**
 * @return {string}
 */
function generateAddressIdUuidV4_() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0;
    var v = c === 'y' ? (r & 0x3 | 0x8) : r;
    return v.toString(16);
  });
}


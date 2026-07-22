// ============================================================
// Sheet Smart — Spreadsheet Audit Script
// ============================================================
// Paste this into a standalone Google Apps Script project at
// https://script.google.com and run `runAudit()`.
// ============================================================

const FOLDER_ID = 'your-folder-id-here';
const MASTER_SPREADSHEET_ID = 'your-master-spreadsheet-id-here';

/**
 * Main entry point. Scans every spreadsheet in the target folder,
 * compares columns and row membership against the master, counts
 * non-blank cells, and writes an eight-tab audit report to a new
 * spreadsheet.
 */
function runAudit() {
  const masterData = readMasterData_();
  const masterHeaders = masterData.headers;
  const masterRoster = masterData.roster;
  const masterResidents = masterData.residents;
  const rowMembershipSkipReason = masterData.rowMembershipSkipReason || '';

  const folder = DriveApp.getFolderById(FOLDER_ID);
  const sheets = collectSpreadsheets_(folder);

  const overviewRows = [];
  const detailRows = [];
  const residentIdEntries = [];
  const missingRowsAll = [];
  const extraRowsAll = [];
  const missingSitusRowsAll = [];
  const apnInconsistencyRowsAll = [];

  sheets.forEach(function (file) {
    var id = file.getId();
    var name = file.getName();
    var url = file.getUrl();
    var lastEdited = file.getLastUpdated();
    var lastEditor = getLastEditor_(id);

    try {
      var ss = SpreadsheetApp.openById(id);
    } catch (e) {
      overviewRows.push([
        name, url, lastEdited, lastEditor,
        'ERROR', '', '', '',
        '', '', '',
        '', '', '',
        '', '', e.message
      ]);
      return;
    }

    var sheet = ss.getSheets()[0];
    var data = sheet.getDataRange().getValues();

    if (data.length === 0) {
      overviewRows.push([
        name, url, lastEdited, lastEditor,
        0, 0, '', '',
        '', '(no data)',
        '', '', '', '',
        '', '', 'Empty'
      ]);
      return;
    }

    var headers = data[0].map(function (h) { return String(h).trim(); });
    var dataRows = data.slice(1);
    var totalDataRows = dataRows.length;

    var assignedZone = detectSheetZone_(headers, dataRows);
    var zoneDisplay = assignedZone || '(no zone detected)';

    collectResidentIds_(headers, dataRows, name, url, residentIdEntries);
    var missingSitusRows = collectRowsMissingSitusAddress_(
      headers, dataRows, name, url, assignedZone
    );
    for (var ms = 0; ms < missingSitusRows.length; ms++) missingSitusRowsAll.push(missingSitusRows[ms]);

    var masterSet = {};
    masterHeaders.forEach(function (h) { masterSet[h] = true; });

    var sheetSet = {};
    headers.forEach(function (h) { if (h !== '') sheetSet[h] = true; });

    var missing = masterHeaders.filter(function (h) { return !sheetSet[h]; });
    var extra = headers.filter(function (h) { return h !== '' && !masterSet[h]; });

    var status = 'Match';
    if (missing.length > 0 && extra.length > 0) status = 'Missing + Extra';
    else if (missing.length > 0) status = 'Missing Columns';
    else if (extra.length > 0) status = 'Extra Columns';

    var apnCount = countNonBlankInColumn_(headers, dataRows, 'APN');
    var damageCount = countNonBlankInColumn_(headers, dataRows, 'Damage');
    var missingApn = countUniqueAddressesMissingApn_(headers, dataRows);
    var apnInconsistencyRows = collectApnInconsistencies_(
      headers, dataRows, name, url, assignedZone
    );
    for (var ai = 0; ai < apnInconsistencyRows.length; ai++) apnInconsistencyRowsAll.push(apnInconsistencyRows[ai]);

    var membership = {
      missing: [],
      extra: [],
      missingCount: 'N/A',
      extraNotInMasterCount: 'N/A',
      extraWrongZoneCount: 'N/A'
    };
    if (rowMembershipSkipReason === '') {
      membership = computeRowMembership_(
        headers, dataRows, name, url, assignedZone,
        masterRoster, masterResidents
      );
      for (var mi = 0; mi < membership.missing.length; mi++) missingRowsAll.push(membership.missing[mi]);
      for (var mx = 0; mx < membership.extra.length; mx++) extraRowsAll.push(membership.extra[mx]);
    }

    overviewRows.push([
      name,
      url,
      lastEdited,
      lastEditor,
      headers.filter(function (h) { return h !== ''; }).length,
      totalDataRows,
      apnCount,
      damageCount,
      missingApn,
      zoneDisplay,
      apnInconsistencyRows.length,
      membership.missingCount,
      membership.extraNotInMasterCount,
      membership.extraWrongZoneCount,
      missing.join(', '),
      extra.join(', '),
      status
    ]);

    headers.forEach(function (header, colIdx) {
      if (header === '') return;
      var nonBlank = 0;
      dataRows.forEach(function (row) {
        var val = row[colIdx];
        if (val !== '' && val !== null && val !== undefined) nonBlank++;
      });
      detailRows.push([
        name,
        header,
        columnLetter_(colIdx),
        masterSet[header] ? 'Yes' : 'No',
        nonBlank,
        totalDataRows
      ]);
    });
  });

  Logger.log('Total resident_id entries collected: ' + residentIdEntries.length);
  var duplicateRows = findDuplicateResidentIds_(residentIdEntries);
  Logger.log('Duplicate rows found: ' + duplicateRows.length);
  if (rowMembershipSkipReason === '') {
    Logger.log('Missing rows: ' + missingRowsAll.length + ', extra rows: ' + extraRowsAll.length);
  } else {
    Logger.log(rowMembershipSkipReason);
  }
  Logger.log('Rows missing required situs address fields: ' + missingSitusRowsAll.length);
  Logger.log('Addresses with APN inconsistencies: ' + apnInconsistencyRowsAll.length);
  writeReport_(masterHeaders, overviewRows, detailRows, duplicateRows, missingRowsAll, extraRowsAll, missingSitusRowsAll, apnInconsistencyRowsAll, rowMembershipSkipReason);
}

// -------  Internal helpers  -------

/**
 * Reads the master spreadsheet's first tab and returns headers plus
 * two lookup structures used for row-membership diffing:
 *   - residents: resident_id -> { zoneName, name, address, masterRow }
 *   - roster:    zoneName    -> { resident_id: true, ... }
 *
 * Row-membership checks require resident_id and ZoneName. If either is
 * missing, the audit still runs, but Missing Rows / Extra Rows are marked
 * unavailable instead of generating misleading results.
 */
function readMasterData_() {
  var ss = SpreadsheetApp.openById(MASTER_SPREADSHEET_ID);
  var sheet = ss.getSheets()[0];
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) {
    return {
      headers: [],
      roster: {},
      residents: {},
      rowMembershipSkipReason: 'Row membership audit skipped: master spreadsheet is empty.'
    };
  }

  var rawHeaders = data[0].map(function (h) { return String(h).trim(); });
  var headers = rawHeaders.filter(function (h) { return h !== ''; });

  var residentIdCol = rawHeaders.indexOf('resident_id');
  var zoneCol = rawHeaders.indexOf('ZoneName');
  var nameCol = rawHeaders.indexOf('Resident Name');
  var houseCol = rawHeaders.indexOf('House');
  var streetCol = rawHeaders.indexOf('Street');

  var roster = {};
  var residents = {};
  var missingRowMembershipColumns = [];
  if (residentIdCol === -1) missingRowMembershipColumns.push('resident_id');
  if (zoneCol === -1) missingRowMembershipColumns.push('ZoneName');
  var rowMembershipSkipReason = missingRowMembershipColumns.length > 0
    ? 'Row membership audit skipped: master spreadsheet is missing required column(s): ' + missingRowMembershipColumns.join(', ') + '.'
    : '';

  if (residentIdCol === -1) {
    return {
      headers: headers,
      roster: roster,
      residents: residents,
      rowMembershipSkipReason: rowMembershipSkipReason
    };
  }

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var residentId = String(row[residentIdCol] || '').trim();
    if (residentId === '' || residentId === 'undefined' || residentId === 'null') continue;

    var zoneName = (zoneCol !== -1) ? String(row[zoneCol] || '').trim() : '';
    var name = (nameCol !== -1) ? String(row[nameCol] || '').trim() : '';
    var house = (houseCol !== -1) ? String(row[houseCol] || '').trim() : '';
    var street = (streetCol !== -1) ? String(row[streetCol] || '').trim() : '';
    var address = (house + ' ' + street).trim();

    residents[residentId] = {
      zoneName: zoneName,
      name: name,
      address: address,
      masterRow: i + 1
    };

    if (zoneName !== '') {
      if (!roster[zoneName]) roster[zoneName] = {};
      roster[zoneName][residentId] = true;
    }
  }

  return {
    headers: headers,
    roster: roster,
    residents: residents,
    rowMembershipSkipReason: rowMembershipSkipReason
  };
}

/**
 * Infers a user sheet's assigned zone by reading its ZoneName column
 * and returning the most common non-blank value. Since each captain
 * sheet is expected to contain residents from a single zone, this
 * is normally just "the zone" — but using the mode makes the function
 * robust to mid-boundary-change drift (a few stale rows from a prior
 * zone assignment won't flip the detection).
 *
 * Returns '' if there is no ZoneName column or no non-blank values.
 */
function detectSheetZone_(headers, dataRows) {
  var zoneCol = headers.indexOf('ZoneName');
  if (zoneCol === -1) return '';

  var counts = {};
  for (var i = 0; i < dataRows.length; i++) {
    var val = String(dataRows[i][zoneCol] || '').trim();
    if (val === '') continue;
    counts[val] = (counts[val] || 0) + 1;
  }

  var topZone = '';
  var topCount = 0;
  Object.keys(counts).forEach(function (z) {
    if (counts[z] > topCount) {
      topZone = z;
      topCount = counts[z];
    }
  });

  return topZone;
}

/**
 * Diffs a single user sheet's resident_id set against the master
 * roster for that sheet's assigned zone.
 *
 * Missing rows: resident_ids master assigns to this zone that are
 * absent from the sheet.
 * Extra rows:   resident_ids in the sheet that aren't part of
 * master's roster for this zone, sub-classified as:
 *   - "Not in master" — resident_id doesn't exist in master at all
 *   - "Wrong zone"    — resident_id exists in master but master
 *                       assigns it to a different zone (or none)
 *
 * Unmapped sheets (no assigned zone) and sheets with no resident_id
 * column return empty results — there's no meaningful diff to compute.
 */
function computeRowMembership_(headers, dataRows, sheetName, sheetUrl, assignedZone, masterRoster, masterResidents) {
  var result = {
    missing: [],
    extra: [],
    missingCount: 0,
    extraNotInMasterCount: 0,
    extraWrongZoneCount: 0
  };

  if (assignedZone === '') return result;

  var residentIdCol = headers.indexOf('resident_id');
  if (residentIdCol === -1) return result;

  var nameCol = headers.indexOf('Resident Name');
  var houseCol = headers.indexOf('House');
  var streetCol = headers.indexOf('Street');

  var userIds = {};
  for (var r = 0; r < dataRows.length; r++) {
    var row = dataRows[r];
    var id = String(row[residentIdCol] || '').trim();
    if (id === '' || id === 'undefined' || id === 'null') continue;
    var uName = (nameCol !== -1) ? String(row[nameCol] || '').trim() : '';
    var uHouse = (houseCol !== -1) ? String(row[houseCol] || '').trim() : '';
    var uStreet = (streetCol !== -1) ? String(row[streetCol] || '').trim() : '';
    userIds[id] = {
      row: r + 2,
      name: uName,
      address: (uHouse + ' ' + uStreet).trim()
    };
  }

  var expectedIds = masterRoster[assignedZone] || {};

  for (var expId in expectedIds) {
    if (!userIds[expId]) {
      var m = masterResidents[expId] || {};
      result.missing.push([
        sheetName,
        sheetUrl,
        assignedZone,
        expId,
        m.name || '',
        m.address || '',
        m.masterRow || ''
      ]);
      result.missingCount++;
    }
  }

  for (var userId in userIds) {
    if (!expectedIds[userId]) {
      var u = userIds[userId];
      var masterInfo = masterResidents[userId];
      if (!masterInfo) {
        result.extra.push([
          sheetName, sheetUrl, assignedZone, userId,
          u.name, u.address, 'Not in master', ''
        ]);
        result.extraNotInMasterCount++;
      } else {
        var otherZone = masterInfo.zoneName || '(unassigned)';
        result.extra.push([
          sheetName, sheetUrl, assignedZone, userId,
          u.name, u.address, 'Wrong zone', otherZone
        ]);
        result.extraWrongZoneCount++;
      }
    }
  }

  return result;
}

function collectSpreadsheets_(folder) {
  var files = [];
  var iter = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (iter.hasNext()) {
    files.push(iter.next());
  }
  files.sort(function (a, b) {
    return a.getName().localeCompare(b.getName());
  });
  return files;
}

function getLastEditor_(fileId) {
  try {
    var meta = Drive.Files.get(fileId, { fields: 'lastModifyingUser' });
    var user = meta.lastModifyingUser;
    if (user) return user.displayName || user.emailAddress || 'Unknown';
  } catch (e) {
    // Falls through to return below
  }
  return 'Unknown';
}

function countUniqueAddressesMissingApn_(headers, dataRows) {
  var addrCol = headers.indexOf('Address');
  var apnCol = headers.indexOf('APN');
  if (addrCol === -1) return 'N/A';
  if (apnCol === -1) return 'N/A';
  var seen = {};
  var count = 0;
  dataRows.forEach(function (row) {
    var addr = String(row[addrCol]).trim();
    var apn = row[apnCol];
    var apnBlank = (apn === '' || apn === null || apn === undefined);
    if (addr !== '' && apnBlank && !seen[addr]) {
      seen[addr] = true;
      count++;
    }
  });
  return count;
}

function countTrueInColumn_(headers, dataRows, columnName) {
  var colIdx = headers.indexOf(columnName);
  if (colIdx === -1) return 'N/A';
  var count = 0;
  dataRows.forEach(function (row) {
    if (row[colIdx] === true) count++;
  });
  return count;
}

function countNonBlankInColumn_(headers, dataRows, columnName) {
  var colIdx = headers.indexOf(columnName);
  if (colIdx === -1) return 'N/A';
  var count = 0;
  dataRows.forEach(function (row) {
    var val = row[colIdx];
    if (val !== '' && val !== null && val !== undefined) count++;
  });
  return count;
}

function collectRowsMissingSitusAddress_(headers, dataRows, sheetName, url, assignedZone) {
  var houseCol = headers.indexOf('_SitusHouseNo');
  var streetCol = headers.indexOf('_SitusStreet');
  var residentIdCol = headers.indexOf('resident_id');
  var nameCol = headers.indexOf('Resident Name');
  var legacyHouseCol = headers.indexOf('House');
  var legacyStreetCol = headers.indexOf('Street');
  var rows = [];

  dataRows.forEach(function (row, i) {
    var situsHouse = (houseCol !== -1) ? row[houseCol] : '';
    var situsStreet = (streetCol !== -1) ? row[streetCol] : '';
    var missingFields = [];

    if (isBlankCell_(situsHouse)) missingFields.push('_SitusHouseNo');
    if (isBlankCell_(situsStreet)) missingFields.push('_SitusStreet');
    if (missingFields.length === 0) return;

    rows.push([
      sheetName,
      url,
      assignedZone || '',
      i + 2,
      (residentIdCol !== -1) ? String(row[residentIdCol] || '').trim() : '',
      (nameCol !== -1) ? String(row[nameCol] || '').trim() : '',
      (legacyHouseCol !== -1) ? String(row[legacyHouseCol] || '').trim() : '',
      (legacyStreetCol !== -1) ? String(row[legacyStreetCol] || '').trim() : '',
      (houseCol !== -1) ? String(situsHouse || '').trim() : '(column missing)',
      (streetCol !== -1) ? String(situsStreet || '').trim() : '(column missing)',
      missingFields.join(', ')
    ]);
  });

  return rows;
}

function collectApnInconsistencies_(headers, dataRows, sheetName, url, assignedZone) {
  var apnCol = headers.indexOf('APN');
  if (apnCol === -1) return [];

  var groups = {};
  dataRows.forEach(function (row, i) {
    var addressInfo = addressKeyForRow_(headers, row);
    if (addressInfo.key === '') return;

    if (!groups[addressInfo.key]) {
      groups[addressInfo.key] = {
        displayAddress: addressInfo.displayAddress,
        source: addressInfo.source,
        totalRows: 0,
        rowsWithApn: [],
        rowsMissingApn: [],
        apnValues: {}
      };
    }

    var group = groups[addressInfo.key];
    var sheetRow = i + 2;
    var apn = row[apnCol];
    group.totalRows++;
    if (isBlankCell_(apn)) {
      group.rowsMissingApn.push(sheetRow);
    } else {
      var apnDisplay = String(apn).trim();
      group.rowsWithApn.push(sheetRow);
      group.apnValues[apnDisplay] = true;
    }
  });

  var rows = [];
  Object.keys(groups).forEach(function (key) {
    var group = groups[key];
    var apnValues = Object.keys(group.apnValues).sort();
    var hasMixedCompleteness = group.rowsWithApn.length > 0 && group.rowsMissingApn.length > 0;
    var hasMultipleApns = apnValues.length > 1;
    if (group.totalRows < 2 || (!hasMixedCompleteness && !hasMultipleApns)) return;

    var reasons = [];
    if (hasMixedCompleteness) reasons.push('Some rows missing APN');
    if (hasMultipleApns) reasons.push('Multiple APN values at same address');

    rows.push([
      sheetName,
      url,
      assignedZone || '',
      group.displayAddress,
      group.source,
      group.totalRows,
      group.rowsWithApn.length,
      group.rowsMissingApn.length,
      apnValues.join(', '),
      group.rowsMissingApn.join(', '),
      reasons.join(' + ')
    ]);
  });

  return rows;
}

function addressKeyForRow_(headers, row) {
  var situsHouseCol = headers.indexOf('_SitusHouseNo');
  var situsDirectionCol = headers.indexOf('_SitusDirection');
  var situsStreetCol = headers.indexOf('_SitusStreet');
  var situsUnitCol = headers.indexOf('_SitusUnit');
  var legacyHouseCol = headers.indexOf('House');
  var legacyStreetCol = headers.indexOf('Street');
  var addressCol = headers.indexOf('Address');

  var situsHouse = (situsHouseCol !== -1) ? String(row[situsHouseCol] || '').trim() : '';
  var situsDirection = (situsDirectionCol !== -1) ? String(row[situsDirectionCol] || '').trim() : '';
  var situsStreet = (situsStreetCol !== -1) ? String(row[situsStreetCol] || '').trim() : '';
  var situsUnit = (situsUnitCol !== -1) ? String(row[situsUnitCol] || '').trim() : '';
  var situsAddress = [situsHouse, situsDirection, situsStreet, situsUnit].filter(function (part) {
    return part !== '';
  }).join(' ');
  if (situsHouse !== '' && situsStreet !== '') {
    return buildAddressKey_(situsAddress, '_SitusHouseNo + _SitusDirection + _SitusStreet + _SitusUnit');
  }

  var legacyHouse = (legacyHouseCol !== -1) ? String(row[legacyHouseCol] || '').trim() : '';
  var legacyStreet = (legacyStreetCol !== -1) ? String(row[legacyStreetCol] || '').trim() : '';
  var legacyAddress = (legacyHouse + ' ' + legacyStreet).trim();
  if (legacyAddress !== '') {
    return buildAddressKey_(legacyAddress, 'House + Street');
  }

  var address = (addressCol !== -1) ? String(row[addressCol] || '').trim() : '';
  return buildAddressKey_(address, 'Address');
}

function buildAddressKey_(address, source) {
  var normalized = address.replace(/\s+/g, ' ').trim();
  return {
    key: normalized.toLowerCase(),
    displayAddress: normalized,
    source: normalized === '' ? '' : source
  };
}

function isBlankCell_(value) {
  return value === '' || value === null || value === undefined || String(value).trim() === '';
}

function collectResidentIds_(headers, dataRows, sheetName, url, entries) {
  var col = headers.indexOf('resident_id');
  if (col === -1) {
    Logger.log(sheetName + ': resident_id column NOT found. Headers: ' + headers.join(' | '));
    return;
  }
  Logger.log(sheetName + ': resident_id found at column ' + col);
  dataRows.forEach(function (row, i) {
    var val = row[col];
    if (val !== '' && val !== null && val !== undefined) {
      entries.push({
        id: String(val).trim(),
        sheet: sheetName,
        url: url,
        row: i + 2
      });
    }
  });
}

/**
 * Groups entries by resident_ID and returns rows only for IDs that
 * appear more than once (within the same sheet or across sheets).
 */
function findDuplicateResidentIds_(entries) {
  var map = {};
  entries.forEach(function (e) {
    if (!map[e.id]) map[e.id] = [];
    map[e.id].push(e);
  });
  var rows = [];
  Object.keys(map).forEach(function (id) {
    var group = map[id];
    if (group.length < 2) return;
    group.forEach(function (e) {
      var sheetNames = group.map(function (g) { return g.sheet; });
      var unique = sheetNames.filter(function (n, i) { return sheetNames.indexOf(n) === i; });
      var scope = (unique.length === 1) ? 'Within Sheet' : 'Across Sheets';
      rows.push([e.id, e.sheet, e.url, e.row, group.length, scope]);
    });
  });
  return rows;
}

function columnLetter_(index) {
  var letter = '';
  var temp = index;
  while (true) {
    letter = String.fromCharCode(65 + (temp % 26)) + letter;
    temp = Math.floor(temp / 26) - 1;
    if (temp < 0) break;
  }
  return letter;
}

/**
 * Spreadsheet title for new audit reports: date + time in the script timezone.
 */
function auditReportTitle_() {
  var tz = Session.getScriptTimeZone();
  if (!tz) tz = 'UTC';
  var stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH-mm-ss');
  return 'Sheet Scan — Audit Report — ' + stamp;
}

function writeReport_(masterHeaders, overviewRows, detailRows, duplicateRows, missingRowsAll, extraRowsAll, missingSitusRowsAll, apnInconsistencyRowsAll, rowMembershipSkipReason) {
  var report = SpreadsheetApp.create(auditReportTitle_());

  // --- Tab 1: Overview ---
  var overviewSheet = report.getSheets()[0].setName('Overview');
  var ovHeader = [
    'Spreadsheet', 'URL', 'Last Edited', 'Last Editor',
    'Total Columns', 'Data Rows',
    'APN Values', 'Damage Values',
    'Addresses Missing APN',
    'Zone',
    'APN Inconsistent Addresses',
    'Missing Rows', 'Extra (Not in Master)', 'Extra (Wrong Zone)',
    'Missing vs Master', 'Extra vs Master', 'Status'
  ];
  var ovData = [ovHeader].concat(overviewRows);
  overviewSheet
    .getRange(1, 1, ovData.length, ovHeader.length)
    .setValues(ovData);
  formatHeaderRow_(overviewSheet, ovHeader.length);
  applyOverviewHeaderNotes_(overviewSheet, ovHeader);
  autoResize_(overviewSheet, ovHeader.length);

  var lastDataRow = ovData.length;
  if (lastDataRow > 1) {
    applyConditionalFormatting_(overviewSheet, lastDataRow);
  }

  // --- Tab 2: Column Detail ---
  var detailSheet = report.insertSheet('Column Detail');
  var dtHeader = [
    'Spreadsheet', 'Column Name', 'Position', 'In Master',
    'Non-Blank Count', 'Total Data Rows'
  ];
  var dtData = [dtHeader].concat(detailRows);
  detailSheet
    .getRange(1, 1, dtData.length, dtHeader.length)
    .setValues(dtData);
  formatHeaderRow_(detailSheet, dtHeader.length);
  autoResize_(detailSheet, dtHeader.length);

  // --- Tab 3: Master Columns ---
  var masterSheet = report.insertSheet('Master Columns');
  var mcHeader = ['Position', 'Column Name'];
  var mcData = [mcHeader];
  masterHeaders.forEach(function (h, i) {
    mcData.push([columnLetter_(i), h]);
  });
  masterSheet
    .getRange(1, 1, mcData.length, mcHeader.length)
    .setValues(mcData);
  formatHeaderRow_(masterSheet, mcHeader.length);
  autoResize_(masterSheet, mcHeader.length);

  // --- Tab 4: Duplicate Resident IDs ---
  var dupSheet = report.insertSheet('Duplicate Resident IDs');
  var dupHeader = [
    'resident_ID', 'Spreadsheet', 'URL', 'Row #',
    'Total Occurrences', 'Scope'
  ];
  if (duplicateRows.length > 0) {
    var dupData = [dupHeader].concat(duplicateRows);
    dupSheet
      .getRange(1, 1, dupData.length, dupHeader.length)
      .setValues(dupData);
  } else {
    dupSheet
      .getRange(1, 1, 1, dupHeader.length)
      .setValues([dupHeader]);
    dupSheet.getRange(2, 1).setValue('No duplicate resident IDs found.');
  }
  formatHeaderRow_(dupSheet, dupHeader.length);
  autoResize_(dupSheet, dupHeader.length);

  // --- Tab 5: Missing Rows ---
  var missingSheet = report.insertSheet('Missing Rows');
  var miHeader = [
    'Spreadsheet', 'URL', 'ZoneName', 'resident_id',
    'Resident Name', 'Address', 'Master Row #'
  ];
  if (missingRowsAll.length > 0) {
    var miData = [miHeader].concat(missingRowsAll);
    missingSheet
      .getRange(1, 1, miData.length, miHeader.length)
      .setValues(miData);
  } else if (rowMembershipSkipReason) {
    missingSheet
      .getRange(1, 1, 1, miHeader.length)
      .setValues([miHeader]);
    missingSheet.getRange(2, 1).setValue(rowMembershipSkipReason);
  } else {
    missingSheet
      .getRange(1, 1, 1, miHeader.length)
      .setValues([miHeader]);
    missingSheet.getRange(2, 1).setValue('No missing rows found.');
  }
  formatHeaderRow_(missingSheet, miHeader.length);
  autoResize_(missingSheet, miHeader.length);

  // --- Tab 6: Extra Rows ---
  var extraSheet = report.insertSheet('Extra Rows');
  var exHeader = [
    'Spreadsheet', 'URL', 'Sheet Zone', 'resident_id',
    'Resident Name', 'Address', 'Reason', "Master's ZoneName"
  ];
  if (extraRowsAll.length > 0) {
    var exData = [exHeader].concat(extraRowsAll);
    extraSheet
      .getRange(1, 1, exData.length, exHeader.length)
      .setValues(exData);
  } else if (rowMembershipSkipReason) {
    extraSheet
      .getRange(1, 1, 1, exHeader.length)
      .setValues([exHeader]);
    extraSheet.getRange(2, 1).setValue(rowMembershipSkipReason);
  } else {
    extraSheet
      .getRange(1, 1, 1, exHeader.length)
      .setValues([exHeader]);
    extraSheet.getRange(2, 1).setValue('No extra rows found.');
  }
  formatHeaderRow_(extraSheet, exHeader.length);
  autoResize_(extraSheet, exHeader.length);

  // --- Tab 7: Missing Situs Address ---
  var situsSheet = report.insertSheet('Missing Situs Address');
  var situsHeader = [
    'Spreadsheet', 'URL', 'ZoneName', 'Row #', 'resident_id',
    'Resident Name', 'House', 'Street', '_SitusHouseNo', '_SitusStreet',
    'Missing Field(s)'
  ];
  if (missingSitusRowsAll.length > 0) {
    var situsData = [situsHeader].concat(missingSitusRowsAll);
    situsSheet
      .getRange(1, 1, situsData.length, situsHeader.length)
      .setValues(situsData);
  } else {
    situsSheet
      .getRange(1, 1, 1, situsHeader.length)
      .setValues([situsHeader]);
    situsSheet.getRange(2, 1).setValue('No rows missing _SitusHouseNo or _SitusStreet found.');
  }
  formatHeaderRow_(situsSheet, situsHeader.length);
  autoResize_(situsSheet, situsHeader.length);

  // --- Tab 8: APN Inconsistencies ---
  var apnSheet = report.insertSheet('APN Inconsistencies');
  var apnHeader = [
    'Spreadsheet', 'URL', 'ZoneName', 'Address', 'Address Source',
    'Rows at Address', 'Rows with APN', 'Rows Missing APN',
    'APN Value(s) Found', 'Missing APN Row #(s)', 'Reason'
  ];
  if (apnInconsistencyRowsAll.length > 0) {
    var apnData = [apnHeader].concat(apnInconsistencyRowsAll);
    apnSheet
      .getRange(1, 1, apnData.length, apnHeader.length)
      .setValues(apnData);
  } else {
    apnSheet
      .getRange(1, 1, 1, apnHeader.length)
      .setValues([apnHeader]);
    apnSheet.getRange(2, 1).setValue('No APN inconsistencies found.');
  }
  formatHeaderRow_(apnSheet, apnHeader.length);
  autoResize_(apnSheet, apnHeader.length);

  [overviewSheet, detailSheet, masterSheet, dupSheet, missingSheet, extraSheet, situsSheet, apnSheet].forEach(function (s) {
    s.setFrozenRows(1);
  });

  Logger.log('Audit report created: ' + report.getUrl());
}

function formatHeaderRow_(sheet, numCols) {
  var range = sheet.getRange(1, 1, 1, numCols);
  range.setFontWeight('bold');
  range.setBackground('#4a86c8');
  range.setFontColor('#ffffff');
}

function applyOverviewHeaderNotes_(sheet, headers) {
  var notesByHeader = {
    'Missing Rows': 'Rows expected in this spreadsheet because their master ZoneName matches this sheet, but their resident_id is absent from this sheet. Shows N/A if the master is missing resident_id or ZoneName.',
    'Extra (Not in Master)': 'Rows in this spreadsheet whose resident_id does not exist anywhere in the master spreadsheet. Shows N/A if the master is missing resident_id or ZoneName.',
    'Extra (Wrong Zone)': 'Rows in this spreadsheet whose resident_id exists in master, but the master ZoneName belongs to a different sheet zone. Shows N/A if the master is missing resident_id or ZoneName.',
    'Missing vs Master': 'Master column headers that are missing from this spreadsheet.',
    'Extra vs Master': 'Column headers present in this spreadsheet that are not present in the master spreadsheet.'
  };
  var notes = [headers.map(function (header) {
    return notesByHeader[header] || '';
  })];
  sheet.getRange(1, 1, 1, headers.length).setNotes(notes);
}

function applyConditionalFormatting_(sheet, lastRow) {
  var rules = [];

  // APN Values (G) and Damage Values (H): light red when < 20.
  var apnRange = sheet.getRange('G2:G' + lastRow);
  var dmgRange = sheet.getRange('H2:H' + lastRow);

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberLessThan(20)
      .setBackground('#f4cccc')
      .setRanges([apnRange, dmgRange])
      .build()
  );

  // Data Rows (F): white-to-green gradient.
  var dataRowsRange = sheet.getRange('F2:F' + lastRow);
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpoint('#ffffff')
      .setGradientMaxpoint('#57bb8a')
      .setRanges([dataRowsRange])
      .build()
  );

  // APN inconsistencies (K) and row-membership drift (L-N):
  // light red whenever any issue is present.
  var apnInconsistencyRange = sheet.getRange('K2:K' + lastRow);
  var missingRowsRange = sheet.getRange('L2:L' + lastRow);
  var extraNotInMasterRange = sheet.getRange('M2:M' + lastRow);
  var extraWrongZoneRange = sheet.getRange('N2:N' + lastRow);
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0)
      .setBackground('#f4cccc')
      .setRanges([apnInconsistencyRange, missingRowsRange, extraNotInMasterRange, extraWrongZoneRange])
      .build()
  );

  sheet.setConditionalFormatRules(rules);
}

function autoResize_(sheet, numCols) {
  for (var i = 1; i <= numCols; i++) {
    sheet.autoResizeColumn(i);
  }
}

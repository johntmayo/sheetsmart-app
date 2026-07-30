/**
 * Zone Export Tool (Google Apps Script)
 *
 * Standalone from the Chrome extension.
 * Exports one spreadsheet per selected zone and preserves dropdown/checkbox validations.
 */

const CONFIG = {
  // Leave blank to use the spreadsheet where this script is bound.
  SOURCE_SPREADSHEET_ID: '',
  ZONE_HEADER_NAME: 'ZoneName',
  NC_NAME_HEADER_NAME: 'NC Name',
  REQUIRED_HEADERS: ['ZoneName', 'NC Name', 'NC Phone', 'NC Email'],
  TEMPLATE_VALIDATION_ROW: 2
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Zone Export')
    .addItem('Open Export Tool', 'showZoneExportSidebar')
    .addToUi();
}

function showZoneExportSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Zone Export Tool');
  SpreadsheetApp.getUi().showSidebar(html);
}

function getSidebarContext() {
  const spreadsheet = getSourceSpreadsheet_();
  const sheets = spreadsheet.getSheets();
  const sheetNames = sheets.map((sheet) => sheet.getName());
  const activeName = spreadsheet.getActiveSheet() ? spreadsheet.getActiveSheet().getName() : '';
  return {
    sheetNames,
    activeSheetName: activeName && sheetNames.includes(activeName) ? activeName : (sheetNames[0] || '')
  };
}

function getZoneOptions(sheetName) {
  const sourceSheet = getSourceSheet_(sheetName);
  const { dataRows, zoneColIndex } = readSourceData_(sourceSheet);
  const seen = new Set();
  for (const row of dataRows) {
    const zone = normalizeCell_(row[zoneColIndex]);
    if (zone) seen.add(zone);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/**
 * Exports one spreadsheet per zone.
 * @param {{sheetName: string, zones: string[]}} input
 */
function exportZones(input) {
  const sheetName = input && input.sheetName ? normalizeCell_(input.sheetName) : '';
  const zones = input && Array.isArray(input.zones) ? input.zones : [];
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new Error('Select at least one zone.');
  }
  if (!sheetName) {
    throw new Error('Select a source sheet.');
  }

  const sourceSheet = getSourceSheet_(sheetName);
  const sourceSpreadsheet = sourceSheet.getParent();
  const { headerRow, dataRows, zoneColIndex, ncNameColIndex, lastCol } = readSourceData_(sourceSheet);
  const normalizedRequested = zones.map(normalizeCell_).filter(Boolean);

  if (normalizedRequested.length === 0) {
    throw new Error('No valid zone values were provided.');
  }

  const results = [];
  for (const zone of normalizedRequested) {
    const filteredRows = dataRows.filter((row) => normalizeCell_(row[zoneColIndex]) === zone);
    if (filteredRows.length === 0) {
      results.push({
        zone,
        ok: false,
        message: 'No rows found for this zone.'
      });
      continue;
    }

    const destinationName = buildExportFileName_(zone, filteredRows, ncNameColIndex);
    const destinationSpreadsheet = SpreadsheetApp.create(destinationName);
    const copiedSheet = sourceSheet.copyTo(destinationSpreadsheet);
    removeOtherSheets_(destinationSpreadsheet, copiedSheet.getSheetId());
    copiedSheet.setName('Sheet1');

    // Keep formatting/validation; clear old row values only.
    const maxRows = copiedSheet.getMaxRows();
    if (maxRows > 1) {
      copiedSheet.getRange(2, 1, maxRows - 1, lastCol).clearContent();
    }

    copiedSheet.getRange(1, 1, 1, lastCol).setValues([headerRow]);
    copiedSheet.getRange(2, 1, filteredRows.length, lastCol).setValues(filteredRows);
    propagateTemplateValidations_(sourceSheet, copiedSheet, lastCol, filteredRows.length);
    trimExtraRows_(copiedSheet, filteredRows.length + 1);

    results.push({
      zone,
      ok: true,
      rowCount: filteredRows.length,
      spreadsheetId: destinationSpreadsheet.getId(),
      spreadsheetUrl: destinationSpreadsheet.getUrl()
    });
  }

  return {
    sourceSpreadsheetId: sourceSpreadsheet.getId(),
    sourceSheetName: sourceSheet.getName(),
    requestedZones: normalizedRequested,
    results
  };
}

function getSourceSpreadsheet_() {
  const spreadsheet = CONFIG.SOURCE_SPREADSHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SOURCE_SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();

  if (!spreadsheet) {
    throw new Error('Source spreadsheet was not found.');
  }
  return spreadsheet;
}

function getSourceSheet_(sheetName) {
  const spreadsheet = getSourceSpreadsheet_();
  const normalizedName = normalizeCell_(sheetName);
  const sheet = spreadsheet.getSheetByName(normalizedName);
  if (!sheet) {
    throw new Error(`Source sheet not found: ${normalizedName}`);
  }
  return sheet;
}

function readSourceData_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) {
    throw new Error('Source sheet is empty.');
  }

  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headerRow = values[0];
  assertRequiredHeaders_(headerRow);
  const zoneColIndex = findHeaderIndex_(headerRow, CONFIG.ZONE_HEADER_NAME);
  const ncNameColIndex = findHeaderIndex_(headerRow, CONFIG.NC_NAME_HEADER_NAME);
  if (zoneColIndex < 0) {
    throw new Error(`Zone header not found: ${CONFIG.ZONE_HEADER_NAME}`);
  }
  if (ncNameColIndex < 0) {
    throw new Error(`NC Name header not found: ${CONFIG.NC_NAME_HEADER_NAME}`);
  }

  const dataRows = values.slice(1);
  return { headerRow, dataRows, zoneColIndex, ncNameColIndex, lastCol };
}

function assertRequiredHeaders_(headerRow) {
  const missing = [];
  for (const name of CONFIG.REQUIRED_HEADERS || []) {
    if (findHeaderIndex_(headerRow, name) < 0) missing.push(name);
  }
  if (missing.length) {
    throw new Error(`Selected sheet is missing required header(s): ${missing.join(', ')}`);
  }
}

function findHeaderIndex_(headerRow, expectedName) {
  const target = normalizeCell_(expectedName).toLowerCase();
  for (let i = 0; i < headerRow.length; i++) {
    if (normalizeCell_(headerRow[i]).toLowerCase() === target) return i;
  }
  return -1;
}

function propagateTemplateValidations_(sourceSheet, destinationSheet, lastCol, outputRowCount) {
  const templateRow = Math.max(2, Number(CONFIG.TEMPLATE_VALIDATION_ROW) || 2);
  const sourceRules = sourceSheet.getRange(templateRow, 1, 1, lastCol).getDataValidations()[0];
  const rowCount = Math.max(1, outputRowCount);

  for (let col = 0; col < sourceRules.length; col++) {
    const rule = sourceRules[col];
    if (!rule) continue;
    destinationSheet.getRange(2, col + 1, rowCount, 1).setDataValidation(rule);
  }
}

function trimExtraRows_(sheet, keepRows) {
  const safeKeepRows = Math.max(2, keepRows);
  const maxRows = sheet.getMaxRows();
  if (maxRows > safeKeepRows) {
    sheet.deleteRows(safeKeepRows + 1, maxRows - safeKeepRows);
  }
}

function removeOtherSheets_(spreadsheet, keepSheetId) {
  const sheets = spreadsheet.getSheets();
  for (const sheet of sheets) {
    if (sheet.getSheetId() !== keepSheetId) {
      spreadsheet.deleteSheet(sheet);
    }
  }
}

function normalizeCell_(value) {
  return (value || '').toString().trim();
}

function safeSheetName_(name) {
  const cleaned = (name || 'Sheet1').replace(/[\\/\?\*\[\]:]/g, ' ').trim();
  return cleaned.slice(0, 99) || 'Sheet1';
}

function buildExportFileName_(zone, rows, ncNameColIndex) {
  const ncNames = collectNcNames_(rows, ncNameColIndex);
  const suffix = ncNames.length ? ncNames.join(', ') : 'No NC Name';
  return safeFileName_(`${zone} - ${suffix}`);
}

function collectNcNames_(rows, ncNameColIndex) {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    const raw = normalizeCell_(row[ncNameColIndex]);
    if (!raw) continue;
    const parts = raw.split(';').map((p) => normalizeCell_(p)).filter(Boolean);
    const normalizedParts = parts.length ? parts : [raw];
    for (const part of normalizedParts) {
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(part);
    }
  }
  return output;
}

function safeFileName_(name) {
  const cleaned = (name || 'Zone Export').replace(/[\\/\?\*\[\]:]/g, ' ').trim();
  // Keep names manageable for Drive UX.
  return cleaned.slice(0, 180) || 'Zone Export';
}

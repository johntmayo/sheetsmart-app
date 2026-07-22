/**
 * Google Apps Script — Backfill resident_id
 *
 * Paste this entire file into Extensions → Apps Script in any Google Sheet
 * that has a "resident_id" header column.
 *
 * Then run  backfillResidentIds()  from the Apps Script editor (or the
 * "Backfill resident_id" menu that appears after a page reload).
 *
 * What it does
 * ────────────
 *  1. Finds the "resident_id" column (case-insensitive).
 *  2. Collects every existing value in that column into a Set so we can
 *     guarantee no duplicates.
 *  3. For every row where resident_id is blank, generates a v4 UUID,
 *     verifies it is not already in the Set, and writes it.
 *  4. Writes all new IDs in a single setValues() call (fast, atomic).
 *  5. Logs a summary to the Apps Script execution log.
 *
 * UUID uniqueness
 * ───────────────
 * UUIDv4 has 122 random bits → ~5.3 × 10³⁶ possible values.  A collision
 * among even a million rows is astronomically unlikely, but the script
 * also checks every generated value against the full set of existing +
 * newly-generated IDs before accepting it.
 */

// --------------- entry point ------------------------------------------------

function backfillResidentIds() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var data  = sheet.getDataRange().getValues();

  if (data.length < 2) {
    SpreadsheetApp.getUi().alert('Sheet has no data rows.');
    return;
  }

  var headers = data[0];
  var colIndex = -1;
  for (var c = 0; c < headers.length; c++) {
    if (String(headers[c]).trim().toLowerCase() === 'resident_id') {
      colIndex = c;
      break;
    }
  }

  if (colIndex === -1) {
    SpreadsheetApp.getUi().alert(
      'No "resident_id" column found in the header row.\n\n' +
      'Add a column with that exact header first, then re-run.'
    );
    return;
  }

  // Build a Set of every existing resident_id (trimmed, non-empty).
  var existing = {};
  for (var r = 1; r < data.length; r++) {
    var val = String(data[r][colIndex] || '').trim();
    if (val !== '') {
      existing[val] = true;
    }
  }

  var blanks   = 0;
  var filled   = 0;
  var colRange = sheet.getRange(2, colIndex + 1, data.length - 1, 1);
  var colVals  = colRange.getValues(); // [[cell], [cell], …]

  for (var r = 0; r < colVals.length; r++) {
    var cell = String(colVals[r][0] || '').trim();
    if (cell !== '') continue;

    blanks++;
    var uuid = generateUniqueUUID_(existing);
    existing[uuid] = true;
    colVals[r][0]  = uuid;
    filled++;
  }

  if (filled === 0) {
    SpreadsheetApp.getUi().alert('All rows already have a resident_id. Nothing to do.');
    return;
  }

  colRange.setValues(colVals);
  SpreadsheetApp.flush();

  var msg = 'Backfill complete.\n\n' +
            '  • Rows examined:  ' + (data.length - 1) + '\n' +
            '  • Already had ID: ' + (data.length - 1 - blanks) + '\n' +
            '  • Newly assigned: ' + filled;
  Logger.log(msg);
  SpreadsheetApp.getUi().alert(msg);
}

// --------------- UUID v4 generator ------------------------------------------

/**
 * Generates a UUID v4 that does NOT exist in `existingSet`.
 * Retries up to 10 times (purely defensive; a collision is near-impossible).
 */
function generateUniqueUUID_(existingSet) {
  for (var attempt = 0; attempt < 10; attempt++) {
    var uuid = generateUUIDv4_();
    if (!existingSet[uuid]) return uuid;
    Logger.log('UUID collision detected (attempt ' + (attempt + 1) + ') — retrying.');
  }
  throw new Error(
    'Failed to generate a unique UUID after 10 attempts. ' +
    'This should never happen; check the sheet for duplicates.'
  );
}

/**
 * RFC 4122 version-4 UUID.
 * Same format used by the dashboard's generateResidentId():
 *   xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
function generateUUIDv4_() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0;
    var v = c === 'y' ? (r & 0x3 | 0x8) : r;
    return v.toString(16);
  });
}

// --------------- convenience menu -------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Resident ID')
    .addItem('Backfill resident_id', 'backfillResidentIds')
    .addToUi();
}

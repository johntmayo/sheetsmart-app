# Sheet Smart

Google Apps Script tooling for auditing and correcting ~55 Google Spreadsheets that were derived from a single master but have drifted over time. Owned and accessed via a Google service account.

## Project Structure

- `Code.gs` — standalone Apps Script (paste into script.google.com, not bound to a sheet); `runAudit()` = folder scan + six-tab report
- `MergeEngine.gs` — Phase 2 merge logic (container-bound; see Phase 2 architecture)
- `Corrections.gs` — Phase 2 custom menu / UI (container-bound)
- `PRD.md` — product requirements document (the "why" and "what")
- `phase_progress.md` — current roadmap and phase status
- `README.md` — setup instructions for end users

## How It Works

The Phase 1 audit script scans every spreadsheet in a Drive folder, reads the master spreadsheet's header row as the canonical column list, and compares each sheet against it. Output is a new Google Spreadsheet with six tabs (Overview, Column Detail, Master Columns, Duplicate Resident IDs, Missing Rows, Extra Rows).

## Key Conventions

- **Apps Script only.** No Node/Python/build tools. Everything runs inside Google's script editor.
- **Standalone script.** Not bound to any spreadsheet. Do not use `SpreadsheetApp.getUi()` or other container-bound APIs.
- **Drive Advanced Service** is enabled in the project for `Drive.Files.get()` (last editor lookup). Reference it as `Drive`, not `DriveApp`, for advanced calls.
- **Batch reads/writes.** Always use `getDataRange().getValues()` to read and `setValues()` to write. Never loop `getValue()`/`setValue()` per cell.
- **Column counting patterns:**
  - `countNonBlankInColumn_` — counts cells that are not empty/null/undefined. Used for text/number columns like APN, Damage.
  - `countTrueInColumn_` — counts cells that are strictly `=== true`. Used for checkbox columns (Address - For Sale, Address - Sold Since Fire) because unchecked checkboxes return `false`, not blank.
  - `countUniqueAddressesMissingApn_` — counts unique Address values where the APN cell is blank.
- **Config at the top.** `FOLDER_ID` and `MASTER_SPREADSHEET_ID` are constants at the top of `Code.gs`. Never hardcode sheet IDs elsewhere.
- **Zone detection.** The Phase 1 audit infers each user sheet's assigned zone by taking the mode of its `ZoneName` column (via `detectSheetZone_`). There is no separate zone roster to maintain — each user sheet's own data is the source of truth for which zone it represents.
- **Error handling.** If a sheet can't be opened, push an ERROR row to the overview and continue. Never let one bad sheet kill the whole run.

## Phase Plan

See `phase_progress.md` for full detail. Summary:
- **Phase 1 (current):** Audit — read-only visibility into column drift and data completeness
- **Phase 2 (next):** Bulk corrections — add missing columns, fill blank cells based on rules, log conflicts (non-blank cells with differing values) for manual review instead of overwriting
- **Phase 3 (future):** Ongoing monitoring — scheduled triggers, email alerts, onEdit audit logging

## Phase 2 architecture

Phase 2 uses two Apps Script files: **`MergeEngine.gs`** (lookup-and-merge core) and **`Corrections.gs`** (UI layer with a custom spreadsheet menu). Unlike Phase 1’s audit script, they are **container-bound** to a dedicated Google Spreadsheet named **“Sheet Smart Config”** (not a standalone script project).

The config spreadsheet holds:

- **Settings** — Master Spreadsheet, External Source, User Sheet, User Sheets Folder, Match Column, and rename keys (`Rename Column - From`, `Rename Column - To`).
- **Column Mapping** — Source Column → Target Column pairs for aligning columns between source and targets.
- **Pull Column Policy** — Column Name → Policy rows for Pull Data into master (`fill_blank`, `overwrite`, `conflict`, `never`).

**Three cell-fill sync operations (each automatically adds missing columns then fills blank cells):**

1. **Import → Master** — external source spreadsheet → master (by match column).
2. **Push → User Sheet** — master → a single user spreadsheet.
3. **Push → User Sheets Folder** — master → every spreadsheet in the configured folder.

**Two row-append operations (append whole new rows; never modify or remove existing rows):**

4. **Push Missing Rows → User Sheet** — for a single user sheet, appends master rows whose `ZoneName` matches the sheet's detected zone and whose `resident_id` isn't already present. Columns on new rows are populated by header-name join.
5. **Push Missing Rows → User Sheets Folder** — same as above, across every spreadsheet in the configured folder.

**Two pull row-append operations (append captain-created rows into master; never modify or remove existing rows):**

6. **Pull Missing Rows ← User Sheet** — for a single user sheet, appends rows whose `resident_id` is not already present in master. User-sheet columns missing from master are added to master first.
7. **Pull Missing Rows ← User Sheets Folder** — same as above, across every spreadsheet in the configured folder. Duplicate `resident_id` values encountered after the first source row are skipped and logged.

**Two pull-data operations (import captain-entered values into master by policy):**

8. **Pull Data ← User Sheet** — for a single user sheet, updates existing master rows by `resident_id` using Pull Column Policy, adds source-only headers to master, and appends rows absent from master.
9. **Pull Data ← User Sheets Folder** — same as above, across every spreadsheet in the configured folder. Duplicate `resident_id` values encountered after the first source row are skipped and logged.

**One schema operation (header-only):**

10. **Rename Columns → User Sheets Folder** — renames one header across every spreadsheet in the configured folder (row 1 only; data rows untouched).

**Two delete-column operations (destructive schema changes):**

11. **Delete Columns → User Sheet** — deletes configured columns from a single user spreadsheet, including all data in those columns.
12. **Delete Columns → User Sheets Folder** — same as above, across every spreadsheet in the configured folder. Dry Run logs the original column index and non-blank data cell count before live deletion.

A final menu item, **Set Up Config Tabs**, initializes the Settings and Column Mapping tabs with labels and instructions.

**Settings keys used by each operation:**
- Import → Master: `External Source`, `Master Spreadsheet`, `Match Column`
- Push → User Sheet: `Master Spreadsheet`, `User Sheet`, `Match Column`
- Push → User Sheets Folder: `Master Spreadsheet`, `User Sheets Folder`, `Match Column`
- Push Missing Rows → User Sheet: `Master Spreadsheet`, `User Sheet`, `Sensitive Columns`
- Push Missing Rows → User Sheets Folder: `Master Spreadsheet`, `User Sheets Folder`, `Sensitive Columns`
- Pull Missing Rows ← User Sheet: `Master Spreadsheet`, `User Sheet`
- Pull Missing Rows ← User Sheets Folder: `Master Spreadsheet`, `User Sheets Folder`
- Pull Data ← User Sheet: `Master Spreadsheet`, `User Sheet`, `Pull Column Policy`
- Pull Data ← User Sheets Folder: `Master Spreadsheet`, `User Sheets Folder`, `Pull Column Policy`
- Rename Columns → User Sheets Folder: `User Sheets Folder`, `Rename Column - From`, `Rename Column - To`
- Delete Columns → User Sheet: `User Sheet`, workflow `Column Mappings`
- Delete Columns → User Sheets Folder: `User Sheets Folder`, workflow `Column Mappings`

Each operation reads only its own settings; unused settings are ignored.

**Write policy (Option D):** cell-fill operations only fill blank cells; when a cell already has a value that differs from the incoming value, **do not overwrite** — record it as a conflict for manual review. Never silently overwrite non-blank disagreements. Row-append operations only append new rows at the bottom and never modify or remove existing rows. Pull Missing Rows uses `resident_id` as the identity key and appends only rows absent from master. Pull Data is the exception that can overwrite existing master cells, but only for columns explicitly marked `overwrite` in Pull Column Policy.

**Pull Data policies:** `fill_blank` writes captain values only into blank master cells; `overwrite` replaces non-blank master values with non-blank captain values; `conflict` logs differences without writing; `never` skips the column entirely. Unlisted columns default to `conflict`, and `resident_id` is always forced to `never`.

**Sensitive column flagging (Push Missing Rows):** if a master row being appended has a non-blank value in any column listed under `Sensitive Columns`, the row is still appended, but also logged to the `Flagged - Sensitive Data` tab so the admin can confirm it's okay to share that data with the receiving captain. The push is never blocked — this is informational.

**Outputs:** run summaries, metrics, and operation logs are written to **tabs on the same config spreadsheet** (`Last Import`, `Last Push - User Sheet`, `Last Push - Folder`, `Last Push - Missing Rows`, `Flagged - Sensitive Data`, `Last Pull - Missing Rows`, `Last Pull Data`, `Last Rename - Folder`, sidebar `Last Run - ...` tabs including delete-column workflows, and dry-run variants).

**UI:** `SpreadsheetApp.getUi()` and other container-bound APIs **are** used in `Corrections.gs` because the script is bound to the config spreadsheet. That restriction applies only to the **standalone** Phase 1 audit (`Code.gs`).

## When Editing Code.gs

- The overview header array, the data row arrays, and the error/empty row arrays must all have the same number of elements. When adding a column, update all three places plus the header in `writeReport_`.
- Conditional formatting column references (G, H, I, J, etc.) in `applyConditionalFormatting_` must be updated if columns are inserted before them.
- Helper functions use trailing underscore naming (`readMasterHeaders_`, `collectSpreadsheets_`, etc.) per Apps Script private function convention.

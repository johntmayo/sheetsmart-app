# Sheet Smart — Phase Progress

## Phase 1: Audit & Visibility

**Status:** Complete and running

**Goal:** Get clear visibility into the current state of all ~55 spreadsheets vs the master.

**What's built:**
- `Code.gs` — standalone Apps Script that scans every sheet in a Drive folder and produces a six-tab audit report:
  - **Overview** — one row per spreadsheet with column counts, data rows, specific field counts (APN, Damage, For Sale, Sold Since Fire), missing/extra columns vs master, last edited timestamp, last editor
  - **Column Detail** — one row per column per spreadsheet showing position, whether it exists in master, and non-blank cell count
  - **Master Columns** — the canonical column list for reference
  - **Duplicate Resident IDs** — every `resident_ID` value that appears more than once across all sheets, with the spreadsheet name, link, row number, total occurrences, and whether the duplicates are within one sheet or across sheets
  - **Missing Rows / Extra Rows** — resident roster drift vs master by zone
- Conditional formatting on the overview (light red for low counts, white-to-green gradient on data rows)
- Requires Drive Advanced Service enabled for last-editor lookup

**How to re-run:** Paste updated `Code.gs` into the Apps Script project and run `runAudit()`. Each run creates a fresh audit report.

---

## Phase 2: Guided Workflow Sync Tool

**Status:** Current focus. The backend sync operations exist; active work is moving the most important operations into a guided sidebar.

**Goal:** A multi-operation data integration tool that can import data into the master, push master data to captain/user sheets, pull captain-created rows and updates into master, add missing columns during sync, and support safe folder-wide column-header renames.

**Current product direction:** Keep the existing Apps Script merge engine and legacy menu operations, but make the primary user experience **Sheet Smart → Open Dashboard**: a guided sidebar organized around real-world workflows. The tab/menu-heavy setup is still available, but the workflow sidebar is now the preferred interface.

**Config spreadsheet layout:**
- **Settings tab:** Master Spreadsheet, External Source, Source Tab Name, User Sheet, User Sheets Folder, Match Column, rename settings, Sensitive Columns.
- **Column Mapping tab:** legacy Source Column | Target Column pairs for generic menu operations.
- **Pull Column Policy tab:** policy rules for Pull Data into master (`fill_blank`, `overwrite`, `conflict`, `never`).
- **Workflow Presets tab:** named sidebar workflows with operation type, source/destination IDs, source tab, folder ID, match column, mappings, notes, and per-column policies.

**Architecture:**
- `MergeEngine.gs` — core engine and helpers: config parsing, workflow preset parsing, lookup building, policy-aware merge, append-row helpers, logs, column additions, rename helpers.
- `Corrections.gs` — UI/server layer: legacy menu entry points, sidebar API functions, workflow validation/runners, config tab setup.
- `Sidebar.html` — guided dashboard UI for workflow presets.

**Supported dashboard workflows:**
- **Update Master From Sales Tracker** — imports the formula-generated `Sales Rollup by APN` tab into the master by `APN`. Default mapped fields: `Address - Sold Since Fire`, `Sales History`, `Latest Sale Date`, `Latest Sale Price`, `Latest New Owner`. Default policy: `overwrite` for these sales-owned fields. Dry run shows proposed overwrites before live run writes them.
- **Push Dashboard Fields to Captain Sheets** — pushes dashboard-facing fields from the master to every spreadsheet in `User Sheets Folder` by `APN`. Default mapped fields: `Address - Sold Since Fire`, `Sales History`. Default policy: `overwrite`, because master is authoritative for these dashboard fields.
- **Push Missing Residents to Captain Sheets** — wraps Push Missing Rows → User Sheets Folder. It appends only master residents matching each sheet's detected `ZoneName`, shows detected zones, rows appended, sensitive-data flags, skipped rows, and errors, and never modifies existing rows.
- **Push Missing Residents to One Captain Sheet** — wraps Push Missing Rows → User Sheet for the configured `User Sheet`, using the same detected-zone append-only behavior and sensitive-data flagging.
- **Pull Captain Data Into Master** — wraps Pull Data ← User Sheets Folder. It reads `Pull Column Policy`, shows policy effects in the sidebar, and summarizes filled cells, overwrites, conflicts, appended rows, skipped rows, and errors.
- **Pull Missing Captain Rows Into Master** — wraps Pull Missing Rows ← User Sheets Folder. It appends captain-created rows missing from master, adds source-only headers first, and summarizes appended rows, columns added, blank/duplicate `resident_id` skips, and errors.
- **Add Columns to One Captain Sheet** / **Add Columns to Captain Sheets Folder** — schema-only workflows that add configured row-1 headers when missing and log Added/Skipped/Error results without filling cells or appending rows.
- **Delete Columns from One Captain Sheet** / **Delete Columns from Captain Sheets Folder** — schema workflows that delete configured columns and all data in those columns; dry runs log original index and non-blank data cell counts before live deletion.
- **Rename Column Across Captain Sheets** — wraps Rename Columns → User Sheets Folder with explicit dry-run language before a live row-1 header change across the folder.

**Core sales operating loop now supported in the sidebar:**
1. Update Master From Sales Tracker
2. Push Dashboard Fields to Captain Sheets

This is the main sales-data publishing loop: raw sales events roll up by APN, the rollup updates master, then master updates the captain-facing sheets.

**Legacy menu actions still available:**
- **Import → Master** / **(Dry Run)** — External Source → Master; adds missing columns first, then fills blank cells; conflicts logged.
- **Push → User Sheet** / **(Dry Run)** — Master → single user spreadsheet; adds missing columns first, then fills blank cells; conflicts logged.
- **Push → User Sheets Folder** / **(Dry Run)** — Master → all sheets in folder; adds missing columns first, then fills blank cells; conflicts logged.
- **Push Missing Rows → User Sheet** / **(Dry Run)** — Master → single user spreadsheet; appends missing residents for the sheet's detected zone.
- **Push Missing Rows → User Sheets Folder** / **(Dry Run)** — Master → all sheets in folder; appends missing residents by detected zone.
- **Pull Missing Rows ← User Sheet** / **(Dry Run)** — single user spreadsheet → Master; appends rows whose `resident_id` is absent from master and adds source-only headers to master first.
- **Pull Missing Rows ← User Sheets Folder** / **(Dry Run)** — all sheets in folder → Master; same as above, skipping duplicate `resident_id` values after the first occurrence.
- **Pull Data ← User Sheet** / **(Dry Run)** — single user spreadsheet → Master; updates existing rows by `resident_id` using Pull Column Policy and appends rows absent from master.
- **Pull Data ← User Sheets Folder** / **(Dry Run)** — same as above, across every sheet in the folder.
- **Rename Columns → User Sheets Folder** / **(Dry Run)** — rename one header across all sheets in folder; skips sheets where old header is missing or new header already exists; data rows untouched.
- **Set Up Config Tabs** — formats Settings, Column Mapping, Pull Column Policy, and Workflow Presets while preserving existing values.

**Key behaviors:**
- Cell-fill operations automatically add missing target columns before filling data.
- Add Columns sidebar workflows expose header-only column additions for one captain sheet or the whole captain folder.
- New columns are appended after the last existing column, formatted as plain General (no inherited checkboxes).
- Legacy Import/Push operations remain conservative: blank cells are filled; non-blank disagreements are conflicts and are not overwritten.
- Sidebar workflows can use per-column policies (`fill_blank`, `overwrite`, `conflict`, `never`); dry runs show proposed overwrites before live runs write them.
- Date comparisons are normalized to avoid false conflicts where Sheets displays identical dates but Apps Script returns different raw value types.
- Row-append operations append only; they never modify or remove existing rows.
- Delete Columns workflows remove the entire matching column, including its header and existing data; dry runs should be reviewed before live runs.
- Pull Data never writes source blank cells into master; unlisted columns default to conflict-only, and `resident_id` is always protected.
- Sync logs include Filled, Overwritten, Conflict, Skipped, Error, and related operation-specific types.
- The sidebar must not auto-load a workflow on open. It should show workflow cards and wait for the user to explicitly choose one.

**Sales data model decision:**
- Raw sales tracker should be event-shaped: one row per sale.
- A formula-generated `Sales Rollup by APN` tab produces one row per APN for Sheet Smart import.
- The master remains one row per `resident_id`; APN can repeat because multiple residents can be associated with one property.
- `Sales History` carries historical sale details. `Latest Sale Date`, `Latest Sale Price`, and `Latest New Owner` are latest-sale snapshot fields.

**Next implementation priorities:**
1. Group sidebar workflow cards by operating loop (Sales, Captain Push, Captain Pull, Admin Tools) once the UI needs more scanability.
2. Consider requiring an explicit acknowledgement before live rename runs, since that workflow changes headers across every captain sheet.

**Open questions / later polish:**
- Should column order in targets match the master after columns are added?
- Should sidebar workflow cards be grouped by operating loop (Sales, Captain Push, Captain Pull, Admin Tools) once more workflows exist?
- Long-term: should Phase 3 monitoring be workflow-aware, so scheduled checks report which workflow needs attention?

---

## Phase 3: Ongoing Monitoring (Future)

**Ideas:**
- Scheduled trigger (daily/weekly) that re-runs the audit automatically
- Email summary when sheets drift out of sync
- `onEdit` triggers on each sheet to log changes to a central audit log (forward-looking edit history)

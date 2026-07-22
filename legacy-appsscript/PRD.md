# Sheet Smart — Product Requirements Document

## Problem

A master Google Spreadsheet is used to generate ~125 individual spreadsheets, each delivered to a different user or team. Over time, two kinds of drift have occurred:

1. **Structural drift.** The master has evolved — columns added, renamed, reordered — but the already-shipped sheets were never updated to match.
2. **Content drift.** Users have edited their individual sheets. Some edits are legitimate local data; others are accidental changes to shared fields.

There is currently no way to see which sheets are out of sync, what specifically differs, or to push corrections without manually opening each one.

## Users

- **Primary:** The administrator who maintains the master spreadsheet and needs to keep all 55 derivatives consistent. Non-developer, comfortable with Google Sheets, not comfortable editing code regularly.
- **Secondary:** End users who receive individual sheets. They should not need to interact with Sheet Smart at all.

## Goals

1. **Visibility.** See the current state of all sheets at a glance — what columns each has, what data is filled in, where they diverge from the master.
2. **Inbound integration.** When new data arrives in an external spreadsheet (e.g. sales records, construction status), merge it into the master by matching on a shared key (typically APN).
3. **Outbound propagation.** Push data from the master into all user sheets, filling in gaps without destroying user edits.
4. **Safety.** Never silently overwrite data a user has entered. Surface conflicts for human review.
5. **Simplicity.** Everything runs inside Google Sheets and Apps Script. No external services, no hosting, no build tools.

## Non-goals

- Cell-level edit history or per-user change tracking (Google doesn't expose this programmatically).
- Automatic conflict resolution. The tool flags conflicts; the human decides.
- Full schema harmonization. The tool can add missing columns and perform explicit folder-wide header renames, but does not reorder columns or perform implicit schema rewrites.

## Key concepts

| Concept | Definition |
|---|---|
| **Master spreadsheet** | The canonical source of truth for column structure and shared data. |
| **User sheets** | The ~55 derivative spreadsheets in a single Drive folder. |
| **Match column** | The column used to join rows across spreadsheets (usually APN). |
| **Column mapping** | A table that maps source column names to target column names, since headers may not be identical across sheets. |
| **Fill** | Writing a value into a blank target cell. Always safe. |
| **Conflict** | A target cell already has a value that differs from what the source would write. Logged, never overwritten. |

## Capabilities

### Phase 1: Audit

Generate a report comparing all user sheets against the master.

- For each sheet: column inventory, row count, which columns are missing or extra vs the master, data completeness per column.
- Specific field counts: APN values, Damage values, For Sale (checkbox TRUE count), Sold Since Fire (checkbox TRUE count), unique addresses missing an APN.
- Last edited timestamp and last editor per sheet.
- Conditional formatting to surface low counts and anomalies.
- Output: a new Google Spreadsheet with Overview, Column Detail, and Master Columns tabs.
- Re-runnable at any time for a fresh snapshot.

### Phase 2: Lookup-and-Merge

Integrate data across spreadsheets in two directions.

- **Sync → Master Spreadsheet:** Given a source spreadsheet, add any missing mapped columns to the master, then match rows by the match column and fill blank cells.
- **Sync → User Sheets Folder:** Using the master as the source, add any missing mapped columns to each user sheet, then fill blank cells across all sheets in the folder.
- **Rename Columns → User Sheets Folder:** Rename a specific header (`from` → `to`) across all user sheets in a folder without touching row data.
- Each sync is one operation — adding missing columns and filling data happen in the same run, in the right order.
- **Write policy:** Fill blank cells only. Never overwrite. Log conflicts.
- **Rename safety policy:** Rename only row-1 headers; skip and log if old header is missing or new header already exists.
- **Dry run mode:** Preview all additions, fills, and conflicts without writing anything.
- **Conflict log:** For each conflict, record the spreadsheet name, row, column, existing value, and intended value.
- **Interface:** A config spreadsheet with a Settings tab and Column Mapping tab. A "Set Up Config Tabs" menu action initializes both tabs with labels and instructions. Custom menu for triggering all operations.

### Phase 3: Ongoing Monitoring (future)

- Scheduled triggers to re-run the audit on a cadence.
- Email alerts when sheets drift out of sync.
- Per-sheet `onEdit` triggers that log changes to a central audit log for forward-looking edit tracking.

## Constraints

- **Google Apps Script only.** No external runtimes, APIs, or hosting.
- **6-minute execution limit** per Apps Script run. Current sheet count and sizes are well within this, but the architecture should use batch reads/writes to stay efficient.
- **Service account access.** The account owns all sheets and has full read/write access. No OAuth prompts for end users.
- **No destructive operations.** The tool should never delete data, remove columns, or reorder content without explicit future design work.

## Success criteria

- Running the audit takes under 2 minutes and produces an accurate, scannable report.
- A new dataset can be imported into the master and pushed to all 55 sheets in under 5 minutes of user effort (config setup + run).
- Zero data loss — no user-entered values are overwritten without appearing in the conflict log first.

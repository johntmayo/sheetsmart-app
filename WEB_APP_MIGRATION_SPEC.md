# Sheet Smart Web App Migration Spec

## Overview

**What Sheet Smart is:** a set of tools for keeping roughly 55 Google Spreadsheets aligned with a single canonical dataset. All of these sheets were originally derived from one master spreadsheet of residents, but over time they have drifted apart — columns get renamed, added, or dropped, rows go missing, values get entered in one place but not another.

**The problem it solves:** in this operation there is one **master** resident dataset, a folder of per-zone **captain sheets** (each volunteer captain works their own copy), and **external sources** such as a sales tracker. Keeping these in sync by hand is slow and error-prone. Sheet Smart automates the comparison and the corrections while protecting against accidental data loss.

**What it does today:**

- **Audits** every captain sheet against the master — flags column drift, missing/extra rows, duplicate `resident_id` values, and completeness gaps.
- **Moves data** between sheets — imports external sales data into the master, pushes master data out to captain sheets, and pulls captain-entered data back into the master (filling blanks, appending missing rows, and logging conflicts instead of overwriting).
- **Manages schema** — adds, renames, and deletes columns across one or many captain sheets.

**Who uses it:** a single admin who owns/shares the sheets centrally (via a Google service account). Captains only ever touch their own spreadsheets; they never interact with Sheet Smart directly.

**Core safety principle:** Sheet Smart never silently overwrites conflicting data. It fills blanks, appends new rows, and logs disagreements for manual review. Every operation supports a dry run before any live write, and destructive schema changes require explicit confirmation.

The rest of this document describes how to move Sheet Smart off its current spreadsheet-bound interface and into a dedicated web app.

## Purpose

Sheet Smart has grown from a set of Google Apps Script utilities into an operations platform for keeping a master resident dataset, captain sheets, external sales data, and correction workflows aligned. The current spreadsheet-bound interface is powerful but increasingly hard to understand, configure, and trust.

This spec outlines what would need to happen to move Sheet Smart into a straight-up web app: a dedicated interface, explicit workflows, persistent configuration, job history, and safer review/approval flows.

## Product Goal

Replace the config-spreadsheet-and-sidebar experience with a web app where an admin can:

- See the current health of the master, captain sheets, and external sources.
- Run guided workflows without editing settings cells.
- Preview changes before applying them.
- Review conflicts, overwrites, skipped rows, sensitive data flags, and errors in one place.
- Maintain workflow configuration through forms instead of spreadsheet tabs.
- Keep Google Sheets as an integration surface where needed, but stop using a spreadsheet as the application shell.

## Current System to Replace

The current toolset has three major responsibilities:

- **Audit and visibility:** scan the master and captain folder, compare schemas, detect missing/extra rows, detect duplicate `resident_id` values, and summarize completeness.
- **Data movement:** import external data into master, push master data to captain sheets, pull captain-entered data back into master, and append missing rows in both directions.
- **Schema operations:** add columns, rename columns, and delete columns across one or many captain sheets.

The current state is spread across:

- Apps Script code files: `Code.gs`, `MergeEngine.gs`, `Corrections.gs`, and `Sidebar.html`.
- Config spreadsheet tabs: `Settings`, `Column Mapping`, `Pull Column Policy`, and `Workflow Presets`.
- Output/report tabs such as `Last Pull Data`, `Dry Run - ...`, `Flagged - Sensitive Data`, audit reports, and operation logs.

## Target Experience

The web app should feel like an operations dashboard rather than a spreadsheet control panel.

### Home Dashboard

Show high-level status:

- Master spreadsheet connected or not connected.
- Captain folder connected or not connected.
- External sources connected or not connected.
- Last audit time and key findings.
- Last successful workflow runs.
- Recent failures, conflicts, and pending review items.

### Workflow Center

Expose each operation as a named workflow card:

- Update Master From Sales Tracker.
- Push Dashboard Fields to Captain Sheets.
- Push Missing Residents to Captain Sheets.
- Push Missing Residents to One Captain Sheet.
- Pull Captain Data Into Master.
- Pull Missing Captain Rows Into Master.
- Add Columns to One Captain Sheet.
- Add Columns to Captain Sheets Folder.
- Rename Column Across Captain Sheets.
- Delete Columns from One Captain Sheet.
- Delete Columns from Captain Sheets Folder.

Each workflow should have:

- Plain-English purpose.
- Required connections and settings.
- Dry run button.
- Live run button.
- Last run summary.
- Link to detailed run history.
- Warnings for destructive operations.

### Configuration Screens

Replace spreadsheet tabs with structured forms:

- Connections: master spreadsheet, captain folder, external source spreadsheets.
- Workflows: operation type, source, target, match column, source tab, notes.
- Column mappings: source column to target column, with validation against live headers.
- Column policies: `fill_blank`, `overwrite`, `conflict`, and `never`.
- Sensitive columns: list of fields that should be flagged when pushed to captain sheets.
- Rename/delete/add-column settings.

### Run Review

Dry runs and live runs should produce a durable review screen:

- Summary metrics.
- Proposed column additions.
- Proposed fills.
- Proposed overwrites.
- Conflicts.
- Appended rows.
- Skipped rows.
- Sensitive data flags.
- Errors.

The app should support filtering, sorting, and exporting these results. For live runs, the review screen becomes the permanent audit record of what happened.

## Core Architecture

### Frontend

A browser-based admin app.

Likely responsibilities:

- Workflow cards and guided run pages.
- Configuration forms.
- Run history and result tables.
- Conflict review screens.
- Warnings and confirmation flows for destructive actions.

Candidate stack:

- React/Next.js if this becomes a hosted application.
- Google Apps Script HTML service only if the goal is a lighter transition while still staying inside Google infrastructure.

### Backend API

A server layer that owns workflow execution and talks to Google APIs.

Likely responsibilities:

- Authenticate the admin.
- Store app configuration.
- Read spreadsheet metadata and headers.
- Execute audits and sync workflows.
- Write to Google Sheets via batch APIs.
- Create run records and log detail rows.
- Enforce write policies before any write happens.

Candidate options:

- Node/TypeScript service using Google Sheets API and Drive API.
- Apps Script deployed as a web app as an interim backend.
- Google Cloud Run or similar if long-running jobs and cleaner deployment become important.

### Job Runner

Some workflows touch dozens of spreadsheets and can take time. They should run as jobs rather than blocking a single browser request.

Job requirements:

- Queue a dry run or live run.
- Track status: queued, running, succeeded, failed, cancelled.
- Store progress counts by spreadsheet.
- Store structured logs as the job runs.
- Allow the UI to refresh or poll for status.
- Prevent accidental duplicate live runs.

### Database

The web app needs persistent state outside the config spreadsheet.

Data to store:

- Users/admins.
- Google connection metadata.
- Workflow definitions.
- Column mappings.
- Column policies.
- Sensitive column lists.
- Run records.
- Run result detail rows.
- Conflict review state.

Candidate options:

- Firestore for a Google-native, lightweight app database.
- Postgres for stronger relational querying and reporting.
- A transitional mode where config remains in Sheets at first, but the app reads and writes it through forms.

## Google Integration

The app still needs to work with Google Drive and Google Sheets.

Required API capabilities:

- List spreadsheets in the captain folder.
- Read spreadsheet names, IDs, first tab names, and modified timestamps.
- Read headers and data ranges in batch.
- Write cells in batch.
- Add columns and headers.
- Rename headers.
- Delete columns when explicitly approved.
- Create audit/export spreadsheets if that remains useful.

Auth model options:

- **Service account:** best if all source and target sheets are owned/shared centrally and end users do not need to authorize anything.
- **Admin OAuth:** best if the admin's Google identity should own access and Drive visibility.
- **Hybrid:** service account for operational access, admin login for app permissions.

The first version should preserve the current service-account-style operating model if possible, because end users should not need to interact with Sheet Smart.

## Workflow Behavior to Preserve

The migration should keep the existing safety model.

- Dry run before live run.
- Fill blank cells only unless policy allows overwrite.
- Never write source blank values over target values.
- Log conflicts instead of silently overwriting disagreements.
- Treat `resident_id` as protected.
- Append-row workflows only append rows; they never modify or remove existing rows.
- Pull Data can overwrite only when a column is explicitly marked `overwrite`.
- Unlisted pull columns default to conflict-only.
- Sensitive data flags are informational and do not block row append.
- Destructive schema operations require explicit confirmation and produce detailed dry-run counts first.

## Suggested Data Model

Initial entities:

- **Connection:** named reference to a Google spreadsheet, Drive folder, or external source.
- **Workflow:** named operation with type, source, destination, match column, mappings, policies, and notes.
- **ColumnMapping:** source column, target column, workflow reference.
- **ColumnPolicy:** column name, policy, workflow reference.
- **Run:** workflow, mode, status, started/finished timestamps, summary counts, actor.
- **RunLogEntry:** run, spreadsheet, row, column, resident_id, type, existing value, incoming value, message.
- **Conflict:** specialized review object derived from run logs, with status and resolution notes.
- **SensitiveDataFlag:** run, destination sheet, resident_id, resident display fields, flagged columns.

## Migration Phases

### Phase 0: Confirm Direction

Decide the big product constraints:

- Hosted web app vs Apps Script web app.
- Service account vs admin OAuth.
- Sheets remain the source of truth vs database becomes source of truth.
- Whether captain sheets remain the long-term user-facing surface.

Output: final architecture decision and first implementation plan.

### Phase 1: Web App Shell Around Existing Concepts

Build the app UI and configuration model while preserving the current spreadsheet data sources.

Scope:

- Dashboard shell.
- Connection settings.
- Workflow list.
- Workflow detail pages.
- Column mapping and policy forms.
- Read-only audit/status views.
- Import existing `Settings`, `Column Mapping`, `Pull Column Policy`, and `Workflow Presets` into the app database.

Goal: make configuration understandable without changing the backend behavior yet.

### Phase 2: Port Audit and Dry Run Execution

Move the most important read-only operations into the backend.

Scope:

- Folder scan.
- Master/captain schema comparison.
- Duplicate `resident_id` detection.
- Missing/extra row detection by `ZoneName`.
- Dry run for the core sales loop.
- Durable run history.

Goal: prove the new app can read the real data safely and produce useful results before writing anything.

### Phase 3: Port Core Live Workflows

Move the highest-value write operations into the web app.

Start with:

- Update Master From Sales Tracker.
- Push Dashboard Fields to Captain Sheets.
- Push Missing Residents to Captain Sheets.
- Pull Captain Data Into Master.

Goal: cover the daily/weekly operating loop with better review screens and permanent logs.

### Phase 4: Port Admin Schema Workflows

Move schema tools after the core data workflows are stable.

Scope:

- Add columns.
- Rename columns.
- Delete columns.
- Stronger confirmation screens.
- Dry-run previews with non-blank counts.

Goal: make risky operations harder to run accidentally and easier to review.

### Phase 5: Decommission Spreadsheet UI

Retire the spreadsheet-bound control panel once the web app is trusted.

Scope:

- Freeze `Sheet Smart Config` as legacy/read-only.
- Keep old Apps Script tools available only as emergency fallback for a defined period.
- Update README and operating docs.
- Remove duplicated workflow configuration from spreadsheets.

Goal: one primary place to configure, run, and review Sheet Smart operations.

## Implementation Risks

- Google API permissions may be more complex outside Apps Script.
- Long-running folder-wide jobs need careful batching, retries, and progress tracking.
- Existing Apps Script behavior is large and has many edge cases; porting should be incremental.
- A database introduces backup, deployment, and access-control responsibilities.
- If Sheets remain the source of truth, the app must handle concurrent human edits gracefully.
- If the database becomes the source of truth, data migration and captain-sheet publishing become bigger design problems.

## Open Questions

- Should the web app be hosted externally, or should it be an Apps Script web app first?
- Should the master spreadsheet remain the canonical database, or should the app eventually own canonical resident records?
- Are captain sheets still the right end-user interface, or should captains eventually use the web app too?
- Who needs access to the web app besides the primary admin?
- Should conflict resolution be manual notes only, or should the app support applying selected resolutions?
- Should run logs remain exportable to Google Sheets for archival/review?
- How much historical audit data should be kept?
- What is the acceptable cost and maintenance burden for hosting?

## Recommended First Cut

Build a small web app that keeps Google Sheets as the source of truth but removes spreadsheet-based configuration.

The first useful version should:

- Store workflow configuration in an app database.
- Read the current master, captain folder, and sales rollup through Google APIs.
- Run audits and dry runs.
- Show clear review screens.
- Avoid live writes until the dry-run output matches the current Apps Script output on real data.

This gives the project a real application shape without forcing a risky data migration at the same time.

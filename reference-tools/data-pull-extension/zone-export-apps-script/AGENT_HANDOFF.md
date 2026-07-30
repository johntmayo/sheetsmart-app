# Agent Handoff: Zone Export Tool (Separate from Extension)

## Non-negotiables

- Do **not** modify the existing Chrome extension.
- Build/maintain this as a separate Apps Script tool only.
- Dropdowns and checkboxes must carry to exported sheets.
- Multi-zone export is required.

## Business workflow

Current manual step after data pull:
1. sort output by `ZoneName`
2. copy one zone to new standalone spreadsheet

Target automation:
- user picks which tab to export from (output tabs are often created/deleted)
- user selects one or more zones
- tool creates one spreadsheet per zone with matching rows

## Current implementation in this folder

- `Code.gs`
  - adds menu + sidebar
  - returns available tab names + active tab for UI default
  - reads unique zones from selected source tab
  - exports selected zones into new spreadsheets
  - copies source sheet structure
  - clears data rows and writes filtered rows
  - reapplies template-row data validation rules to output rows
  - validates selected source tab has required headers:
    - `ZoneName`
    - `NC Name`
    - `NC Phone`
    - `NC Email`
- `Sidebar.html`
  - source tab dropdown (active tab preselected)
  - checkbox list of zones
  - select-all support
  - exports multiple zones in one run
- `appsscript.json`
  - required scopes for Sheets/Drive/UI

## Validation/checkbox handling strategy

Validation preservation is intentionally redundant for safety:
1. copy the source sheet into destination spreadsheet (keeps existing structure/format)
2. explicitly read template row data validations from source and set them on destination rows

This ensures dropdowns and checkbox rules survive export even when rows are rewritten.

## Suggested verification checklist

1. Run export for one zone with known dropdown + checkbox columns.
2. Confirm exported rows show dropdown arrows in expected columns.
3. Confirm checkbox columns are actual checkboxes (not TRUE/FALSE text).
4. Confirm tab picker defaults to active tab and allows changing tabs.
5. Run export for multiple zones in one action.
6. Confirm one spreadsheet is created per selected zone.
7. Confirm each output has only rows for that zone.

## Known extension of v1

- Add optional "single workbook with one tab per zone" mode.
- Add optional date filter or status filter pre-export.
- Add optional fixed column subset export.

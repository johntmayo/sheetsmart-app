# Zone Export Tool (Apps Script)

This is a separate tool from the Chrome extension. It exports one spreadsheet per selected `ZoneName` from a user-selected source tab (defaulting to the active tab).

## Why this exists

After data pull completes, the current manual step is:
- sort by `ZoneName`
- copy one zone into a separate spreadsheet

This tool automates that with:
- source-tab selection
- multi-select zone export

## Critical behavior

- Reads source rows from the selected source tab (default: active tab)
- Supports selecting **multiple zones at once**
- Creates one new spreadsheet per selected zone
- Preserves dropdowns and checkboxes by:
  - copying source sheet structure first (format + validation baseline),
  - then explicitly applying data validation rules from template row (`TEMPLATE_VALIDATION_ROW`) to exported rows.
- Enforces required headers on selected tab:
  - `ZoneName`
  - `NC Name`
  - `NC Phone`
  - `NC Email`

## Files

- `Code.gs` - main server-side logic
- `Sidebar.html` - zone picker UI
- `appsscript.json` - Apps Script manifest/scopes
- `AGENT_HANDOFF.md` - implementation brief for future agent

## Setup (manual, no clasp required)

1. Create a new Google Apps Script project.
2. Add/replace files with:
   - `Code.gs`
   - `Sidebar.html`
   - `appsscript.json`
3. Save, then run `onOpen` once to authorize.
4. Open the spreadsheet and use menu:
   - `Zone Export` -> `Open Export Tool`
5. In the sidebar:
   - choose the source tab (active tab is preselected),
   - select one or more zones,
   - click export.

## Config knobs

In `Code.gs` `CONFIG`:
- `SOURCE_SPREADSHEET_ID`:
  - empty = current bound spreadsheet
  - set explicit ID if script is standalone
- `ZONE_HEADER_NAME` default `ZoneName`
- `NC_NAME_HEADER_NAME` default `NC Name`
- `REQUIRED_HEADERS` defaults:
  - `ZoneName`, `NC Name`, `NC Phone`, `NC Email`
- `TEMPLATE_VALIDATION_ROW` default `2`

## Output file naming

The file name is generated per zone as:
- `ZoneName - NC Name, NC Name, ...`

NC names are deduplicated and parsed from semicolon-separated values when present.

# SheetSmart continuation handoff

You are taking over an active effort to finish SheetSmart, a single-operator administrative app that safely reconciles a master Google Sheet, captain-zone Google Sheets, Mapbox zone boundaries, and captain-originated changes.

## How to work with the user

- The user is the project owner, not a developer. Use plain language and explain what a result means and what they should do next.
- Move the project forward autonomously, but never apply live spreadsheet changes without the app's explicit preview/confirmation gates.
- Preserve Undo, snapshots, revalidation, privacy protections, and household-level integrity.
- Avoid jargon such as “blocked,” “fingerprint,” “canonical,” or “reconciliation” without immediately explaining it in ordinary language.
- Do not expose private note contents in logs or UI. `Person Notes`, `Address Notes`, and `Outreach Log` are sensitive.
- Use subagents for independent reviews or broad investigations when useful.

## Product decisions already made

- SheetSmart is an admin-only tool. Captains use a separate Zone Dashboard.
- Mapbox polygons are authoritative for zone boundaries.
- A household is identified by `address_id`; every resident has an immutable `resident_id`.
- All residents at one address move together between captain sheets.
- Changes are previewed, approval-gated, revalidated immediately before writing, and undoable.
- SQLite currently stores configuration, jobs, run history, conflicts, tombstones, and safety metadata. Google Sheets still hold operational data.
- Captain deletions use soft deletion plus a private operations workbook, archival evidence, tombstones, activity events, and restoration.
- Property-sales distribution is retired. Sales data now comes from a central source used directly by Zone Dashboard. Keep generic outside-source plumbing, but do not copy sales fields into master/captain data.
- `House`, `Street`, and retired sales columns should be removed through the cleanup workflow.
- `_SitusUnit` must be text.
- Boolean cleanup semantics are: blank/unchecked/text `FALSE` become boolean `FALSE`; checked/text `TRUE` become boolean `TRUE`; no checkbox formatting is required.

## What is working

- Folder-wide Mapbox boundary reconciliation, including moves and Undo.
- Creation of missing zone spreadsheets.
- Captain-added resident/address import with duplicate-situs protection and actionable blocking guidance.
- Missing-address intake planner and approval-gated execution.
- Conflict normalization by field type.
- Folder cleanup preview/apply/Undo, including obsolete columns, booleans, `_SitusUnit`, and private note protection.
- Durable SQLite-backed jobs with atomic preview consumption.
- Operations workbook ingestion, deletion application, tombstones, activity feed, and restoration protections.
- Sales-field retirement guards in captain-to-master paths.

The active branch is `feature/folder-zone-reconcile`. At handoff, the worktree was clean and the latest commits were:

- `f2b780d Explain address intake source setup`
- `cadca8a Make blocked imports actionable`
- `1282ffb Show captain import decision counts`
- `bc2224c Explain cleanup blockers with next actions`
- `ba66670 Block duplicate situs during captain import`

## Exact current user workflow

The user successfully imported 272 captain-originated rows and then wanted to process a separate list containing roughly 1,000–3,000 possibly missing addresses.

They opened **Playbooks → Add missing addresses safely**, but its source dropdown only showed `Sales Tracker`. This was not a Google picker: that dropdown lists connections registered with type `external`.

The user was just instructed to:

1. Open **Sources**.
2. Add the missing-address spreadsheet.
3. Select type **Outside list / address-intake spreadsheet**.
4. Paste the spreadsheet ID and optional tab name.
5. Share it as Editor with `sheetsmart-bot@sheetsmart-503108.iam.gserviceaccount.com`.
6. Save and Test the connection.
7. Return to the playbook and scan it.

The retired Sales Tracker connection can be removed from Sources without deleting the Google spreadsheet.

The latest commit added an inline link below the address-intake source dropdown explaining that only configured outside sources appear there.

## Immediate next action

Wait for the user to add/test the missing-address source. Then guide them to **Scan address list**, but do not tell them to apply immediately.

First inspect and explain the preview totals:

- already known/exact matches;
- clearly new addresses;
- close matches requiring review;
- invalid or blocked rows;
- duplicate rows inside the incoming list.

Confirm that the source columns were interpreted correctly. Supported address header aliases are defined in `app/src/routes/addressIntake.routes.ts`; expected fields include address ID/APN when available, situs house number, direction, street, unit, city, state, ZIP, latitude, and longitude.

Before live apply, verify:

- obvious duplicates are not selected as new;
- close matches are held for review;
- Mapbox can compute a zone;
- the destination captain sheet exists;
- active tombstones cannot be resurrected;
- the resulting records are address-only placeholders with fresh resident IDs as designed;
- preview counts and selection language are understandable.

If the test connection or scan fails, diagnose the concrete API/server error and fix it. Do not merely reinterpret a backend diagnostic for the user.

## Remaining completion path

1. Finish the one-time missing-address intake with the user.
2. Re-run captain import if warned/blocked captain addresses remain, resolving ID mismatches rather than duplicating addresses.
3. Run and apply the final folder cleanup after imported addresses are in the master.
4. Verify private note formulas became literal text without displaying their contents.
5. Verify booleans and `_SitusUnit` formatting in master and captain sheets.
6. Exercise production acceptance flows: preview, live apply, run details, and Undo on a safe small sample.
7. Run backend tests/build and frontend build.
8. Review final git status and commit only intended source changes. Do not add generated `app/dist` or `app/web/dist` files unless repository policy explicitly requires them.

## Important implementation locations

- `app/src/routes/addressIntake.routes.ts`
- `app/src/lib/addressIntakeEngine.ts`
- `app/web/src/components/AddressIntakePlaybook.tsx`
- `app/src/lib/pullEngine.ts`
- `app/src/routes/captainImport.routes.ts`
- `app/web/src/components/CaptainImportPlaybook.tsx`
- `app/src/lib/folderCleanupEngine.ts`
- `app/src/cleanupTasks.ts`
- `app/src/routes/folderCleanup.routes.ts`
- `app/web/src/components/FolderCleanupPlaybook.tsx`
- `app/src/routes/operations.routes.ts`
- `app/src/executionTasks.ts`
- `app/src/db.ts`

## Safety invariants

- Never overwrite `resident_id` on an existing record.
- Treat an `address_id` household as one movement/deletion unit.
- Never silently import the same normalized situs under a different `address_id`.
- Never reintroduce a tombstoned resident or address.
- Never log or display sensitive note contents.
- Never trust row numbers from an old preview; re-resolve/revalidate before live writes.
- Never let a refresh/activity sync initiate deletions.
- Never use the retired sales fields as an import source for captain/master values.
- Undo must fail safely if newer human or automated edits would be overwritten.

Start by reading this file, checking `git status`, and asking the user whether the new outside source passed its connection test. If it did, continue directly with the preview and interpret the actual results.

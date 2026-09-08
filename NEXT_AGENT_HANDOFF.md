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
- Missing-address intake is master-first: every distinct valid street address enters the master even when coordinates are missing or no current Mapbox zone contains it. Mapbox is optional downstream classification, never an admission gate. Addresses with exactly one safe existing captain-zone destination are also published to that captain sheet in the same approved run; all others remain master-only and can be zoned later.
- APN is non-unique metadata, not address identity. Address intake deduplicates by normalized situs (including unit), validates known `address_id` values against situs, and combines repeated source rows rather than rejecting every copy.
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

The active branch is `feature/folder-zone-reconcile`. Latest commits at handoff:

- `fb256f9` Document deferred Mapbox zone metadata audit feature
- `72365f8` Adopt source address_id values during address intake
- `0263141` Remove coordinate-only proximity from address intake review
- `68177f5` Align address placeholders across SheetSmart workflows

`README.md` has an unrelated uncommitted modification — preserve it; do not commit unless the user asks.

## Address intake status (September 2026)

The user completed a successful **10-address acceptance test** after these fixes:

- Source `address_id` UUIDs from the missing-addresses sheet are adopted verbatim (not replaced with situs hashes).
- Coordinates alone no longer hold addresses for duplicate review.
- Placeholder contract: `Placeholder Resident`, boolean `TRUE` in `Address Placeholder`, UUID `resident_id`, source capitalization preserved.
- Mapbox zone/captain contact fields are written from Mapbox, not from stale spreadsheet values.

The user is ready to **bulk-import the remaining missing addresses** in batches of up to 250 with a fresh scan before each batch. An earlier 10-row run was undone; do not reintroduce hash-only address IDs when the source sheet provides UUIDs.

Zone Dashboard developer confirmed hash or UUID `address_id` formats both work if seeded on every row at import time.

## Immediate next action

Guide the user through bulk missing-address intake until the outside source is exhausted:

1. Fresh scan → select up to 250 clearly new addresses → apply → spot-check → confirm Undo.
2. Repeat until no new addresses remain.
3. Do not mutate Google Sheets without SheetSmart preview + user confirmation.

After intake: folder cleanup, captain-to-master reconciliation, deferred Mapbox zone-metadata audit (documented below).

## Deferred feature: meaningful progress indicators

After production acceptance, add progress feedback to long-running scans and live jobs throughout the app:

- Show named stages when total work is not predictable, such as reading the master, reading captain sheets, comparing records, and validating proposed changes.
- Show a real progress bar only when the denominator is stable and meaningful (for example, captain sheets completed out of total sheets).
- Extend the existing durable job/status APIs with processed/total counts where necessary and let the frontend poll those fields.
- The missing-address comparison currently runs as one long HTTP request; accurate live progress will require moving that scan into a tracked background job.
- Do not use fake percentages that race ahead and then stall. Retain ordinary indeterminate loading indicators for short operations.
- Progress polling should be infrequent and lightweight; Google API reads/writes, not UI polling, dominate runtime.

## Deferred feature: Mapbox zone metadata audit

After missing-address intake and the remaining reconciliation work are stable, add a folder-wide scan that compares zone-assignment columns in the master and captain sheets against current Mapbox polygon properties.

**Mapbox is the source of truth** for:

- Zone name
- Captain name
- Captain phone
- Captain email

SheetSmart already writes these from Mapbox during boundary reconciliation and address intake when a single safe zone match exists. Many spreadsheets still carry stale captain contact values from older manual edits.

The future workflow should:

1. Read current Mapbox zone properties for every zoned household in the master (and optionally captain sheets).
2. Compare them to the sheet values for zone name, captain name, captain phone, and captain email.
3. Present plain-English drift: which rows differ, what Mapbox says, what the sheet says.
4. Offer an approval-gated, snapshotted, undoable apply that updates sheet values from Mapbox — same safety bar as other live writes.

This is a **read/compare/report first** feature; live correction can follow once the preview UX is trustworthy. Do not build during bulk address intake unless the user explicitly reprioritizes it.

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

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

## What is working (live Playbooks)

- Folder-wide Mapbox boundary reconciliation, including moves and Undo.
- Creation of missing zone spreadsheets.
- Captain-added resident/address import with duplicate-situs protection.
- Missing-address intake planner and approval-gated execution (bulk import completed September 2026).
- **Live folder-wide captain → master field pull** with Conflict inbox logging.
- **Live folder-wide master → captain sync** (append missing residents; fill blank captain cells).
- Conflict inbox apply now writes the master recorded on the conflict (copy or live) and is undoable.
- Folder cleanup preview/apply/Undo, including obsolete columns, booleans, `_SitusUnit`, and private note protection.
- Durable SQLite-backed jobs with atomic preview consumption.
- Operations workbook ingestion, deletion application, tombstones, activity feed, and restoration protections.
- Sales-field retirement guards in captain-to-master paths.
- **Live Mapbox captain-contact audit** — compare/apply/undo for NC Name, NC Phone, NC Email, ZoneName. Two scopes, deliberately separate (`scope: 'captains' | 'master'` on the preview route):
  - `captains` — routine upkeep across the captain folder.
  - `master` — one-time backfill. As of this handoff ~15,260 master residents sit inside a Mapbox zone with blank ZoneName/NC columns (36,120 resident rows total, only 1,032 ever zoned), so this scope proposes ~61,000 cells and applies in 20,000-cell undoable batches. It is NOT drift; do not merge it back into the captain scope.

The active branch is `feature/folder-zone-reconcile`. Latest committed git at last handoff: `72a540f`. **Captain sync and captain pull are in the working tree and may still be uncommitted.**

`README.md` has an unrelated uncommitted modification — preserve it; do not commit unless the user asks.

## Address intake status (September 2026)

Bulk missing-address import is **complete** (~1,400 addresses in batches of 250). A 10-address acceptance test passed first. About **8 duplicate-check rows** may remain in the source sheet — review under Playbooks → Add missing addresses safely, then rescan.

Placeholder contract: `Placeholder Resident`, boolean `TRUE` in `Address Placeholder`, UUID `resident_id`, source capitalization preserved. Source `address_id` UUIDs are adopted verbatim. Coordinates alone do not hold addresses for duplicate review.

## Immediate next action

Guide the operator through first production use of the remaining live sync playbooks (nothing writes until they approve):

1. **Playbooks → Sync master data to captain sheets → Add missing residents** (max 500 residents/run). Wait 5–10 minutes after scan before apply to reduce Google 429 retries.
2. **Same section → Push master fields** (fill blanks; max 5,000 cell writes/run).
3. **Playbooks → When captains update existing people → Pull captain edits into the master** (max 5,000 cell writes/run). Review the Conflict inbox afterward.
4. **Playbooks → When Mapbox zones change → Update captain contacts from Mapbox** (max 5,000 cells/run).
5. **Occasional folder maintenance** to remove obsolete columns and fix booleans / `_SitusUnit`.
6. Review remaining address-intake duplicate-check rows (~8).

Practice-copy playbooks remain available under “Practice on copy spreadsheets” for isolated tests.

## Deferred (do not build unless the user reprioritizes)

- **Meaningful progress indicators** — named stages + real progress bar when the denominator is stable; move long scans to background jobs. Do not fake percentages.
- **Live production zone-column bootstrap** — copy-only `enrich_zones_copy` still refuses the production master. Needed only if a raw master tab is missing ZoneName/NC columns.
- **Reduce redundant re-reads** on apply-after-scan.
- **Raise batch limits** once production runs are stable.
- Cell-level tick boxes on live folder pull (sheet-level approval is the current live UX).

## Important implementation locations

- Captain → master pull: `app/src/lib/captainPullEngine.ts`, `app/src/captainPullTasks.ts`, `app/src/routes/captainPull.routes.ts`, `app/web/src/components/CaptainPullPlaybook.tsx`
- Master → captain sync: `app/src/lib/captainSyncEngine.ts`, `app/src/captainSyncTasks.ts`, `app/src/routes/captainSync.routes.ts`, `app/web/src/components/CaptainSyncPlaybook.tsx`
- Address intake: `app/src/routes/addressIntake.routes.ts`, `app/src/lib/addressIntakeEngine.ts`, `app/web/src/components/AddressIntakePlaybook.tsx`
- Captain import: `app/src/lib/pullEngine.ts`, `app/src/routes/captainImport.routes.ts`, `app/web/src/components/CaptainImportPlaybook.tsx`
- Boundaries: `app/src/lib/zoneEngine.ts`, `app/src/routes/folderReconcile.routes.ts`, `app/web/src/components/FolderReconcilePlaybook.tsx`
- Mapbox contact audit: `app/src/lib/mapboxContactAuditEngine.ts`, `app/src/mapboxContactAuditTasks.ts`, `app/src/routes/mapboxContactAudit.routes.ts`, `app/web/src/components/MapboxContactAuditPlaybook.tsx`
- Cleanup: `app/src/lib/folderCleanupEngine.ts`, `app/src/routes/folderCleanup.routes.ts`, `app/web/src/components/FolderCleanupPlaybook.tsx`
- Execution / undo: `app/src/executionTasks.ts`, `app/src/routes/safeExecution.routes.ts`
- Handoff doc (update when milestones shift): `NEXT_AGENT_HANDOFF.md`

## Live pull / sync API

- `POST /api/captain-pull/preview` → `preview_pull_folder`
- `POST /api/captain-pull/apply` → task `pull_folder`
- `POST /api/captain-sync/push-missing/preview` → `preview_push_missing_folder`
- `POST /api/captain-sync/push-missing/apply` → task `push_missing_folder`
- `POST /api/captain-sync/push-fields/preview` → `preview_push_folder`
- `POST /api/captain-sync/push-fields/apply` → task `push_folder`
- `POST /api/mapbox-contact-audit/preview` → `preview_mapbox_contact_audit` (body: `{ scope: 'captains' | 'master' }`, default `captains`)
- `POST /api/mapbox-contact-audit/apply` → task `mapbox_contact_audit`

### Zone rename vs. resident relocation (do not collapse these)

A zone renamed in Mapbox is row-for-row indistinguishable from a zone whose residents were all reassigned. `detectZoneRenames` in `mapboxContactAuditEngine.ts` separates them sheet-wide:

- **Rename** — every row carrying the old label resolves to the same new label, no row still agrees with the old label, and the old label is absent from the Mapbox roster. Nobody moved, so ZoneName is corrected in place and contacts are written. Real example: `Zone 136` → `The Meadows`, 519 rows, same captains.
- **Relocation** — only part of the sheet disagrees, or the old label still exists in Mapbox. Those rows are skipped **entirely** (no ZoneName write and no contact write) and belong to "Move residents when zone boundaries change". Real examples: 74 rows `Zone 30` → `Zone 148`, 1 row `Zone 20` → `Zone 17`.

Writing the new zone's captain onto a row still labelled with the old zone leaves the row self-contradictory. That was a real defect in the first version of this audit; keep the `continue` that skips relocation rows.

Safety pattern: preview stores per-sheet fingerprints + dictionary fingerprint; apply uses `jobs.enqueueFromPreview`; live task re-reads, replans, verifies fingerprint, then writes snapshots. Undo via `/api/runs/:id/revert`.

## Address placeholder contract (do not break)

- Column: `Address Placeholder` — actual booleans, not text
- Address-only rows: `Placeholder Resident`, UUID `resident_id`, boolean `TRUE`
- Source `address_id` UUIDs adopted verbatim when present
- Capitalization preserved on write

## Safety invariants

- Never overwrite `resident_id` on an existing record.
- Treat an `address_id` household as one movement/deletion unit.
- Never silently import the same normalized situs under a different `address_id`.
- Never reintroduce a tombstoned resident or address.
- Never log or display sensitive note contents.
- Never trust row numbers from an old preview; re-resolve/revalidate before live writes.
- Never let a refresh/activity sync initiate deletions.
- Never use the retired sales fields as an import source for captain/master values.
- Mapbox owns zone/captain-assignment fields on write.
- Undo must fail safely if newer human or automated edits would be overwritten.

## Do not reintroduce

- Uppercasing source street/city on write
- Internal `__address_placeholder__:…` resident IDs
- Ignoring source `address_id` when present
- Coordinate-only duplicate review holds

# SheetSmart — Phase C Handoff & Continuation Prompt (Safe Execution + Undo)

## July 31, 2026 progress update — re-zone captain-sheet moves (copies only)

Use Case 1’s remaining “doing” half is built as a third reversible live playbook
on **copies only**:

- Playbook: **Move residents between captain sheet copies** (Playbooks page).
- Pure planners: `planCaptainSheetMoves` (Mapbox-computed destination),
  `planGuardedMoves` / `planGuardedDeletes` / `planRowRestores` in
  `liveWriteEngine.ts`.
- Live path: preview → per-row checkbox approval (before/after zone + sheet) →
  re-read + fingerprint check → snapshot → append to destination → identity
  delete from source → Runs → Undo (remove unchanged dest rows + restore
  unchanged source rows; edited rows become conflicts).
- Both captain copies must sit in the testing folder. Optional zone overrides
  support empty destination test sheets. Production master ID is hard-refused.
- Setting key: `safe_copy_move_target`. Tasks: `move_residents_copy`,
  `revert_move_copy`.
- UI verified in browser on http://localhost:3001/playbooks (form pre-fills
  from the existing safe-copy target; destination copy still empty).
- **Live E2E not yet run** — needs a second captain copy in the testing folder
  (and ideally 1–2 synthetic residents on the source whose lat/lon fall in the
  destination zone). Append + enrichment loops were left untouched.

Tests after this slice: **63/63 pass**, 0 skipped. Backend typecheck and both
builds clean.

## July 31, 2026 progress update — master-copy zone enrichment write verified

Approval-gated zone enrichment now writes to the **master copy only**:

- Playbook: **Enrich zones on the raw master copy** (Playbooks page).
- Reads `Master Data File` on the configured master copy, computes ZoneName +
  NC fields from Mapbox, expands columns, fills blanks only through
  `writeGuard`, snapshots every cell, and supports Undo.
- Production master ID is hard-refused.
- Verified end-to-end on the test master copy:
  preview **#18** → live enrich **#19** (4 columns added, **60,909** cells
  filled) → undo **#20** (**60,913** snapshots restored, 0 conflicts).
- Copy returned to pre-enrichment state afterward. No production sheet written.
- Sheets write pacing + quota backoff added (`updateValuesChunked`, longer
  retry on 429). Cell undo treats never-written cells as skips and chunks SQL
  updates past SQLite’s variable limit.
- App serves on **http://localhost:3001** (port 3000 reserved for another project).

Tests after this slice: **58/58 pass**. Backend typecheck and both builds clean.

## July 31, 2026 progress update — parity harness activated

The Operator supplied a legacy Apps Script audit report generated from the
frozen copies. Capture + diff succeeded:

- Master copy `1O9iOj90…` tab `Zones Join 2026-07-29` (34,556 rows)
- Testing folder with 1 captain copy: `Test Copy of Zone 1 - Angela Uriu` (202 rows)
- Legacy report `1xRawHOXH66NJjDn8ygA2IU2BSnH3ZjkarAU90hfcnKU` (Viewer shared)
- Fixture written to `app/test/fixtures/parity/parity-fixture.json`
- **`npm test` → 55/55 pass, 0 skipped.** Audit engine matches legacy Overview
  counts and detail-tab row totals on these copies.

This clears the “honest parity before real sheets” gate for the audit engine.
Live writes still stay on copies until the Operator graduates them.

## July 31, 2026 progress update — raw-master enrichment plan (read-only)

The zone engine no longer requires `ZoneName` / NC columns as inputs. Against
the raw 48-column **Master Data File** tab it now produces an enrichment plan:

- Missing `ZoneName`, `NC Name`, `NC Phone`, and `NC Email` are **proposed
  output columns**, not config errors.
- Each matched resident gets computed values from Mapbox polygons.
- Health shows an **Enrichment plan (read-only)** callout, columns-to-add
  metrics, and a prioritized sample table of raw resident → computed
  ZoneName/NC values.
- Detail rows are capped at 250 (summary counts stay exact) so a raw-master
  run stays readable.
- **No zone write path was enabled.** Nothing was written to any sheet.

Verified live (read-only) as zone-check run **#11** on the configured master
connection's `Master Data File` tab:

- 4 columns to add
- 15,639 residents would receive a zone
- 0 would change zone (no current ZoneName column)
- 18,916 in no zone, 1 missing coords, 9 multi-zone
- 119 zone shapes loaded / 119 zones computed
- Sample rows show concrete computed ZoneName + NC Name/Phone/Email

Tests/builds after this slice: **55 tests, 54 pass, 1 skipped** (parity);
backend typecheck and both production builds clean. The safe-copy append /
Undo playbook remains available and unchanged.

Implementation touchpoints: `src/lib/zoneEngine.ts`, `test/zoneEngine.test.ts`,
`web/src/pages/Dashboard.tsx`, `web/src/lib/types.ts`.

## July 31, 2026 progress update — first reversible live loop verified

Phase C has now crossed its first gate **on copies only**:

- A dedicated safe-copy playbook is configured in **Playbooks**. It validates
  that the selected captain copy is inside the testing folder before allowing a
  preview.
- The Operator sees the exact residents before approval. Live execution
  re-reads both copies and refuses to write if the approved identities changed
  after preview.
- The live append is snapshotted by `resident_id`, written through the guarded
  append planner, logged durably, and shown in **Runs**.
- **Undo this run** re-finds appended rows by `resident_id`. It deletes only
  rows that still exactly match their post-run snapshot; edited rows are kept
  and surfaced as conflicts.
- Verified end-to-end with one synthetic, non-person resident on the supplied
  master/captain copies: preview run **#8** → live append run **#9** → undo run
  **#10**. Google showed the row after #9 and absent after #10. The synthetic
  source fixture was then removed; both copies returned to their starting row
  counts. No production sheet was written.
- Tests/builds after verification: **53 tests, 52 pass, 1 skipped** (the legacy
  parity fixture); backend typecheck and both production builds are clean.
  *(Superseded by the later enrichment-slice counts above.)*

Implementation: `src/executionTasks.ts`, `src/lib/liveWriteEngine.ts`,
`src/routes/safeExecution.routes.ts`, Phase-C helpers in `src/google.ts`,
`run_snapshots` in `src/db.ts`, and the approval/revert UI in
`web/src/pages/Workflows.tsx` + `Runs.tsx`.

**Important corrected data model:** the historical raw `Master Data File` tab
has 48 fields and does **not** contain `ZoneName` / NC fields. The Data Pull App
creates the 52-field `Zones Join …` tab. The verified append test therefore
uses `Zones Join 2026-07-29` as its source. SheetSmart can now **preview**
enrichment from the raw master + Mapbox; the approval-gated, snapshotted write
of those four columns is the next zone vertical slice — do not enable it until
it is fully tested on the master copy.

Still gated: folder-wide execution, all production writes, and any live zone
enrichment write. The legacy parity fixture/report remains required before
graduating from copies to real sheets.

**Written:** right after the read-only **Zone Health check (Workflow A)** was built,
tested, and verified live against the real Google account + Mapbox. Written to hand
off the next (large) sprint to a fresh agent, because the previous agent's context
was full.

**One-line goal of the next sprint:** turn SheetSmart from a read-only "X-ray" into
a tool that can **actually make changes — but only with the Operator's approval,
showing before/after, everything snapshotted and one-click-reversible.** This is
**Phase C (Safe execution + Undo)** from the roadmap, scoped concretely around the
three real use cases the Operator gave (see §2).

**Read order for a fresh agent (do this first):**
`SHEETSMART_VISION_AND_ROADMAP.md` (north star; esp. §5.3 undo, §5.5 Conflict Inbox,
§9.5 direction) → `SHEETSMART_PHASE_A_HANDOFF.md` → `SHEETSMART_PHASE_B_HANDOFF.md`
→ this file → `ZONE_PIPELINE_SPEC.md` (the zone work) → `app/README.md` →
`legacy-appsscript/AGENTS.md` (behavioral source of truth — port, don't guess).

---

## 1. Where things stand *today* (verified)

- **Backend + frontend both TypeScript**, one Express service serves API + the
  React/Vite UI. SQLite via `src/db.ts`. Run it: `cd app; npm run build:web;
  npm run build; npm start` → http://localhost:3000. Dev: `npm run dev` (backend
  hot-reload) + `npm run web:dev`. **Shell is Windows PowerShell — chain with `;`
  not `&&`.** Free port 3000 before restart:
  `Get-NetTCPConnection -LocalPort 3000 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }`.
- **Local admin password:** `letmein-dev` (in `app/.env` as `ADMIN_PASSWORD`).
  `.env` also has the Google service-account key, `DATABASE_PATH`, and now
  **`MAPBOX_TOKEN`** (a `pk.` token with `datasets:read`, already set + working).
- **Everything is still READ-ONLY. Nothing in the app has ever written to a Google
  sheet.** That is the line Phase C crosses — carefully.
- **Tests:** `npm test` → **47 tests, 46 pass, 1 skipped**. The 1 skip is the
  **parity harness** (`test/parity.test.ts`), dormant until the Operator supplies
  frozen copies (see §5). `npm run typecheck` clean; both builds clean.

### What already exists and works (the "knowing" half is largely done)
- **Health audit** (read-only): `src/lib/auditEngine.ts` + `routes/audit.routes.ts`
  + Dashboard UI. Column drift, duplicate `resident_id`, missing/extra rows by
  detected zone, completeness, APN issues.
- **Dry-run Previews** (read-only): `src/lib/mergeEngine.ts` (pure planners:
  `planCellFill`, `planPushMissingResidents`, `buildSourceLookup`),
  `src/lib/previewEngine.ts` (Field-Dictionary-driven, plain-language impact),
  `routes/preview.routes.ts` (3 playbooks: `import_sales`, `push_master`,
  `add_missing_residents`). The **"Run it live" button exists but is disabled.**
- **Zone Health check (Workflow A), read-only** — built last session:
  - `src/lib/zoneEngine.ts` — pure geometry (point-in-polygon w/ holes +
    multipolygons, bbox index) ported from `reference-tools/data-pull-extension/
    background.js`, plus `reconcileZones()` which categorizes every resident:
    `match` / `fill` / `conflict` (would change zone) / `unassigned` /
    `missing_coords`, and surfaces stale NC (captain) contact changes.
  - `test/zoneEngine.test.ts` (10 tests). `src/mapbox.ts` (read-only feature
    fetch). `routes/zones.routes.ts` (`POST /zones/check`, `GET /zones/latest`,
    `GET|POST /zones/source`). Dashboard "Zones & captains" section.
  - **Verified live** (run #5): 119 zone shapes, 34,556 residents; 47 would change
    zone, 12 unzoned→would fill, 3,295 captain-contact updates, 18,916 in no zone,
    15,580 already correct, 9 in >1 zone, 1 missing coords.

### The "doing" half — NOT built (this is your job)
There is **no live writer, no snapshot/undo, no Conflict Inbox behavior, and no
pull-from-captains planner.** `src/lib/writeGuard.ts` (the tested safety decision
point) exists but nothing calls it against a real sheet yet. `src/google.ts`
intentionally exposes only reads (though `SCOPES` already includes
`spreadsheets` read+write, so no scope change is needed for cell writes).

---

## 2. The three real use cases to deliver (Operator's words)

Build toward these exact goals. They all share one missing capability: **approve →
apply → (before/after) → undo.** Build that engine once; it unlocks all three.

**Use case 3 — "Push new residents out" (BUILD FIRST — safest on-ramp):**
> "I've added a few thousand new addresses to my master, each with a placeholder
> resident. Those new rows need to be pushed out to the correct captain
> spreadsheet."
- Pure plan already exists (`planPushMissingResidents`, preview
  `add_missing_residents`). Only *adds* rows (nothing overwritten) → lowest risk.
- Need: a **live append writer** (through `writeGuard`), snapshotted, with undo
  (undo of an append = delete the appended rows by `resident_id` identity).

**Use case 1 — "Re-zone after redrawing the map, with per-row approval + before/after":**
> "I redraw/add zones in Mapbox. Addresses need to end up in the right zone
> spreadsheet — sometimes moving a person from one zone sheet to another. I want to
> approve each move manually and see a before/after."
- Knowing = done (the zone check already produces the 47 "would change zone" +
  the fills). Need two doing-steps:
  1. **Apply the master's `ZoneName`/NC changes** (write `reconcileZones` results
     to the master through `writeGuard`, snapshotted; recompute-with-approval per
     `ZONE_PIPELINE_SPEC.md` §3).
  2. **Move the row between captain sheets** = append to the new zone's sheet
     (like UC3) **and remove it from the old zone's sheet** (row removal is NEW).
     Gate each move behind explicit per-row approval with a before/after view.

**Use case 2 — "Pull captain edits into master, approve overwrites" (BUILD LAST):**
> "Pull data captains entered in their zone sheets back into the master. But I want
> to approve overwrites — e.g. if a captain changed someone's name or phone."
- Needs the most new parts: (a) a **new pure planner `planPullToMaster`** (captain
  sheets → master, matched by `resident_id`; fill-blank auto, non-blank
  disagreements become conflicts — mirror `planCellFill` but reversed direction and
  port pull semantics from `legacy-appsscript` `MergeEngine.gs`), and (b) the
  **Conflict Inbox** behavior: show both values, Operator picks "keep master / take
  captain / enter value", applied via `writeGuard`, snapshotted, reversible. The
  Conflicts page (`web/src/pages/Conflicts.tsx`) is currently a shell.

---

## 3. The Phase-C engine to build (the shared core)

Build these pieces; they are the spine under all three use cases.

1. **Google write helpers** in `src/google.ts`, each wrapped in the existing
   `withRetry`: batched `values.update` (fill cells), `values.append` (add rows),
   `spreadsheets.batchUpdate` (for row deletes / structural). Keep them small and
   typed. Do NOT scatter Sheets calls elsewhere.
2. **A writer that goes through `writeGuard`** — turn a plan's `writes` / `newRows`
   into batched Sheets updates. Every proposed cell MUST pass through
   `src/lib/writeGuard.ts` (fill blanks only by default; never blank-over-value;
   `resident_id` never written; conflicts logged not resolved). Log every change to
   `run_log_entries`.
3. **Pre-write snapshots + one-click undo** (roadmap §5.3 — the Operator's
   top-priority trust feature). Before any live write, capture the exact
   ranges/rows about to change (values **+ the target row identities by
   `resident_id`**) into a new DB table (e.g. `run_snapshots`) attached to the
   `run`. Add **"revert this run"** that restores by identity — safe even if
   captains edited in between (write-guard applies in reverse). Undo of an *append*
   = remove those rows by identity.
4. **Approval gating + before/after UI.** Every live action is: preview → explicit
   confirm → apply. For UC1 row-moves and UC2 overwrites, approval is **per item**
   (per row / per conflict), each showing before → after. Reuse the existing
   before/after display pattern (the zone check already renders "current → computed"
   and NC "from → to"; previews already render per-sheet impact).
5. **Conflict Inbox** (roadmap §5.5): promote logged conflicts to a triage queue
   with approve-a-resolution that writes the chosen value (through `writeGuard`,
   snapshotted). Wire `web/src/pages/Conflicts.tsx`.
6. **Turn on the disabled "Run it live" buttons** (Playbooks modal in
   `web/src/pages/Workflows.tsx`) behind an explicit confirm, once the above is real.

Data-model additions likely needed (extend `src/db.ts` carefully; note the
`connections.type` CHECK constraint if you touch it): a `run_snapshots` table;
new `run` types (`push_missing_live`, `pull_to_master`, `zone_apply`,
`conflict_resolution`); `conflicts` already exists and is usable.

---

## 4. Non-negotiables (NEVER violate — these are "the soul")

1. **Dry-run before live, always.** A live write is a separate, explicit, confirmed
   act. Never auto-apply.
2. **Fill blanks only; never write a blank over a value; log conflicts, don't
   resolve them.** All writes go through `src/lib/writeGuard.ts` (tested).
3. **`resident_id` is sacred** — never written.
4. **Everything logged durably** (runs + run_log_entries = permanent audit trail).
5. **Snapshot before every live write; make undo real** (§5.3). Trust is the
   product — the Operator said so explicitly.
6. **Parity harness must be honest before writing to REAL sheets, and test on
   COPIES first** (§5 below). `legacy-appsscript/` is read-only reference.
7. **Join by identity (`resident_id`), not row index.** Batch reads/writes; retry
   with backoff.
8. **The Operator is one non-developer** (tenacious, knows GitHub/Vercel, not code).
   Talk in plain, warm, civic language (Altagether style guide). Explain what a run
   *would* do before doing it. When a decision needs his real-world knowledge, stop
   and ask simply.

---

## 5. Before flipping ANY live write onto real sheets

1. **Activate the parity harness** (`test/parity.test.ts`, currently skipped). It
   needs the Operator to make **frozen COPIES** of the master + a few captain sheets
   and (ideally) run the legacy `Code.gs` audit on them, so
   `scripts/capture-parity-fixtures.ts` can capture golden output. Then it diffs the
   engines against known-good and fails loudly. Ask the Operator for the copies in
   plain language.
2. **Test every live path on the COPIES first**, never the real master/captain
   sheets. The 120 captain sheets feed the live captain-facing **Zone Dashboard**,
   so writes have real downstream blast radius.
3. Only graduate to real sheets after the Operator watches it work on copies and can
   undo a run.

---

## 6. Two real-data questions surfaced by the live zone check (ask the Operator)

- **18,916 residents "in no zone"** (>half of 34,556). Likely expected (the master
  is a broad voter-roll/DINS dataset wider than the ~120 fire zones), but confirm
  it's intent, not missing polygons. These should be left untouched by re-zoning.
- **120 distinct zones in the master vs 119 polygons in Mapbox.** One zone in the
  data has no matching shape (or a polygon has a blank name). Find which; residents
  in it can never be matched.

Also still-open (from `ZONE_PIPELINE_SPEC.md` §7): **captain-contact source of
truth** (Mapbox properties vs a first-class "zone roster" SheetSmart owns — this
matters for UC1/UC2 since NC edits are PII), and, later, **Workflow B** (generate
captain sheets) which needs a Drive-write scope + a file-ownership decision.

---

## 7. Suggested build order

1. **Google write helpers + writer-through-writeGuard + snapshots/undo** (the spine).
2. **Use case 3 live** (push new residents to captains) end-to-end on COPIES:
   preview → confirm → append → visible in Runs → revert. Safest first win.
3. **Use case 1**: apply master zone/NC changes (writeGuard + snapshot), then the
   per-row, approve-with-before/after **move between captain sheets** (append new +
   remove old).
4. **Use case 2**: build `planPullToMaster` + the **Conflict Inbox** apply flow.
5. Keep the parity harness honest throughout; keep tests green; screenshot any UI.

Work in small, verifiable steps; keep the app runnable at every step; take a
screenshot of any UI you build; and stop to ask the Operator whenever a decision
needs his real-world knowledge.

---

## 8. Copy-paste kickoff prompt for the new agent (July 31 evening)

Paste the block below into a fresh agent.

```text
Continue development of SheetSmart at:

C:\projects\Altagether Zone Dashboard\Support tools\SheetSmart Web App

Move quickly, but preserve every safety rule. Do not merely plan—inspect the current implementation, continue building, test thoroughly, and keep the app runnable.

Read first:
1. SHEETSMART_VISION_AND_ROADMAP.md
2. SHEETSMART_PHASE_C_HANDOFF.md — July 31 progress updates at the top are current
3. SHEETSMART_PHASE_A_HANDOFF.md
4. SHEETSMART_PHASE_B_HANDOFF.md
5. ZONE_PIPELINE_SPEC.md
6. app/README.md
7. legacy-appsscript/AGENTS.md
8. ALTAGETHER_Support Tool Style Guide.md

Product concept:
SheetSmart is the trusted clearinghouse between the organization-wide resident data and ~150 captain spreadsheets. It watches, compares, proposes changes, asks for approval, writes safely, records everything, and supports undo. Eventually its database may become the system of record, but that migration is incremental.

Current verified state:
- Health audit, dry-run previews, Field Dictionary, and Mapbox Zone Health are working.
- Parity harness is ACTIVE and green: app/test/fixtures/parity/parity-fixture.json
  exists; npm test → 58/58 pass, 0 skipped. Audit engine matches the legacy Apps
  Script report on the frozen copies.
- First reversible live loop (Use Case 3) verified on copies:
  preview → exact approval → append → snapshot/log → Runs → Undo
  (runs #8 → #9 → #10; synthetic fixture removed afterward).
- Raw-master zone enrichment is implemented and verified on the master copy:
  preview → approve → add ZoneName/NC columns + fill blanks → Undo
  (preview #18 → live #19: 4 columns, 60,909 cells → undo #20 restored all).
  Master copy returned to pre-enrichment state afterward.
- No production spreadsheet was written by enrichment or append tests.
- Backend typecheck and both production builds pass.
- App should run at http://localhost:3001 (NOT 3000 — another project uses 3000).
  Start with: cd app; $env:PORT='3001'; npm start
  (or set PORT=3001 in .env). Local login password is in app/.env.
- Substantial July 31 work may still be UNCOMMITTED. Inspect git status before
  editing; do not commit unless the Operator asks.

Safe copies already configured:
- Master copy:
  https://docs.google.com/spreadsheets/d/1O9iOj90QoEBxsAxVCFUCXPcUdbbpxNT8pPtRYfJk1yo/edit
- Raw tab: Master Data File — 48 columns, no zone/NC fields (enrichment target).
- Enriched tab: Zones Join 2026-07-29 — 52 columns including ZoneName/NC
  (source for append playbook).
- Captain copy:
  https://docs.google.com/spreadsheets/d/1KYXW0BSDwlhuN_7oKr_HI_-ucvRJz39WbW4LREu0mBY/edit
- Testing folder:
  https://drive.google.com/drive/folders/1S4qOLKkG4GGhdD-GSV5r663kum6Z0t5p
- Legacy parity report (Viewer shared):
  https://docs.google.com/spreadsheets/d/1xRawHOXH66NJjDn8ygA2IU2BSnH3ZjkarAU90hfcnKU/edit
- The SheetSmart service-account bot has Editor on copies; Viewer on the report.
- PRODUCTION master ID (hard-refused by enrichment): 1dW7oC9VlGBEfeHhl2zeq2_Td8c6QoYwjTxoqAn-3p6w

Important architectural facts:
- Historical raw master does NOT contain ZoneName / NC fields. Enrichment computes
  them from lat/lon + Mapbox. Long-term SheetSmart owns: raw master + Mapbox →
  approved reversible publication to captain sheets.
- Append playbook uses Zones Join tab as source; enrichment playbook writes to
  Master Data File on the master COPY only.
- Safe-copy target is stored in app_settings key safe_copy_execution_target.
- Large Sheets writes must use updateValuesChunked with pacing + quota backoff
  (60 write-requests/minute limit was hit during first enrichment attempt).

Key Phase-C files:
- app/src/executionTasks.ts — live jobs: push_missing_copy, enrich_zones_copy, reverts
- app/src/lib/liveWriteEngine.ts — planGuardedAppends/CellWrites, planAppendRevert, planCellRevert
- app/src/lib/zoneEngine.ts — reconcileZones, planZoneEnrichment
- app/src/routes/safeExecution.routes.ts — preview/apply/revert APIs
- app/src/google.ts — centralized Google reads/writes
- app/src/db.ts — run_snapshots
- app/web/src/pages/Workflows.tsx, Runs.tsx, Dashboard.tsx

Safety invariants:
- Never touch production sheets without explicit Operator approval.
- Copies first.
- Dry run before every live run.
- Re-read immediately before writing and reject stale previews.
- Join by resident_id, never stored row number.
- Existing resident_id values are immutable.
- New rows must include resident_id so they can be deduplicated and undone.
- Snapshot before every live mutation.
- Never overwrite a nonblank value without an explicit approved policy.
- Preserve captain edits during undo; changed rows/cells become conflicts.
- Batch Google calls and wrap them in retry/backoff; pace large write batches.
- Keep all Google writes centralized in app/src/google.ts.
- Keep permanent run and detail logs.
- Do not restore secrets from reference-tools.
- Do not commit unless the Operator asks.

Immediate next objective:
Build Use Case 1’s remaining “doing” half — re-zone moves between captain sheets —
without weakening the verified append and enrichment loops.

Suggested small vertical slice:
1. From zone reconciliation conflicts/fills, propose per-resident moves:
   append to the new zone’s captain sheet + remove from the old (identity-based).
2. Show per-row before/after approval UI (current zone/sheet → computed zone/sheet).
3. Live path on COPIES only: snapshot → guarded append + guarded delete → Runs → Undo.
4. Do not enable folder-wide or production moves yet.
5. Keep enrich_zones_copy and push_missing_copy green.
6. Prefer testing with one or two synthetic residents on the existing captain copy
   (and a second captain copy if the Operator adds one to the testing folder).

After that (later):
- Use Case 2: planPullToMaster + Conflict Inbox apply flow.
- Folder-wide live execution.
- Graduate any path to production only after Operator watches it on copies.

Before finishing:
- Run npm test.
- Run npm run typecheck.
- Build backend and frontend.
- Check edited-file diagnostics.
- Exercise any UI change in the browser and take screenshots.
- Update SHEETSMART_PHASE_C_HANDOFF.md with verified facts.
- Clearly report what is functional, what remains copy-only, and what input is needed from the Operator.
```

---

*End of Phase C handoff update. Two reversible live loops are proven on copies
(append + master enrichment); the third (captain-sheet moves) is built and
unit-tested but awaits a second captain copy for live verification; parity is
green. Next after live move proof: Use Case 2 pull-to-master + Conflict Inbox.*

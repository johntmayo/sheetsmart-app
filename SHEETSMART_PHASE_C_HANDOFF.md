# SheetSmart — Phase C Handoff & Continuation Prompt (Safe Execution + Undo)

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

## 8. Copy-paste kickoff prompt for the new agent

> You are continuing **SheetSmart**, a standalone admin web app that keeps ~120
> Google "captain" spreadsheets aligned with one master resident dataset for a
> post-fire recovery outreach in Altadena. Backend + frontend are TypeScript
> (Express + SQLite in `app/`; React + Vite in `app/web/`). The Operator is one
> tenacious non-developer — talk plainly and warmly; explain before you act.
>
> **Read first, in order:** `SHEETSMART_VISION_AND_ROADMAP.md`,
> `SHEETSMART_PHASE_A_HANDOFF.md`, `SHEETSMART_PHASE_B_HANDOFF.md`,
> `SHEETSMART_PHASE_C_HANDOFF.md` (this is your spec), `ZONE_PIPELINE_SPEC.md`,
> `app/README.md`, `legacy-appsscript/AGENTS.md` (behavioral truth — port, don't
> guess).
>
> **State:** Read-only app is done and verified live: Health audit, dry-run
> Previews, and the new Zone Health check (Workflow A). 47 tests (46 pass, 1
> skipped parity). **Nothing writes to any sheet yet.** Run: `cd app;
> npm run build:web; npm run build; npm start` → http://localhost:3000 (password
> `letmein-dev`). Dev: `npm run dev` + `npm run web:dev`. `npm test` /
> `npm run typecheck`. PowerShell — chain with `;`. `MAPBOX_TOKEN` is set + working.
>
> **Your job — build Phase C (Safe execution + Undo)** to deliver the Operator's
> three use cases (see `SHEETSMART_PHASE_C_HANDOFF.md` §2): (3) push thousands of
> new master residents out to the correct captain sheets; (1) re-zone after map
> redraws, moving rows between captain sheets with **per-row approval + before/after**;
> (2) pull captain edits back into the master with **manual approval of overwrites**
> via a real Conflict Inbox. Build the shared engine first (§3): Google write
> helpers, a writer that goes through `src/lib/writeGuard.ts`, **pre-write snapshots
> + one-click "revert this run"**, approval gating with before/after, then the
> Conflict Inbox, then enable the disabled "Run it live" buttons.
>
> **Hard rules (never break):** dry-run before live; fill blanks only, never blank
> over a value, log conflicts don't auto-resolve; `resident_id` never written; all
> writes through `writeGuard`; snapshot before every write and make undo real; join
> by `resident_id` not row index; **the parity harness must pass and you must test
> on COPIES before touching real sheets** (coordinate frozen copies with the
> Operator); `legacy-appsscript/` is read-only reference.
>
> **Start by:** confirming the plan with the Operator, then building the write +
> snapshot/undo spine and proving Use Case 3 end-to-end on COPIES (preview → confirm
> → append → see it in Runs → revert). Small steps, tests green, screenshot the UI,
> and ask the Operator when a decision needs his real-world knowledge (the two data
> questions in §6, captain-contact source of truth, which sheets are copies).

---

*End of Phase C handoff. The read-only brains are trustworthy and tested; your
sprint is the careful, reversible "hands" on top of them.*

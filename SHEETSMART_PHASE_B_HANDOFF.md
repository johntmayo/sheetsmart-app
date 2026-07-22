# SheetSmart — Phase B Handoff & Continuation Prompt

**Written:** after Phase B's Health audit + dry-run Preview were built and
verified by the test suite and builds (not yet against the live Google account).
**Purpose:** (1) document exactly what changed in Phase B, and (2) give the next
agent a ready-to-paste prompt to continue.

**Read order for a fresh agent:** `SHEETSMART_VISION_AND_ROADMAP.md` (north star)
→ `SHEETSMART_PHASE_A_HANDOFF.md` (foundation) → this file → `app/README.md`
→ `legacy-appsscript/AGENTS.md` (behavioral truth — the legacy code decides
exact behavior; port, don't guess).

---

## 1. What Phase B delivered

Phase B is "Health & Preview" from the roadmap (§7): read-only, high-value, zero
writes. Two of the three planned pillars are done (Health, Preview). The third
(the parity harness) is scaffolded conceptually but **not built** — it needs the
Operator's frozen copies (see §4).

Everything added is **read-only**. Nothing in the app writes to any Google sheet.

### 1.1 The Health / alignment audit (roadmap §5.4)
- **Pure engine — `app/src/lib/auditEngine.ts`.** A faithful port of the legacy
  standalone audit (`legacy-appsscript/Code.gs`, `runAudit()`), which is the
  behavioral source of truth for Health metrics. Pure functions, no I/O, so it's
  testable and diff-able later by the parity harness. Ports every counting rule:
  - column drift vs. master (Match / Missing / Extra / Missing+Extra)
  - duplicate `resident_id` (within-sheet vs. across-sheets)
  - missing / extra rows by **detected** zone (mode of `ZoneName`), extra split
    into "not in master" vs. "wrong zone"
  - completeness (`APN`/`Damage` non-blank; checkbox `=== true`, not non-blank)
  - unique addresses missing APN, APN inconsistencies at the same address, rows
    missing situs address fields
  - ERROR / Empty sheets are recorded, never fatal (one bad sheet can't kill a run)
  - **Parity note:** it normalizes each grid to a rectangle first, because the
    Sheets REST API trims trailing blanks whereas Apps Script `getValues()` pads
    them with `''`. This keeps counts identical to the legacy tool.
- **Tests — `app/test/auditEngine.test.ts`** (10 tests): drift classification,
  APN/Damage counts, row membership by zone, duplicate scope, ERROR/Empty,
  APN inconsistencies, missing situs.
- **Routes — `app/src/routes/audit.routes.ts`:**
  - `POST /api/audit/run` — reads the master + every captain sheet via the
    existing read-only `google.readValues()`, runs the engine, records a durable
    `run` (type `audit`, mode `dry`), and caches the full report in `app_settings`
    (`last_audit_report`).
  - `GET /api/audit/latest` — serves the cached report so Health is ambient (no
    re-scan on every page visit).
- **UI — `app/web/src/pages/Dashboard.tsx`** (the `/` "Health" screen): the
  connection cards plus an **Alignment** section — a "Check alignment" button,
  last-checked timestamp, summary metric cards (turn red when > 0), a per-captain-
  sheet table (status pill, zone, rows, missing/extra, APN issues, drift), and
  collapsible drill-downs (duplicates, missing rows, extra rows, APN
  inconsistencies, missing situs).

### 1.2 Preview / dry run (roadmap §5.2)
- **Pure engine — `app/src/lib/previewEngine.ts`.** Turns the tested pure
  planners in `lib/mergeEngine.ts` into guided, **Field-Dictionary-driven**
  previews with plain-language impact summaries. Key ideas:
  - `resolveFieldHeader` / `buildCellFillConfig` resolve each logical field to a
    sheet's real header via its dictionary aliases, so captain drift is handled
    and every match is explainable (not a silent guess).
  - The match key (e.g. `resident_id`, `APN`) is resolved **separately on each
    side**, because `mergeEngine.planCellFill` keys the source lookup and the
    target independently — so a renamed key on one sheet still lines up.
  - `summarizeCellFill` / `summarizePushMissing` produce warm, plain sentences
    ("This would fill 214 blank cells across 58 sheets and flag 7 conflicts for
    your review. Nothing would be overwritten.").
- **Tests — `app/test/previewEngine.test.ts`** (6 tests): alias resolution,
  config building across drift, end-to-end plan via the config, and both summary
  shapes.
- **Route — `app/src/routes/preview.routes.ts`** (`POST /api/preview`,
  `GET /api/preview/playbooks`). Three guided playbooks, each mapping to a tested
  planner, all read-only:
  - `import_sales` → cell-fill sales → master (matched by APN) → `planCellFill`
  - `push_master` → cell-fill master → each captain (matched by resident_id) →
    `planCellFill`
  - `add_missing_residents` → append missing residents by detected zone →
    `planPushMissingResidents` (sensitive columns come from the dictionary)
  It records a durable dry `run` (type `preview_<key>`) and returns a per-sheet
  breakdown. **Writes nothing.**
- **UI — `app/web/src/pages/Workflows.tsx`** (the "Playbooks" screen): each
  previewable playbook has a **Preview** button that opens a modal with the
  impact headline + detail, metric cards, and a "where the changes land" per-
  sheet table (sheets with changes sorted first). The **"Run it live" button is
  intentionally disabled** — live runs are Phase C. Non-previewable playbooks
  (pull data, rename/delete) are listed under "Coming next."

### 1.3 Wiring / plumbing
- `preview.routes.ts` registered in `app/src/server.ts`.
- Frontend API contract types added in `app/web/src/lib/types.ts` (audit +
  preview shapes, kept in sync with the backend by hand).

### 1.4 Verified
- **36/36 backend tests pass** (`npm test`) — was 21 after Phase A; +10 audit,
  +6 preview, minus the arithmetic that's just the new totals (21 → 36 with the
  16 new). `npm run typecheck` is clean. `npm run build` (backend) and
  `npm run build` in `web/` both succeed.
- **NOT yet verified against the live Google account.** No live round-trip was
  run this session (no admin password / login available to the agent). The next
  agent or the Operator should run an audit + a preview against the real sheets
  and confirm the numbers look sane.

### 1.5 Deliberately NOT built (still open)
- **The parity harness** (roadmap §7 / handoff §8.5). It must diff the new
  dry-run/audit output against **golden outputs captured from the legacy Apps
  Script tool on frozen copies**, and fail loudly on divergence. This needs the
  Operator to provide copied sheets + a legacy run. It is the last Phase B item
  and **must exist before any live write.**
- **Preview for pull-data / pull-missing-rows / schema (rename/delete)
  playbooks.** `mergeEngine` has planners for cell-fill and push-missing only.
  Pull-into-master and schema ops need new pure planners (ported from
  `MergeEngine.gs`) before they can be previewed.

---

## 2. How to run it

```powershell
cd app
npm install          # first time
npm run build:web    # installs web deps + builds app/web -> app/web/dist
npm run build        # compiles the TypeScript backend src/ -> dist/
npm start            # API + UI at http://localhost:3000
```
Local admin password is in `app/.env` (`ADMIN_PASSWORD`). Google key + sheet IDs
are already configured in `.env` and the DB. Backend dev: `npm run dev`
(tsx watch). Frontend dev: `npm run web:dev` (Vite :5173, proxies `/api`).
`npm test` / `npm run typecheck` any time. Shell is Windows PowerShell (use `;`
to chain, not `&&`).

To exercise Phase B against the real account: sign in, open **Health** → "Check
alignment", then **Playbooks** → "Preview" on any of the three syncs.

Windows note — free port 3000 before restarting:
`Get-NetTCPConnection -LocalPort 3000 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }`

---

## 3. Non-negotiables the next agent must preserve

Unchanged from Phase A (roadmap §1, handoff §5):
1. **Dry run before live.** Live writes are always separate, explicit, confirmed.
2. **Fill blanks only; never write blank over a value; log conflicts, don't
   resolve them.** All writes go through `src/lib/writeGuard.ts` (tested).
3. **`resident_id` is sacred** (always `never`).
4. **Everything is logged durably** (runs = permanent audit trail).
5. **No writes to any real sheet before the "first writes" phase**, and test on
   COPIES first. `legacy-appsscript/` is read-only reference.
6. **Batch reads/writes, retry w/ backoff, join by identity not row index.**
7. **The parity harness must be honest before any live write** — build it first
   in Phase C (or finish it as the tail of Phase B).

---

## 4. Recommended next steps (in order)

1. **Verify Phase B against the real account** (fast, do first): run an audit and
   the three previews; sanity-check the numbers and take screenshots.
2. **Finish the parity harness** (last Phase B item). You'll need the Operator to
   make **copies** of the master + a few captain sheets and (ideally) run the
   legacy `Code.gs` audit on them to capture golden output. Then build a
   fixture-based diff (JSON snapshots in `app/test/fixtures/`) comparing
   `auditEngine.runAudit` (and the preview planners) against the golden output,
   failing loudly on any divergence. Ask the Operator in plain language — he is
   not a developer and has said he doesn't yet understand "parity harness."
3. **Phase C — Safe execution + Undo** (the big one; the Operator explicitly
   wants undo). Add a **writer** behind `writeGuard` that turns a plan's `writes`
   / `newRows` into batched Sheets updates; before each live write, **snapshot
   the exact ranges** (values + row identities) into the DB attached to the run;
   offer **one-click "revert this run."** Turn on the "Run it live" button in the
   Playbooks modal (currently disabled) behind an explicit confirm. Build the
   **Conflict Inbox** (review-first). Test on COPIES only, gated by the parity
   harness. See roadmap §5.3 / §9.5.
4. **Port the remaining planners** (pull-data, pull-missing-rows, rename/delete)
   from `MergeEngine.gs` as pure, tested functions, then add their previews.

---

## 5. Copy-paste prompt for the next agent

> You are continuing work on **SheetSmart**, a standalone admin web app that keeps
> ~120 Google "captain" spreadsheets aligned with one master resident dataset for
> a post-fire recovery outreach in Altadena. The app is in `app/` (Node/Express +
> SQLite backend, all TypeScript; React + Vite + TypeScript frontend in `app/web/`).
>
> **Get up to speed first, in this order:** `SHEETSMART_VISION_AND_ROADMAP.md`
> (north star), `SHEETSMART_PHASE_A_HANDOFF.md`, `SHEETSMART_PHASE_B_HANDOFF.md`
> (this is what just shipped), `app/README.md`, and `legacy-appsscript/AGENTS.md`
> (behavioral source of truth — the legacy code decides exact behavior; port,
> don't guess).
>
> **Current state:** Phase 0, Phase A (modern TS frontend + design system +
> Sources + the 52-field Field Dictionary), the backend TypeScript migration
> (Decision B), and **Phase B's Health audit + dry-run Preview** are done. 36/36
> backend tests pass; typecheck + both builds are clean. **Nothing writes to any
> Google sheet yet** — the whole app is still read-only. Phase B was verified by
> tests/builds but **not yet against the live Google account**.
>
> **Run it:** `cd app; npm run build:web; npm run build; npm start` →
> http://localhost:3000 (admin password in `app/.env`). Dev: `npm run dev` +
> `npm run web:dev`. `npm test` / `npm run typecheck`. Shell is Windows PowerShell
> (chain with `;`, not `&&`).
>
> **Hard rules (never violate):** dry-run before live; fill blanks only; never
> write a blank over a value; log conflicts instead of overwriting; `resident_id`
> is never written; all writes go through `src/lib/writeGuard.ts`; no writes to
> real sheets before the live phase and only on COPIES first; the parity harness
> must pass before any live write; treat `legacy-appsscript/` as read-only reference.
>
> **The Operator is one non-developer.** Talk in plain, warm, civic language
> (Altagether style guide). Explain what a run would do before doing it. When a
> decision needs his real-world knowledge (which sheet, whether a column is safe,
> providing frozen copies), stop and ask him simply — don't guess.
>
> **Your task (confirm with me before large moves):** [PICK ONE]
> (a) **Verify Phase B live**: run the Health audit and the three Previews against
>     the real account, sanity-check the numbers, capture screenshots. (Quick.)
> (b) **Finish the parity harness** (last Phase B item): fixture-based diff of the
>     new audit + preview output against legacy golden output on frozen COPIES,
>     failing loudly on divergence. Needs the Operator to provide copies.
> (c) **Start Phase C — Safe execution + Undo**: a writer behind `writeGuard`,
>     pre-write DB snapshots + one-click "revert this run", turn on the disabled
>     "Run it live" button behind an explicit confirm, and the review-first
>     Conflict Inbox. Test on COPIES only, gated by the parity harness.
>
> Work in small, verifiable steps; keep the app runnable; keep tests green; take a
> screenshot of any UI you build; and stop to ask me whenever a decision needs my
> real-world knowledge.

---

*End of Phase B handoff.*

# SheetSmart Build Handoff

**Audience:** the AI coding agent that will build this app, plus the non-developer owner who will operate it.
**Companion documents (same folder):**
- `README.md` — start-here orientation and current status. Read it first.
- `WEB_APP_MIGRATION_SPEC.md` — the product/requirements detail (the "what" and "why" of every workflow).
- `legacy-appsscript/` — the **current, working implementation** in Google Apps Script. This is the behavioral source of truth. See Section 1.5.

**Precedence when documents disagree:** this handoff wins on *architecture*; the spec wins on *workflow intent*; the **legacy code in `legacy-appsscript/` wins on exact behavior** (it is what actually runs today).

**Status:** greenfield. Nothing has been built yet. Build in a **fresh, empty project folder** — do NOT build inside the Altagether Zone Dashboard repository, and do NOT build inside the old `Sheet Smart` Apps Script folder. This folder is a *brief*, not the app; the app gets its own new repo.

---

## 0. How to read this document

This doc is written to be **fully self-contained**. It was produced during a planning chat that will be deleted, so it deliberately re-explains everything needed. You do not need access to that chat or to the zone dashboard's source code to build SheetSmart. What you *do* need is in this folder — including the legacy Apps Script (Section 1.5).

There are two kinds of reader here:

- **The building agent (technical):** follow Sections 2–10. Section 1.5 tells you where the real behavior lives. Section 4 tells you what proven patterns to recreate. Section 8 is your phased build plan with a "definition of done" per phase.
- **The owner (non-developer, "knows enough to be dangerous"):** your job list is **Section 9**. It's click-by-click. Everything in Section 9 is something a human with accounts and a credit card has to do that an AI cannot. There is a plain-English glossary at the very end (Section 12).

**Golden rule for the agent:** the owner is not a developer. Every time you need them to do something outside the code (create an account, paste a key, flip a setting), STOP and give them a numbered, click-by-click instruction, then wait. Never assume they know what a terminal, env var, or API console is — link them to the glossary or explain inline.

---

## 1. What SheetSmart is (context & background)

**The operation:** a post-fire recovery outreach effort in Altadena, CA. There is one **master** resident dataset (a Google Spreadsheet). There are ~55 per-zone **captain sheets** — each volunteer captain works their own copy of a slice of the data. There are also **external sources**, e.g. a sales tracker spreadsheet.

**The problem:** all ~55 captain sheets were originally derived from the master, but over time they drift — columns get renamed/added/dropped, rows go missing, values get entered in one place but not another. Keeping them aligned by hand is slow and error-prone.

**What SheetSmart does:**
- **Audits** every captain sheet against the master — flags column drift, missing/extra rows, duplicate `resident_id` values, and completeness gaps.
- **Moves data** between sheets — imports external sales data into the master, pushes master data out to captain sheets, and pulls captain-entered data back into the master (filling blanks, appending missing rows, and logging conflicts instead of overwriting).
- **Manages schema** — adds, renames, and deletes columns across one or many captain sheets.

**Who uses it:** exactly one person — the owner/admin, who owns and shares all the sheets centrally via a Google service account. Captains never touch SheetSmart; they only ever work in their own spreadsheets.

**Where it is today:** a working pile of Google Apps Script files plus config-spreadsheet tabs. It works but has become too hard to understand, configure, and trust. This project moves it into a real web app. The working code is preserved in `legacy-appsscript/` — see next section.

---

## 1.5. The legacy Apps Script IS the spec (read this before you port anything)

> **Do not reinvent the workflow logic from the prose in this document.** The prose summarizes; the code decides. Every subtle rule — how a zone is detected, how duplicates are handled, which columns are treated as text — already exists and has been battle-tested against the real 55 sheets. Port it; don't guess it.

The `legacy-appsscript/` folder contains the current implementation. File map:

| File | What it is | Why you care |
|------|-----------|--------------|
| `AGENTS.md` | The maintainer's guide to the legacy code. **Read this second, right after this handoff.** It enumerates all 12 operations, every Settings key, and every write policy precisely. | It is the most concise accurate description of current behavior. |
| `Corrections.gs` | The UI layer + menu + orchestration (large). | Shows how each operation is wired, what settings it reads, and what it logs. |
| `MergeEngine.gs` | The lookup-and-merge core (large). | The actual fill/conflict/append/pull logic you must match. This is the heart. |
| `Code.gs` | The standalone Phase-1 audit (folder scan + six-tab report). | Defines exactly how the audit counts things (see completeness nuances below). |
| `Sidebar.html` | The current sidebar UI. | Reference for what inputs each operation exposes. |
| `PRD.md` | Original product requirements. | Background and success criteria. |
| `phase_progress.md` | Roadmap / phase status of the legacy tool. | Tells you what was actually finished vs. planned. |
| `README.md` | End-user setup guide for the legacy tool. | Real-world operating context. |
| `AddressIdMigration.gs`, `FOR REFERENCE - backfill_resident_id.gs` | One-off migration scripts. | Historical; shows how `resident_id` was introduced. Not part of the web app, but explains the join key. |

**Non-obvious behaviors that are easy to miss if you only read the prose** (all of these are in the legacy code — confirm each against it before porting):

1. **Zone detection is inferred, not stored.** Each captain sheet's assigned zone is computed as the **mode (most common value) of its `ZoneName` column** (`detectSheetZone_`). "Push Missing Residents" uses this to decide which master rows belong in a given sheet. There is no separate zone roster.
2. **Checkbox columns count differently.** Completeness counts distinguish "non-blank" from "strictly `=== true`," because an unchecked checkbox returns `false`, not blank (`countTrueInColumn_` vs `countNonBlankInColumn_`). Fields like "Address - For Sale" and "Address - Sold Since Fire" are checkboxes.
3. **`resident_id` is the identity/join key** for push/pull-residents and pull-data, and it is **always forced to the `never` policy** on pull (it can never be written by a workflow). The **match column is configurable and differs by workflow** — external merges historically match on **APN**, while resident push/pull match on **`resident_id`**. Don't hardcode one key everywhere.
4. **Duplicate `resident_id` handling.** In folder-wide pull operations, the *first* source row for a `resident_id` wins; later duplicates are **skipped and logged**, not merged.
5. **Pull-data policy defaults.** Columns not listed in the policy default to **`conflict`** (log, don't write). Only `overwrite` columns may replace a non-blank master value.
6. **Sensitive-column flagging is informational.** When pushing missing rows, a row with a value in a "sensitive" column is **still appended**, but also logged to a "Flagged - Sensitive Data" report so the admin can confirm it was okay to share. It never blocks the push.
7. **Adding columns is a side effect, not a standalone operation.** In the legacy tool there is no "Add Columns" menu item. Cell-fill syncs and pull operations **automatically add any missing target columns first, then fill.** (See Section 7 — the earlier draft of this plan wrongly listed "Add Columns" as its own workflow.)

When Phase 2 says "match the old output," it means: run the legacy tool and the new tool against the *same* data and diff the results. Section 8 describes the parity harness that makes this concrete.

---

## 2. The one decision already made: STANDALONE (and why)

SheetSmart will be a **standalone application**, NOT a section inside the Altagether Zone Dashboard. This was evaluated carefully. Do not re-litigate it. The reasons, so the building agent understands the constraints:

1. **Runtime mismatch.** The zone dashboard runs on Vercel as short-lived *serverless functions* with **no database** — all its state lives in Google Sheets. SheetSmart needs (a) a real database for run history/logs/config and (b) a **job runner** for operations that touch dozens of sheets and take minutes. A 55-sheet sync would blow past serverless time limits. SheetSmart needs an always-on server. These are fundamentally different runtimes.

2. **Blast radius.** The dashboard is used daily by ~50 captains and its main file is extremely fragile ("any change can break anything"). SheetSmart's whole job is to *write to and delete columns across* the exact sheets the dashboard reads. You do not want a risky bulk-edit tool sharing a deploy, a release cycle, or an elevated credential with a live public-facing app.

3. **Credential isolation.** SheetSmart needs broader Google permissions (list a Drive folder, write and delete columns across many files). Keep that power in a **separate, dedicated service account** so the destructive tool never shares an identity with the captain-facing app.

**What we still borrow:** the *patterns* and *approach* from the dashboard (Section 4), not its codebase or its infrastructure.

---

## 3. Recommended stack (optimized for a solo, non-developer operator)

The owner is the only user and is not a developer. Every choice below optimizes for **cheapest + simplest to run and understand**, while still being able to survive long multi-sheet jobs. The building agent should follow this unless it hits a hard blocker, in which case: explain the blocker to the owner in plain English and propose the simplest alternative.

| Concern | Choice | Why (plain English) |
|--------|--------|---------------------|
| Language/runtime | **Node.js**, plain **JavaScript** (no TypeScript) | Matches what the owner already has running elsewhere. No compile/build step to learn. |
| Web framework | **Express** | Tiny, boring, extremely well-documented. |
| Frontend | **Plain HTML + CSS + vanilla JS**, served by the same Express app | One service to deploy, no bundler, no React toolchain. The owner can open a file and mostly read it. |
| Database | **SQLite** (via `better-sqlite3`) stored on a **persistent disk** | Your entire database is ONE file. Backup = download the file. No separate database server to run or pay for. |
| Job runner | **In-process queue**, one job at a time, tracked in a `jobs` table | No Redis, no second service. An always-on server can run a multi-minute job directly. See job-durability rules below. |
| Hosting | **Render.com** (Railway.com as backup) | Friendly web dashboard (not CLI-only), stays always-on so long jobs finish, supports a persistent disk. This is the thing Vercel could not do. |
| Login | **Single admin password** in an environment variable + a signed session cookie | Simplest possible gate for a one-person tool on a public URL. |
| Google access | **A brand-new dedicated Google service account** | Isolated from the dashboard. Uses Sheets API + Drive API (read) to start. |

**Explicitly rejected for v1 (to keep it simple):** TypeScript, React/Next.js, Postgres, Redis/BullMQ, Docker, Kubernetes, Cloud Run, multi-user auth, Google OAuth login. Each is noted below as a *future upgrade path* only.

### 3.1 Hosting reality check (important — don't skip)
- **Render's free tier sleeps** after inactivity and can be killed/restarted at any time. A sleeping or recycled instance will **kill a long 55-sheet job mid-run** and lose in-memory job state. For jobs to reliably finish you need a **paid always-on instance** (Render's cheapest paid web service, roughly ~$7/month at time of writing) **plus a small persistent disk** for the SQLite file. Budget for this from the start; the "free tier" is only adequate for the earliest local-style poking, not for real folder-wide runs.
- **The database must live on the persistent disk**, not the ephemeral container filesystem, or run history is lost on every deploy/restart.

### 3.2 Job durability (design the queue for restarts)
Because the job runner is in-process, a deploy, crash, or host restart can interrupt a running job. Design for it:
- On server startup, scan the `jobs` table for any job still marked `running` and mark it `interrupted` (a terminal, non-success state). Never leave a zombie `running` job that blocks the queue forever.
- A `live` job that was interrupted must be **safe to inspect and safe to re-run** — this is why every write is idempotent-by-design (fill-blank / append-if-absent / join-by-id; see 4.7 and Section 5). Re-running a partially-completed live push should converge, not double-write.
- Persist progress **as you go** (per-spreadsheet counts in `jobs.progress_json`), so an interrupted run still shows how far it got.

### Upgrade paths (do NOT build these now — just don't paint into a corner)
- **SQLite → Postgres:** keep all DB access behind a thin `db.js` module so the storage engine can be swapped later.
- **In-process queue → Redis/BullMQ:** keep job execution behind a `jobs.js` module with a clear `enqueue()` / `runNext()` boundary.
- **Password login → Google OAuth restricted to one email:** keep auth behind an `auth.js` middleware.

---

## 4. Proven patterns to recreate (learned from the dashboard + the legacy tool)

The zone dashboard and the legacy Apps Script already solved several problems SheetSmart will hit. The building agent does **not** have the dashboard repo, and the legacy Apps Script is a different runtime, so here are the patterns described well enough to rebuild from scratch in Node. These are battle-tested against real Google Sheets flakiness — don't skip them.

### 4.1 Service-account Sheets client (create once, reuse)
Authenticate to Google using a service account JSON credential provided via environment variable, request the Sheets scope, and **cache the client** so you don't re-auth on every call.

```js
// google.js — sketch, not final code
const { google } = require('googleapis');
let cached = null;
function getSheetsClient() {
  if (cached) return cached;
  const credentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8')
  );
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',   // read + write cells/columns
      'https://www.googleapis.com/auth/drive.readonly'  // list files in the captain folder
    ]
  });
  cached = google.sheets({ version: 'v4', auth });
  return cached;
}
```
Store the credential as **base64** in one env var (`GOOGLE_SERVICE_ACCOUNT_JSON_B64`) — it avoids newline/escaping problems when pasting a multi-line JSON key into a hosting dashboard. Also create a Drive client (`google.drive({version:'v3', auth})`) for folder listing.

> Note on Drive scope: `drive.readonly` is enough to *list* the captain folder and read file metadata. Writing cells/columns is done through the **Sheets** API, which only needs the `spreadsheets` scope on sheets the service account has been shared into as Editor. You do not need broad Drive write scope for the current feature set.

### 4.2 Retry with exponential backoff + jitter (REQUIRED)
Google Sheets API returns transient errors (429 rate limit, 503, 500, "backend error", "internal error", "unable to parse range") constantly during bulk work. Wrap **every** Sheets/Drive call in a retry helper:

```js
async function withRetry(fn, { attempts = 4, baseDelayMs = 700 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const code = err.code || (err.response && err.response.status);
      const msg = String(err.message || '').toLowerCase();
      const retryable = [429, 500, 503].includes(code)
        || msg.includes('quota') || msg.includes('rate limit')
        || msg.includes('backend error') || msg.includes('internal error')
        || msg.includes('unavailable') || msg.includes('timeout')
        || msg.includes('unable to parse range');
      if (i >= attempts - 1 || !retryable) throw err;
      const delay = baseDelayMs * (2 ** i) + Math.floor(Math.random() * 250);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
```

### 4.3 Fuzzy column matching (the heart of "column drift")
Captain sheets rename headers constantly (`Last Contact Date` becomes `Last Outreach Attempt Date`, `House #` vs `house #` vs `_SitusHouseNo`, etc.). Never hardcode a single header string. Use an alias list + a fallback matcher, and normalize by lowercasing and stripping non-alphanumerics:

```js
function normalizeKey(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}
function findColumn(headers, aliases, fallbackMatcher) {
  const aliasKeys = aliases.map(normalizeKey);
  return headers.find(h => aliasKeys.includes(normalizeKey(h)))
      || headers.find(h => typeof fallbackMatcher === 'function' && fallbackMatcher(String(h).toLowerCase()))
      || null;
}
// e.g. findColumn(headers, ['resident_id','residentid'], l => l.includes('resident') && l.includes('id'))
```
Because SheetSmart's job is literally to *fix* drift, keep this matching **visible and configurable** — the audit should report which real header it matched to which logical field, so the owner can confirm or correct it rather than trusting a silent guess.

### 4.4 Modular route registration
Keep each area of the app in its own file that exports a `registerXRoutes(app, deps)` function, and inject shared dependencies (the sheets client, the db, the job queue) rather than importing global singletons. This keeps the codebase legible and testable. Suggested modules: `connections`, `workflows`, `audit`, `runs`, `jobs`, `auth`.

### 4.5 A1 range + column-letter helpers
You'll convert between 0-based column indexes and spreadsheet letters (`0→A`, `26→AA`) constantly, and you must quote sheet/tab names that contain spaces (`'My Tab'!A1:Z`). Write small helpers for both and reuse them everywhere.

### 4.6 Text-safe writes (avoid silent data corruption)
Google Sheets `USER_ENTERED` mode will happily turn `1/2` into a date and strip leading zeros from things like zip codes and IDs. For any column that must stay literal text (IDs, `resident_id`, zip, fractional units, APNs), write with `valueInputOption: 'RAW'`. Keep a small set of "text-safe" column names and route those writes to RAW. (Check the legacy code for the current text-safe column list.)

### 4.7 Batch every read and write, and budget your quota (REQUIRED at 55-sheet scale)
Retry (4.2) handles *transient* errors; it does **not** save you from *sustained* rate-limit pressure. At 55 sheets × several calls each, naive per-sheet calls will hit Google's per-minute quotas.
- **Read with `spreadsheets.values.batchGet`** (multiple ranges in one call) and **write with `spreadsheets.values.batchUpdate` / `spreadsheets.batchUpdate`**. Never loop cell-by-cell.
- Google's default quotas are roughly **60 read + 60 write requests per minute per user (service account)** and higher per-project ceilings; treat the per-user number as your real budget. Design a job to make on the order of a handful of calls per spreadsheet, and add a small pause between spreadsheets if needed.
- Prefer **one read of the whole used range** per sheet, compute the full set of changes in memory, then **one batched write** per sheet.

### 4.8 Concurrent human edits — join by identity, never by cached row index (REQUIRED)
Captains edit their sheets live, and a folder-wide job runs for minutes. A row you read at minute 0 may be at a different row index by minute 3 (a captain inserted/deleted rows above it).
- **Never write back using a row index you cached earlier.** Match the target row by its identity key (`resident_id`, or the workflow's match column) at write time.
- For append operations, re-check "is this `resident_id` already present?" against a fresh read, so an interrupted-and-rerun job doesn't append duplicates.
- The fill-blank-only + append-if-absent + join-by-id design (Section 5) is what makes this safe and what makes interrupted live jobs safe to re-run (3.2).

---

## 5. The safety model (NON-NEGOTIABLE — carry over verbatim)

This is the single most important part. SheetSmart edits irreplaceable data across 55 sheets. Every one of these rules from the spec must be enforced in code, not just documented:

1. **Dry run before live run.** Every workflow can produce a full preview of what it *would* do, writing nothing. Live run is a separate, explicit action.
2. **Fill blanks only** by default. Only write into a target cell that is empty, unless a column is explicitly set to an `overwrite` policy.
3. **Never write a blank over a value.** A blank in the source must never erase a value in the target.
4. **Log conflicts, don't resolve them.** When source and target disagree and the policy isn't `overwrite`, record a conflict for manual review instead of overwriting.
5. **`resident_id` is protected.** It is the join key and must never be modified by a workflow (on pull it is always forced to the `never` policy).
6. **Append-only workflows only append.** Row-adding workflows never modify or delete existing rows, and check identity against a fresh read before appending (4.8).
7. **Pull policies:** a column can only be overwritten on pull if explicitly marked `overwrite`. Unlisted columns default to **conflict-only**. Policy vocabulary: `fill_blank`, `overwrite`, `conflict`, `never`.
8. **Sensitive-data flags are informational.** They warn (e.g. before pushing a sensitive field to a captain sheet) but do not block row appends.
9. **Destructive schema ops require explicit confirmation** and must produce detailed dry-run counts first (e.g. "this will delete a column containing 143 non-blank values across 12 sheets").
10. **Everything is logged durably.** For a live run, the run record + its detail rows ARE the permanent audit trail of what happened.

The building agent should implement a single **write-guard layer** that every write passes through, which enforces rules 2–7 centrally, so no individual workflow can accidentally bypass them. **This write-guard is the highest-risk code in the app; it must have unit tests (Section 8.6).**

---

## 6. Data model (SQLite tables)

Translate the spec's entities into SQLite tables. Suggested minimum:

- **connections** — a named reference to a Google spreadsheet, a Drive folder, or an external source. Fields: `id`, `name`, `type` (`master` | `captain_folder` | `external`), `google_id` (spreadsheet or folder ID), `notes`, `created_at`.
- **workflows** — a named operation. Fields: `id`, `name`, `type` (see Section 7 list), `source_connection_id`, `target_connection_id`, `match_column` (varies by workflow — often `resident_id`, sometimes `APN`), `source_tab`, `notes`, `created_at`.
- **column_mappings** — `id`, `workflow_id`, `source_column`, `target_column`.
- **column_policies** — `id`, `workflow_id`, `column_name`, `policy` (`fill_blank`|`overwrite`|`conflict`|`never`).
- **sensitive_columns** — `id`, `column_name` (fields flagged when pushed to captain sheets).
- **runs** — `id`, `workflow_id`, `mode` (`dry`|`live`), `status` (`queued`|`running`|`succeeded`|`failed`|`cancelled`|`interrupted`), `started_at`, `finished_at`, summary counts (JSON blob is fine), `actor`.
- **run_log_entries** — `id`, `run_id`, `spreadsheet`, `row`, `column`, `resident_id`, `type` (`fill`|`overwrite`|`conflict`|`append`|`skip`|`sensitive`|`error`), `existing_value`, `incoming_value`, `message`.
- **conflicts** — a review view derived from `run_log_entries` where `type='conflict'`, plus `status` (`open`|`resolved`) and `resolution_notes`.
- **jobs** — `id`, `run_id`, `status`, `progress_json` (per-spreadsheet counts), `enqueued_at`, `started_at`, `finished_at`, `error`.

Put all DB access behind a `db.js` module. Migrate the existing Apps Script config (`Settings`, `Column Mapping`, `Pull Column Policy`, `Workflow Presets`) into these tables in Phase 1.

---

## 7. The workflows to support

Expose each as a named "card" in the UI (plain-English purpose, required connections, Dry Run button, Live Run button, last-run summary, link to run history, and a warning banner for destructive ones).

> **Fidelity note:** this list mirrors the **12 operations that actually exist in the legacy tool** (see `legacy-appsscript/AGENTS.md`). Most operations come in a **single-sheet** and a **whole-folder** variant — keep both; the single-sheet variant is how the owner safely tests on one sheet before running the folder. **"Add columns" is not its own workflow** — cell-fill and pull operations add missing target columns automatically as their first step.

**Cell-fill syncs (add missing columns, then fill blanks; log conflicts):**
- **Import → Master** — external source (e.g. sales tracker) into master, matched by the configured match column (often APN). *Friendly name: "Update Master From Sales Tracker."*
- **Push → One Captain Sheet** — master into a single captain sheet.
- **Push → Captain Sheets Folder** — master into every captain sheet in the folder. *Friendly name: "Push Dashboard Fields to Captain Sheets."*

**Row appends (append new rows only; never modify/remove existing rows):**
- **Push Missing Residents → One Captain Sheet** — append master rows whose zone matches the sheet's detected zone (mode of `ZoneName`) and whose `resident_id` isn't already present.
- **Push Missing Residents → Captain Sheets Folder** — same, across the folder. Sensitive-column values are flagged (informational).
- **Pull Missing Rows ← One Captain Sheet** — append captain-created rows (by `resident_id`) into master.
- **Pull Missing Rows ← Captain Sheets Folder** — same, across the folder; duplicate `resident_id`s after the first are skipped and logged.

**Pull data (import captain-entered values into master by policy — the only operation allowed to overwrite, and only for `overwrite` columns):**
- **Pull Data ← One Captain Sheet** — update master rows by `resident_id` using column policies.
- **Pull Data ← Captain Sheets Folder** — same, across the folder; duplicate `resident_id`s after the first are skipped and logged.

**Schema operations:**
- **Rename Column Across Captain Sheets** — rename one header (row 1 only) across the folder; data rows untouched.
- **Delete Columns from One Captain Sheet** — destructive; dry-run reports non-blank counts first.
- **Delete Columns from Captain Sheets Folder** — destructive; same, across the folder.

**Read-only Audit:** folder scan, master/captain schema comparison, duplicate `resident_id` detection, missing/extra row detection (by detected zone / `ZoneName`), and completeness summary (respecting the checkbox-vs-blank counting rule from 1.5).

---

## 8. Phased build plan (with definition of done)

Build in this order. **Do not start a phase until the previous phase's "Done when" is true.** After each phase, stop and let the owner test it before continuing.

### Phase 0 — Project skeleton + connect to Google (read-only)
Scope: create the empty Node/Express project, `db.js` with SQLite, the login gate, the Google service-account client, and ONE read-only test endpoint that lists the spreadsheets in the captain folder and reads the master's headers.
**Done when:** the owner can log in with the admin password, open the app, click "Test connection," and see the real master headers + a list of the 55 captain sheet names. Nothing has been written to any sheet.

### Phase 1 — App shell + configuration (no sheet behavior yet)
Scope: Home dashboard shell, Connections screen, Workflow list, Workflow detail pages, column-mapping & policy forms, sensitive-columns list. Import the old Apps Script config into the SQLite tables.
**Done when:** the owner can set up connections and workflows entirely through forms in the app, and that config is saved in the database. Configuration is understandable without touching a spreadsheet. Still no reads/writes of operational data.

### Phase 2 — Audit + Dry Run (reads only, writes NOTHING)
Scope: implement the Audit (schema compare, duplicate `resident_id`, missing/extra rows, completeness) and Dry Run for the core sales loop. Build the durable Run Review screen (summary + filterable/sortable/exportable detail tables) and run history. Wire in the job runner so long audits run as background jobs with progress. **Build the parity harness (8.5).**
**Done when:** the owner can run an audit and a dry run against real data, see a clear review screen, and the dry-run output **matches what the current Apps Script produces on the same data** (verified via the parity harness). Still zero live writes.

### Phase 3 — Core live workflows (first writes, behind the write-guard)
Scope: implement live execution for the daily/weekly loop — Import → Master, Push → Captain Sheets Folder, Push Missing Residents → Folder, Pull Data ← Captain Sheets. All writes go through the Section 5 write-guard. Every live run produces a permanent run record. Interrupted live jobs must be safe to re-run (3.2, 4.8).
**Done when:** the owner can run each of these live on real sheets, the results match expectations, conflicts are logged (not overwritten), and the run record is a complete audit trail. **Test on a COPY first (see Section 9F).**

### Phase 4 — Schema workflows (the destructive ones, last)
Scope: Rename / Delete columns across one or many captain sheets, each with a strong confirmation screen and a dry-run preview that shows non-blank counts before anything is touched. (Remember: adding columns is not a separate workflow — it already happens inside the syncs.)
**Done when:** the owner cannot delete or rename a column without first seeing an accurate impact count and explicitly confirming, and every schema change is logged.

### Phase 5 — Retire the old Apps Script tool
Scope: freeze the old config spreadsheet as read-only legacy, keep the Apps Script around only as an emergency fallback for a defined period, update the operating docs.
**Done when:** SheetSmart is the single place to configure, run, and review all operations, and the owner trusts it enough to stop using the spreadsheet UI.

### 8.5 The parity harness (build this in Phase 2 — it is how you prove correctness)
"Match the old output" must be mechanical, not eyeballed, because the owner can't verify it by reading code.
- Before building the port, capture **golden reference outputs** from the legacy tool: run the current audit and a dry run of each core workflow against a **fixed, frozen copy** of the master + a handful of captain sheets, and save the resulting reports (export the report tabs to CSV/JSON and commit them to the repo under `test/golden/`).
- The new tool's dry run, pointed at the *same frozen copies*, must produce the same set of proposed fills, conflicts, appended rows, skips, and counts. Write a diff step that fails loudly on any divergence.
- Keep the frozen test copies' IDs in config so anyone can re-run parity later. This harness is also your regression safety net for Phases 3–4.

### 8.6 Automated tests (minimum bar — this tool edits irreplaceable data)
Even without TypeScript, add `node:test` (built-in) unit tests for the two highest-risk pieces:
- **The write-guard:** blank never overwrites a value; conflicts are logged not written; only `overwrite`-policy columns replace non-blank values; `resident_id` is never written; append checks identity against a fresh read.
- **The column matcher (`findColumn`/`normalizeKey`):** known alias sets resolve to the right header; ambiguous/missing headers are reported, not silently guessed.
These tests plus the parity harness (8.5) are the difference between "seems to work" and "safe to run on 55 irreplaceable sheets."

---

## 9. The owner's checklist (things only YOU can do)

These are tasks the AI cannot do for you because they need accounts, a browser, a credit card, or your personal identity. Do them roughly in this order. Hand the outputs (keys, IDs) to the building agent when it asks. Treat every key like a password.

### A. Google Cloud setup (needed for Phase 0)
1. Go to <https://console.cloud.google.com> and sign in with the Google account that owns/administers the sheets.
2. Create a new project (top bar → project dropdown → "New Project"). Name it something like `sheetsmart`. Wait for it to finish creating, then select it.
3. Enable two APIs: search the top bar for "Google Sheets API" → **Enable**; then "Google Drive API" → **Enable**.
4. Create a **service account**: left menu → "APIs & Services" → "Credentials" → "Create Credentials" → "Service account." Name it `sheetsmart-bot`. Skip the optional role steps → Done.
5. Open the new service account → "Keys" tab → "Add Key" → "Create new key" → **JSON** → Create. A `.json` file downloads. **This file is a password to your data. Keep it safe. Do not email it or commit it anywhere.**
6. Open that JSON file in a text editor and copy the value of `client_email` (looks like `sheetsmart-bot@sheetsmart-....iam.gserviceaccount.com`). You'll need it in step B.
7. Hand the JSON key to the building agent when it sets up Phase 0. **Preferred:** save the file locally and let the agent read it into a local `.env` file (which is git-ignored — see Section 10), or do the base64 conversion yourself and give it only the resulting one line. Avoid pasting the raw private key into the chat if a file drop will do. The agent will tell you exactly where the base64 value goes (`GOOGLE_SERVICE_ACCOUNT_JSON_B64`).

### B. Share your sheets with the bot (needed for Phase 0)
8. Open the **master** spreadsheet in Google Sheets → Share → paste the `client_email` from step A6 → give it **Editor** → Send.
9. Open the Google Drive **folder** that contains all ~55 captain sheets → Share → same `client_email` → **Editor** → Send. (Sharing the folder shares everything inside it.)
10. Do the same for the **sales tracker** / any external source spreadsheet.
11. Collect these IDs and give them to the agent (it will tell you where they go):
    - Master spreadsheet ID — from its URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
    - Captain folder ID — from the folder URL: `drive.google.com/drive/folders/`**`THIS_PART`**
    - Sales tracker spreadsheet ID — same as the master pattern.

### C. Pick a login password (needed for Phase 0)
12. Choose a strong admin password for the app itself (this is what stops strangers from opening SheetSmart on its public URL). Save it in your password manager. You'll give it to the agent to set as the `ADMIN_PASSWORD` env var.

### D. Hosting account (needed before Phase 2/3 go online; local testing works without it)
13. Create an account at <https://render.com> (sign in with GitHub is easiest — see step E). **Plan for the paid always-on web service (~$7/mo) plus a small persistent disk add-on**, not the free tier — the free tier sleeps and will kill long folder-wide jobs (see Section 3.1). The agent will walk you through enabling the persistent disk for the SQLite database file.
14. When the agent is ready to deploy, it will tell you exactly which buttons to click in Render and which environment variables to paste (the base64 Google key, the sheet IDs, and the admin password).

### E. GitHub account (recommended, makes deploying push-button)
15. Create an account at <https://github.com> if you don't have one. The agent will put the project code in a **private** repository. Render deploys automatically from it. You don't need to understand git — the agent will handle the commands and tell you if it ever needs you to click something.

### F. A safety net before ANY live writes (do this before Phase 3)
16. **Make a full copy of the master and a couple of captain sheets** (File → Make a copy). These same frozen copies double as the parity-harness fixtures (8.5). Point SheetSmart at the copies for the first live-write tests. Only switch to the real sheets once the copies behave correctly.
17. Confirm you know how to use Google Sheets **version history** (File → Version history) to roll back a sheet if something goes wrong. This is your undo button.

### Ongoing (once it's live)
18. **Back up the database** occasionally by downloading the SQLite file from Render (the agent will show you how — it's one file).
19. Keep the service-account JSON key and the admin password in your password manager. If either ever leaks, tell the agent — rotating them is quick.

---

## 10. Guardrails for the building agent

- **Do not build inside the zone dashboard repo, and do not build inside the legacy `Sheet Smart` folder.** Fresh repo only. This brief folder is documentation, not the app.
- **Treat `legacy-appsscript/` as read-only reference.** It is the behavioral source of truth; port from it, don't edit it, don't run it.
- **Do not write to any Google Sheet before Phase 3**, and when you do, route every write through the Section 5 write-guard.
- **Default to dry-run everywhere.** A live write must always be a separate, explicit, confirmed action.
- **Stop and ask** whenever a decision needs the owner's real-world knowledge (which sheet is the master, whether a column is safe to delete, whether to overwrite). Present choices in plain English.
- **Explain before you require action.** Any time the owner must touch an account, key, or setting, give numbered click-by-click steps and wait.
- **Keep storage, jobs, and auth behind thin modules** (`db.js`, `jobs.js`, `auth.js`) so the documented upgrade paths stay open.
- **Batch all reads/writes and respect quotas** (4.7); **join by identity, never cached row index** (4.8).
- **Match the old Apps Script output** on real data via the parity harness (8.5) before trusting any live write.
- **Never commit secrets.** The `.gitignore` in this folder already excludes `.env`, `*.json` keys, and `*.sqlite`. Never log full secrets — print the service-account `client_email` for confirmation, never the private key.

---

## 11. Quick-start for the returning agent (TL;DR)

If you're the agent picking this up cold, do this in order:
1. Read this file top to bottom.
2. Read `legacy-appsscript/AGENTS.md`, then skim `MergeEngine.gs` and `Code.gs` to see the real logic.
3. Read `WEB_APP_MIGRATION_SPEC.md` for product intent.
4. Confirm with the owner which items in Section 9 are already done (service account? sheets shared? Render account?).
5. Start Phase 0. Do not skip the "Done when" gates. Do not write to a real sheet before Phase 3.

---

## 12. Glossary (for the owner)

- **Service account** — a "robot" Google account with its own email. You share sheets with it so the app can read/write them without logging in as you. Its JSON key file is effectively its password.
- **API** — a way for one program to talk to another. "Enabling the Sheets API" just turns on permission for your app to use Google Sheets programmatically.
- **Scope** — the specific permission an app is granted, e.g. "read spreadsheets" vs "read and write spreadsheets." SheetSmart requests only what it needs.
- **Environment variable (env var)** — a setting (like a password or a key) you store in the hosting dashboard instead of in the code, so secrets never live in the source files. You'll paste a few of these into Render.
- **base64** — a way of turning a multi-line file (like the Google key) into one long line of text so it pastes cleanly into an env var. The agent handles the conversion.
- **SQLite** — a whole database that lives in a single file. Simple to back up (just copy the file).
- **Persistent disk** — normal cloud servers forget files when they restart; a persistent disk is storage that survives restarts, so your database file (and run history) isn't lost.
- **Job runner / job / queue** — some operations touch 55 sheets and take minutes. Instead of freezing the browser, the app hands the work to a background "job" and shows you progress. The "queue" is the line of jobs waiting to run.
- **Dry run** — a full preview of what a workflow *would* change, without changing anything. Your primary safety tool.
- **Live run** — actually applying the changes to the real sheets.
- **Parity harness** — an automated check that the new tool produces the same results as the old Apps Script on the same frozen test data, so you can trust the port.
- **Deploy** — publishing the app to the internet so you can use it from a URL (via Render).
- **Repository (repo)** — the folder of code, stored on GitHub. Keep it **private**.
- **Rotate (a key/password)** — replace a secret with a new one, e.g. if it leaks. Quick to do.

---

*End of handoff. This file lives outside the zone dashboard repo and outside the legacy `Sheet Smart` folder on purpose. Everything the next agent needs is in this folder: this plan, the product spec, and the working legacy code under `legacy-appsscript/`.*

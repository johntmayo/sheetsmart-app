# SheetSmart — Phase A Handoff & Continuation Prompt

**Written:** after Phase A was built and verified against the real Google account.
**Purpose:** (1) document exactly what changed in Phase A, and (2) give the next
agent a ready-to-paste prompt to continue.

**Read order for a fresh agent:** `SHEETSMART_VISION_AND_ROADMAP.md` (north star)
→ this file → `app/README.md` → `legacy-appsscript/AGENTS.md` (behavioral truth).

---

## 1. What Phase A delivered

Phase A was the "foundation & UX reset" from the roadmap (§7). Goal:
*the Operator can define Sources and the Field Dictionary in a UI that already
feels like the realized app.* Done and verified.

### 1.1 Modern frontend (React + Vite + TypeScript)
- Lives in **`app/web/`**. Builds to `app/web/dist/`, served as static files by
  the **same** Express server (no second service). `src/server.js` serves
  `web/dist` if present, else falls back to the legacy `public/` UI.
- Dev workflow: `npm run web:dev` (Vite on :5173, proxies `/api` → :3000).
- Design system ported verbatim from `ALTAGETHER_Support Tool Style Guide.md`
  into `web/src/styles/app.css` (CSS variables + component classes).
- Structure:
  - `web/src/App.tsx` — auth gate + router + shell (header, nav).
  - `web/src/pages/` — `Login`, `Dashboard` (Health), `Sources`,
    `FieldDictionary`, `Workflows` (Playbooks placeholder), `Runs`, `Conflicts`.
  - `web/src/components/` — `Toast`, and `ui.tsx` (`Modal`, `StatusPill`,
    `PolicyPill`, `SectionHead`, `Spinner`, `EmptyState`, `ErrorState`).
  - `web/src/lib/` — `api.ts` (typed client), `types.ts` (API contract),
    `useAsync.ts` (load/reload hook).
- Nav reframed around **goals** (roadmap §4/§9.5): Health · Sources · Field
  Dictionary · Playbooks · Runs · Conflicts.

### 1.2 The Field Dictionary (roadmap §5.1 — the centerpiece)
- **DB:** two new tables in `src/db.js` — `dictionary_fields` (canonical_name,
  data_type, is_identity, is_sensitive, is_text_safe, default_policy, notes,
  sort_order) and `dictionary_aliases` (field_id, alias).
- **Seed:** `src/dictionarySeed.js` seeds all **52 master fields** (Appendix A)
  on first run *only if the table is empty* (never clobbers Operator edits).
  Seed facts: `resident_id` = identity + policy `never`; the two documented
  checkbox fields as `checkbox`; text-safe = APN/resident_id/address_id/Zip/
  _SitusUnit; sensitive = the clear contact PII; known drift aliases for high-
  churn fields. **These are editable defaults, not locks.**
- **API:** `src/routes/dictionary.routes.js` — full CRUD, registered in
  `server.js`. `GET/POST/PUT/DELETE /api/dictionary`, aliases saved via the
  `aliases` array on the field body.
- **UI:** `web/src/pages/FieldDictionary.tsx` — searchable table, summary
  metrics, add/edit/remove modal for every attribute.

### 1.3 Other Phase A changes
- `src/routes/status.routes.js` now returns `dictionaryFields` and
  `sensitiveFields` counts; the Health dashboard shows them.
- `app/package.json` scripts: `build:web`, `web:dev`.
- `app/README.md` updated (build step, dev workflow, project layout).

### 1.4 Verified
- 21/21 backend unit tests still pass (`npm test`).
- Live round-trip confirmed: new UI → backend → Google Sheets API returns the
  master's 52 headers and lists the 120 captain sheets.
- Service account `sheetsmart-bot@sheetsmart-503108.iam.gserviceaccount.com`;
  connections registered (master, captain_folder = 120 sheets, sales tracker).

### 1.5 Deliberately deferred → now DONE (Decision B complete)
- **Backend/engine TypeScript migration (Decision B). ✅ Completed.** The whole
  backend — the tested engine (`src/lib/**`), the core modules (`config`, `db`,
  `auth`, `google`, `jobs`, `dictionarySeed`, `server`), and every route in
  `src/routes/**` — is now TypeScript, with all 21 safety tests still green.
  Source lives in `src/*.ts`, type-checks with `npm run typecheck`, compiles to
  `dist/` with `npm run build`, and runs as compiled JS in production
  (`npm start` → `node dist/server.js`). Dev uses `npm run dev` (`tsx watch`);
  tests run via `tsx`. Toolchain: TypeScript 5.x (pinned for stability),
  CommonJS output, `strict` mode. See `app/README.md` for the workflow.

---

## 2. How to run it

```bash
cd app
npm install            # backend deps (first time)
npm run build:web      # installs web deps + builds app/web -> app/web/dist
npm start              # API + UI at http://localhost:3000
```
Local admin password is in `app/.env` (`ADMIN_PASSWORD`). The Google key and
sheet IDs are already configured in `.env` and the DB.

Windows note: this is PowerShell. To free port 3000 before restarting:
`Get-NetTCPConnection -LocalPort 3000 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }`

---

## 3. Non-negotiables the next agent must preserve

From `SHEETSMART_BUILD_HANDOFF.md` §5 and the roadmap §1 (the "soul"):
1. **Dry run before live.** Live writes are always separate, explicit, confirmed.
2. **Fill blanks only; never write blank over a value; log conflicts, don't
   resolve them.** All writes go through `src/lib/writeGuard.js` (tested).
3. **`resident_id` is sacred** (always `never`).
4. **Everything is logged durably** (runs = permanent audit trail).
5. **No writes to any real sheet before the "first writes" phase**, and test on
   COPIES first (handoff §9F). `legacy-appsscript/` is read-only reference.
6. **Batch reads/writes, retry w/ backoff, join by identity not row index**
   (handoff 4.2/4.7/4.8).

---

## 4. Recommended next steps (in order)

1. **Backend/engine → TypeScript (Decision B). ✅ Done** (see §1.5). The engine
   `src/lib/**` was converted first (pure, tested), then the core modules and the
   whole API, keeping all 21 tests green. Build/run steps added (`npm run build`
   / `typecheck` / `dev`). This finishes the six-month-handoff goal (Principle 8).
   The next follow-up is Phase B.
2. **Phase B — Health & Preview (read-only, high value, zero writes):**
   - Ambient **Health** metrics matching legacy `Code.gs` counting rules: column
     drift vs. master, duplicate `resident_id`, missing/extra rows by *detected*
     zone (mode of `ZoneName`, see `src/lib/columns.js`), completeness
     (checkbox `=== true` vs non-blank distinction).
   - **Preview (dry run)** for the core sync playbooks with plain-language impact
     summaries, driven by the Field Dictionary for matching.
   - **Build the parity harness** — capture golden outputs from the legacy tool
     on frozen copies, diff the new dry-run output, fail loudly on divergence
     (handoff §8.5). This must exist before any live write.
3. **Phase C — Safe execution + Undo:** live runs behind the write-guard, with
   pre-write snapshots + one-click revert, and the approval-based Conflict Inbox.

Everything should trend toward the north star: a continuously-reconciling,
approval-gated, fully-reversible data backbone (roadmap §9.5).

---

## 5. Copy-paste prompt for the next agent

> You are continuing work on **SheetSmart**, a standalone admin web app that keeps
> ~120 Google "captain" spreadsheets aligned with one master resident dataset for
> a post-fire recovery outreach in Altadena. The app is in `app/` (Node/Express +
> SQLite backend; React + Vite + TypeScript frontend in `app/web/`).
>
> **Get up to speed first, in this order:** `SHEETSMART_VISION_AND_ROADMAP.md`
> (north star), `SHEETSMART_PHASE_A_HANDOFF.md` (what's built + how to run),
> `app/README.md`, and `legacy-appsscript/AGENTS.md` (the behavioral source of
> truth — the legacy code decides exact behavior; port, don't guess).
>
> **Current state:** Phase 0 (connect) and Phase A (modern TS frontend + design
> system + Sources + the Field Dictionary seeded from the master's 52 fields) are
> complete and verified against the real Google account. 21/21 backend safety
> tests pass. Nothing writes to any Google sheet yet.
>
> **Run it:** `cd app; npm run build:web; npm run build; npm start` →
> http://localhost:3000 (admin password in `app/.env`). Backend is now
> TypeScript (`npm run dev` for hot-reload; `npm test` / `npm run typecheck`).
> Shell is Windows PowerShell.
>
> **Hard rules (never violate):** dry-run before live; fill blanks only; never
> write a blank over a value; log conflicts instead of overwriting; `resident_id`
> is never written; all writes go through `src/lib/writeGuard.ts`; no writes to
> real sheets before the live phase and only on COPIES first; treat
> `legacy-appsscript/` as read-only reference.
>
> **Your task (confirm with me before large moves):** [PICK ONE]
> (a) ✅ DONE — the backend engine `src/lib/**` and the whole API were migrated
>     to TypeScript with all 21 tests green (Decision B; see §1.5). Nothing to do
>     here unless extending the types.
> (b) Start **Phase B**: build the read-only Health dashboard (audit metrics
>     matching legacy `Code.gs` counting rules — drift, duplicate `resident_id`,
>     missing/extra rows by detected zone, completeness), the dry-run **Preview**
>     for core sync playbooks driven by the Field Dictionary, and the **parity
>     harness** that diffs new dry-run output against legacy golden outputs on
>     frozen copies. Zero writes.
>
> Work in small, verifiable steps; keep the app runnable; take a screenshot of any
> UI you build; and stop to ask me whenever a decision needs my real-world
> knowledge (which sheet, whether a column is safe, etc.).

---

*End of Phase A handoff.*

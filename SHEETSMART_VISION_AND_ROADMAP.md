# SheetSmart — Vision & Roadmap (the "realized version")

> **Status:** Phase 0 **and Phase A are complete** and verified against the real
> Google account (see `app/` and the "Where we are today" section below). This
> document is the *north star* for evolving SheetSmart from a faithful port of
> the legacy Apps Script tool into the thoughtful, best-in-class version of the
> same idea.
>
> **How to read this:** if you are a fresh AI agent or the returning owner,
> read this doc first, then `SHEETSMART_BUILD_HANDOFF.md` (architecture + safety
> model, still authoritative on *behavior*), then `app/README.md` (what is built
> and how to run it). The legacy code in `legacy-appsscript/` remains the
> behavioral source of truth for the underlying sync/audit operations.
> For the **upstream lifecycle** (assigning zones + generating the captain
> sheets — new functionality, see §5.7), read `ZONE_PIPELINE_SPEC.md`; its
> behavioral source of truth is the working code in `reference-tools/`.
>
> **Precedence:** this doc wins on *product vision, UX, and direction*. The
> handoff still wins on the *safety model* and the *exact merge behavior*. When
> in doubt about what an operation actually does, the legacy code decides.

---

## 0. Why this document exists

We built the "apified spreadsheet" faithfully: connections, the 12 legacy
operations, the write-guard, dry-run-first safety, a job runner, and a durable
audit trail. That was the right first move — it proves the plumbing and locks in
the safety model.

But the goal was never "the same tool with a web coat of paint." The goal is the
**true, thoughtful, robust realization** of the *purpose* behind the tool, built
with modern thinking about how software like this should feel and behave — while
staying honest about the context:

- The primary operator is **one person who is not a developer**.
- It exists to support a **non-profit community-organizing effort** — post-fire
  recovery outreach in Altadena — run by **~170 volunteers**.
- It is **not** an enterprise data platform. Operational simplicity, low cost,
  and legibility are features, not compromises.

The soul of the app must survive. The scaffolding around it should be rethought.

---

## 1. The soul (what must never be lost)

Everything below is negotiable *except* this. These are the invariants:

1. **One master, many working copies.** There is a single canonical resident
   dataset (the master). Captain sheets are working copies that drift. External
   sources (e.g. the sales tracker) feed the master. The whole point is keeping
   them honestly aligned.
2. **Never silently destroy data.** Fill blanks, append missing rows, and **log
   conflicts for a human** instead of overwriting. `resident_id` is sacred.
3. **Preview before you touch anything.** Every change is previewable as a dry
   run; a live write is always a separate, deliberate, confirmed act.
4. **Everything that happens is remembered.** Each run is a durable, readable
   record of exactly what changed (or would change) and why.
5. **The operator stays in control and informed.** The tool explains itself in
   plain language and never asks the user to trust a silent guess.

If a redesign ever tempts us to weaken one of these for convenience, stop.

---

## 2. Who this is really for

Designing well means being honest about the humans involved.

- **The Operator (primary user).** One admin. "Knows enough to be dangerous,"
  not a developer. Wants to feel *confident and unhurried*, not clever. Success
  = "I understood what was about to happen, I did it, and I can see it worked."
- **The Captains (~170 volunteers, indirect).** They live in their own
  spreadsheets and never (today) touch SheetSmart. But their behavior *is* the
  problem the tool solves: they rename columns, add rows, and enter data
  unevenly. The tool should treat captain drift as *expected and manageable*,
  not as errors to be scolded for. (Whether captains ever get a read-only view
  or notifications is an **open question** — see §9, not an assumption.)
- **The Residents (ultimate beneficiaries).** Their data is sensitive and
  irreplaceable. Privacy and accuracy are moral obligations, not features. This
  is why "calm, precise, non-playful" handling of data matters (per the style
  guide) and why sensitive-column flagging exists.

Design tension to hold: **maximum trust and clarity for the Operator, minimum
operational burden, zero risk to resident data.**

---

## 3. Design principles for the realized version

These resolve the "best-in-class *but not* enterprise" tension.

1. **Simple to operate, sophisticated inside.** One deployable service, one
   database file, push-button deploy. Spend the complexity budget on the
   *interface and the safety*, not on infrastructure.
2. **Goals, not operations.** Reframe the UI around what the Operator is trying
   to accomplish ("get everyone the latest data," "bring in what captains
   added," "check that everything lines up") — not around 12 cryptically-named
   merge functions. The operations become the *engine*; guided playbooks become
   the *interface*.
3. **The tool teaches its own mental model.** A first-time operator should be
   able to learn how SheetSmart thinks by using it. Show the master ↔ captain ↔
   source relationships visually.
4. **Progressive disclosure.** Safe, obvious defaults on top; full control
   (policies, mappings, per-column behavior) one layer down for when it's
   needed.
5. **Trust is the product.** Preview, explain, confirm, record, and — the big
   upgrade — **make undo real** (see §5.3). A non-developer should never feel
   they're one wrong click from an irreversible mistake.
6. **Plain, warm, civic language.** Follow the Altagether style guide. Write
   like a capable neighbor. Errors explain *what happened and how to fix it*.
7. **Correctness is verifiable, not asserted.** Keep the tested write-guard and
   the parity-harness discipline (diff against known-good outputs) so "safe" is
   demonstrable, not a promise.
8. **Legible to a future maintainer.** The Operator's own words: this must be
   "something that could be handed off to someone who's not me in six months."
   That means a conventional, recognizable stack; typed safety-critical code;
   real tests; and docs that explain *why*, not just *what*. Cleverness that only
   the original author understands is a bug.

---

## 4. A cleaner conceptual model

The legacy tool has ~12 operations, four config tabs, and many output tabs. The
realized version should expose **six clear concepts**, and nothing more, to the
Operator:

1. **Sources** — the master, the captain folder, and external feeds. (Today's
   "Connections.")
2. **The Field Dictionary** *(new, centerpiece — see §5.1)* — the canonical list
   of logical fields (e.g. `resident_id`, `Resident Name`, `APN`, `ZoneName`),
   each with its aliases, type (text/number/date/checkbox), sensitivity flag,
   and protection rules. This is where "column drift" stops being a recurring
   fire and becomes a managed mapping.
3. **Playbooks** — the guided, plain-language tasks the Operator runs (which map
   onto the legacy operations underneath). See §5.2.
4. **Previews & Runs** — every playbook produces a preview (dry run) and, when
   confirmed, a run (live), each a permanent, readable record.
5. **The Conflict Inbox** — disagreements the tool refused to resolve on its
   own, presented as a triage queue, not buried in a log tab.
6. **Health** — an at-a-glance, always-current picture of alignment: drift,
   duplicates, missing/extra rows, completeness, and "when did we last sync?"

Everything the legacy tool does still exists; it's just organized around how a
human actually thinks about the job.

---

## 5. The key upgrades over the "homunculus"

### 5.1 The Field Dictionary (turn drift from a bug into a managed fact)
Today, column matching is a clever fuzzy function buried in code
(`lib/columns.js`). Elevate it to a **first-class, Operator-visible feature**:

- Define each **logical field** once: canonical name, known aliases, data type,
  whether it's an identity key (`resident_id`), whether it's sensitive, and its
  default sync policy.
- When SheetSmart reads a captain sheet, it shows **"this real header → this
  logical field (matched by alias / by fuzzy rule / unmatched)"** and lets the
  Operator confirm or correct — instead of trusting a silent guess (handoff
  4.3). Corrections become new aliases, so the tool *learns the drift*.
- The audit and every sync consume the dictionary, so behavior is consistent and
  explainable everywhere.

This single idea addresses the root cause the whole tool exists to fight.

### 5.2 Playbooks (guided goals instead of raw operations)
Wrap the legacy operations in plain-language, step-through flows. Illustrative
mapping (names are for the Operator; engine ops in parentheses):

- **"Push the latest master data to captains"** (push → folder, cell-fill)
- **"Bring in what captains have added"** (pull missing rows / pull data ←
  folder, by policy)
- **"Add new residents to the right captain sheets"** (push missing residents by
  detected zone)
- **"Pull in the newest sales data"** (import → master from the sales tracker)
- **"Check alignment"** (the read-only audit)
- **"Fix a column everywhere"** / **"Retire a column"** (rename / delete — the
  destructive ones, gated hard)

Each playbook: states its purpose, shows required sources, runs a preview, shows
an *impact summary in plain language* ("This will fill 214 blanks across 58
sheets, add 3 new columns, and flag 7 conflicts — nothing will be overwritten"),
then requires an explicit confirm for the live run. Single-sheet variants remain
as the "try it on one sheet first" safety ramp.

### 5.3 Real undo / snapshots (the biggest trust upgrade)
Relying only on Google's version history is a weak safety net for a non-dev.
Add SheetSmart-owned safety:

- Before any live write, **snapshot the exact ranges about to change** (values +
  the target row identities) into the database, attached to the run.
- Offer **one-click "revert this run"** that restores those cells by identity
  (`resident_id`), safe even if captains edited in between (write-guard applies
  in reverse).
- Keep leaning on the idempotent design (fill-blank / append-if-absent /
  join-by-identity) so re-running is always safe (handoff 3.2, 4.8).

This turns "I'm scared to click Live" into "I can always take it back."

### 5.4 Health as a living dashboard (not a report you generate)
The legacy audit produces an 8-tab spreadsheet on demand. Instead, make health
**ambient**: a home screen that always shows current alignment (last audit,
drift hotspots, duplicate IDs, missing/extra rows by zone, completeness),
refreshed on a schedule or a click, with drill-downs. The generated spreadsheet
export can remain as an *option*, not the primary surface.

### 5.5 The Conflict Inbox
Promote conflicts from log rows to a **triage queue**: each item shows the
resident, the sheet, the field, both values, and offers "keep master / take
captain / note & dismiss." (Applying a resolution is an *optional* future
capability — see open questions — but even review-only is a big improvement.)

### 5.6 Explain-it (optional, modern, high-leverage)
Because this is an AI-built tool for a non-developer, consider light,
*grounded* AI assistance: "explain what this run did in a sentence," "summarize
this conflict," "what does this column mean?" Strictly optional, never in the
write path, always over data the tool already computed. Flag as a later
enhancement, not a core dependency.

### 5.7 The upstream lifecycle: zone assignment & captain-sheet generation (new)
Full design: **`ZONE_PIPELINE_SPEC.md`**. Working reference code:
`reference-tools/`. Two capabilities that today live *outside* SheetSmart (a
Chrome extension + a bound Apps Script + a manual sort-and-copy) should be
absorbed, because they are the *upstream half of the same reconciliation
mission* — and both slot cleanly into this vision rather than bolting on:

- **Assign / reconcile zones + captain info (Workflow A).** For each resident,
  use their `Latitude`/`Longitude` and ~120 Mapbox zone polygons
  (point-in-polygon) to set `ZoneName`, `NC Name`, `NC Phone`, `NC Email`.
  Crucially, **all six of these are already canonical fields** (master schema /
  Field Dictionary, Appendix A) — so this is not a new import, it's
  **reconciliation of derived fields**: an ambient **Health** check ("N
  residents unzoned; M would change zone; K missing coordinates") and an
  approval-gated **Playbook**, written through the same `writeGuard` + snapshot/
  undo path as everything else. The geometry is deterministic pure code that
  ports almost verbatim into a tested `lib/zoneEngine.ts` — the lowest-risk new
  code in the project.
- **Generate / publish captain sheets by zone (Workflow B).** Create one
  spreadsheet per zone from the zone-current master, preserving dropdowns/
  checkboxes, into the captain folder. This is the **first concrete form of
  "publish a projection outward"** — the exact motion the system-of-record
  trajectory needs (§9.5.3). It is higher-risk (bulk Drive file creation,
  elevated Drive scope, a file-ownership decision) and **feeds the live Zone
  Dashboard**, so it is gated like the destructive schema ops.

*Reconciliation, not a one-off import:* zoning is something the backbone should
**watch and keep true continuously** (drift when zones are redrawn or residents
are added), surfacing proposed corrections for approval — squarely the §9.5
model. See `ZONE_PIPELINE_SPEC.md` for the write policy (recompute-with-approval
vs. fill-blank), the auth/ownership gotcha, and the open questions (notably:
captain contact currently lives in Mapbox properties and probably wants to
become a first-class "zone roster" the tool owns).

---

## 6. Architecture direction & the big decisions

The original handoff (§3) deliberately chose the *simplest possible* stack
(vanilla JS, Express, SQLite, no TypeScript, no framework) to minimize what a
non-developer must maintain. That was wise for a faithful port. "Best-in-class
modern thinking" now pushes on a few of those choices. **These are decisions to
make consciously with the Operator — not to flip silently.**

**Keep (operational simplicity is the point):**
- **One Node service** that serves both API and UI. No microservices.
- **SQLite on a persistent disk**, behind `db.js`. Backup = copy one file.
- **In-process job queue** behind `jobs.js`. No Redis.
- **Single-admin password auth** behind `auth.js` (OAuth is a later option).
- **Render.com single always-on instance + small disk.** Push-button deploy.
- **The tested write-guard and the parity-harness discipline.**

**Reconsider (spend complexity here, where it buys UX/safety):**
- **Decision A — Frontend framework.** The hand-rolled vanilla SPA got us here
  but won't scale to the richer, guided UX above without becoming hard to
  maintain. *Recommendation:* adopt a lightweight modern component framework
  (e.g. **Svelte/SvelteKit** or **React + Vite**) that still builds to static
  files served by the same Express app — no separate deploy. This is the single
  biggest lever for the "realized" feel. Tradeoff: a build step the Operator
  doesn't strictly need to understand (we automate it).
- **Decision B — TypeScript for the safety-critical core.** The handoff rejected
  TS for simplicity. But this tool mutates irreplaceable data; types are a cheap
  correctness win in the engine (`writeGuard`, `mergeEngine`, `columns`).
  *Recommendation:* adopt TypeScript at least for `src/lib/**` and the API, keep
  it approachable. Tradeoff: a compile step.
- **Decision C — How far to push "ambient health" and scheduling.** Scheduled
  audits + email summaries add always-on expectations. *Recommendation:* start
  on-demand; add scheduling once the core is trusted.

If the Operator prefers to preserve maximum "I can open a file and read it,"
we can stay vanilla and invest the UX effort in structure and components-by-
convention instead. **This is a real fork; decide it early (§10).**

---

## 7. Phased roadmap (building on Phase 0)

Re-cast toward the vision. Each phase ends at a gate the Operator can test.
Nothing writes to a real sheet before the "first writes" phase, and copies are
used first.

- **✅ Phase 0 — Connect (done).** Read-only: auth, service account, list the
  folder, read master headers. Verified against the real account.

- **✅ Phase A — Foundation & UX reset (done).** Modern frontend shell
  (React + Vite + TypeScript) + the Altagether design system, served by the same
  Express app. Sources rebuilt in the new shell. The **Field Dictionary** data
  model + CRUD API + UI, seeded from the real master's 52 fields (Appendix A). No
  behavior change. Verified against the real account. *(Backend/engine TypeScript
  migration — Decision B — was intentionally deferred as a focused follow-up so
  the tested JS engine wasn't put at risk mid-build.)*

- **Phase B — Health & Preview (read-only, high value early).** Build the
  ambient **Health** dashboard (audit metrics: drift, duplicates, missing/extra
  by zone, completeness — matching legacy `Code.gs` counting rules) and the
  **Preview** experience for the core sync playbooks, with plain-language impact
  summaries. **Build the parity harness** (diff against legacy output on frozen
  copies). *Zone pipeline (§5.7):* also build the pure, tested `lib/zoneEngine.ts`
  (point-in-polygon, ported from `reference-tools/.../background.js`) and a
  **read-only zone reconciliation check** — "N residents unzoned, M would change
  zone, K missing coordinates" — surfaced in Health and diffed against the
  extension's output in the parity harness. *Done when:* the Operator can see
  alignment at a glance and preview the sales-loop playbooks, matching legacy
  output. Still zero writes.

- **Phase C — Safe execution + Undo.** Turn on live runs for the daily/weekly
  playbooks (import→master, push→folder, push-missing→folder, pull-data←folder),
  all through the write-guard, each with **pre-write snapshots and one-click
  revert** (§5.3). Build the **Conflict Inbox** (review-first). *Zone pipeline
  (§5.7):* enable the live, approval-gated, snapshotted **"Refresh zones &
  captains" playbook (Workflow A)** — it reconciles the master's canonical
  `ZoneName`/`NC …` fields through the same write-guard path (recompute-with-
  approval by default; fill-blank mode available). *Done when:* the Operator can
  run the core loop live on **copies**, see exactly what changed, revert a run,
  and triage conflicts — then graduate to real sheets.

- **Phase D — Schema playbooks (destructive, last).** Rename / delete columns
  across one or many sheets, with hard confirmation and accurate impact counts,
  fully integrated with the Field Dictionary. *Zone pipeline (§5.7):* build
  **"Generate captain sheets" (Workflow B)** here or as its own gated phase — it
  is the first "publish a projection outward" (§9.5.3) and carries schema-op-
  level risk (bulk Drive file creation, elevated Drive write scope, a file-
  ownership decision, and it feeds the live Zone Dashboard). Same bar: accurate
  dry-run preview, explicit confirm, never regenerate an existing sheet silently.
  *Done when:* nothing destructive happens without an accurate preview + explicit
  confirm, and it's all logged and revertible where feasible.

- **Phase E — Polish & optional modern extras.** Scheduling + summary emails
  (if wanted) — including **scheduled zone reconciliation** so re-zoning after
  Mapbox edits is proposed automatically (§5.7) — the optional Explain-it
  assistant, captain-facing read-only views or notifications (if the open
  questions resolve that way), accessibility and mobile pass, and retiring the
  legacy Apps Script.

---

## 8. Where we are today (continuity for the next session)

Built and verified (in `app/`):
- Runnable Node/Express app; single-admin login (signed cookie); config warnings.
- SQLite behind `db.js` with the full data model (connections, workflows,
  mappings, policies, sensitive columns, runs, run_log_entries, conflicts, jobs).
- `google.js`: cached service-account client, retry/backoff, A1 helpers,
  read-only folder listing + header reads (defaults to a spreadsheet's real
  first tab).
- `jobs.js`: in-process queue with restart-durability.
- **Tested core:** `lib/writeGuard.js`, `lib/columns.js`, `lib/values.js`,
  `lib/mergeEngine.js` — 21 passing `node:test` unit tests (`npm test`).
- Config UI (vanilla SPA): Connections, Workflows (all 12 types), mappings,
  policies, sensitive columns, runs, conflicts — styled to the Altagether guide.
- Read-only diagnostics: `scripts/check-connection.js`, `scripts/add-connection.js`.

Verified against the **real Google account** (`sheetsmart-503108`, bot
`sheetsmart-bot@sheetsmart-503108.iam.gserviceaccount.com`):
- **Master** — "Master Data File (Merged Voter Roll, DINS, emails)", tab
  `Master Data File`, **52 columns** (Appendix A).
- **Captain folder** — **120 spreadsheets** (more than the ~55 the brief assumed;
  scale the jobs accordingly). Registered as connection.
- **Sales tracker** — "Property Sales Records…", tabs `Sales Events` and
  `Sales Rollup by APN`, 12 columns on `Sales Events` (Appendix B).

Added in **Phase A** (in `app/web/` + backend additions):
- **Realized frontend** — React + Vite + TypeScript (`app/web/`), built on the
  Altagether design system (`web/src/styles/app.css`), served as static files by
  the same Express app. Dev server proxies `/api` to the backend. Nav reframed
  around goals: Health · Sources · Field Dictionary · Playbooks · Runs · Conflicts.
- **Field Dictionary** — new SQLite tables (`dictionary_fields`,
  `dictionary_aliases`), seeded on first run from the master's 52 fields
  (`src/dictionarySeed.js`), with CRUD API (`src/routes/dictionary.routes.js`)
  and a full editing UI (canonical name, type, identity/sensitive/text-safe
  flags, default policy, aliases, search).
- Health dashboard surfaces dictionary counts; Sources/Runs/Conflicts rebuilt;
  Playbooks is a labelled placeholder for the Phase-B guided previews.

Not yet built: the audit report, live/dry execution wired to Google, the parity
harness, the schema (rename/delete) operations, and the backend/engine
TypeScript migration (Decision B, deferred).

**Reusable now in the new build:** the entire `src/lib/**` engine + tests, the
`db.js`/`auth.js`/`google.js`/`jobs.js` module boundaries, the safety model, and
now the whole `web/` frontend + design system. The old vanilla `public/` UI is
kept only as a fallback when `web/dist` hasn't been built.

---

## 9. Open questions for the Operator (need real-world input)

1. **Captains' role.** Do the ~170 captains ever get anything from SheetSmart —
   a read-only "here's your zone's status" view, or notifications — or does it
   stay a single-operator tool? (Affects auth, hosting, scope.) *John's Answer*: The captains get a robust web app fed from the individual zone spreadsheets that they use to manage their volunteer work in their zones. This is a stand-alone app called the Zone Dashboard. 
2. **Canonical source of truth, long-term.** Stays "the master spreadsheet," or
   does SheetSmart eventually *own* the resident records and publish out to
   sheets? (The brief leaned "sheets stay canonical for v1." Revisit only if the
   pain justifies it.) *John's Answer*: I don't fully understand this question, but I'm leaning toward option two, which is that Sheetsmart eventually owns the resident records and publishes out to Sheets. I had an instinct that was maybe the more sensible direction for us to be moving, but I don't really know what the fuck I'm talking about, so if that's true, I think I support us moving in this direction. Again, I'm not totally sure of all the ramifications here, and I am not a developer.
3. **Conflict resolution depth.** Review-only (log + dismiss), or should the tool
   *apply* chosen resolutions (write the picked value)? The latter is powerful
   but adds write surface. *John's Answer*: I do not understand this question.
4. **Undo appetite.** Is DB-backed snapshot/revert (§5.3) worth the storage and
   complexity, or is Google version history "good enough"? (Recommend building
   it — it's the biggest trust win.) *John's Answer*: Trust matters big time. Strongly support Undo features.
5. **Modern stack tradeoff (Decisions A/B).** Comfortable with a build step in
   exchange for a much better UI and typed safety, or prioritize "I can read the
   source files" simplicity? *John's Answer*: I don't understand the more technical parts of this question, however, I strongly favor "much better UI".
6. **Scheduling.** Want automatic weekly audits / summary emails, or always run
   things by hand? *John's Answer*: I don't know what they are yet, but yeah, I think we want automated stuff going on.
7. **Which playbooks matter most.** Rank the real weekly jobs so we sequence
   Phase C by actual value. *John's Answer*: I want the app to be constantly surfacing and telling me the changes that are happening and also asking for my approval when it's needed. I don't know, man. Again, I don't really understand this question. But I think we're coming from a spreadsheet version where it's like, "I'm going to execute specific jobs." I think I would like to move us to a place where we have a healthy data ecosystem being built cooperatively with 170 people, but is also somewhat inured against fuckery and automatically fighting against rot.

---

## 9.5 What the Operator's answers change (direction locked)

The Operator answered §9 (see inline answers). His guiding metaphor: SheetSmart
should be **"the vascular system and beating heart of the information component
of this organization"** — robust, healthy, flowing, smartly built, and
**handoff-ready to a non-me maintainer in six months.** That reframes the target
from "an app that runs sync jobs" to a **living data-integrity backbone.** What
this locks in:

1. **SheetSmart stays a single-operator (admin) tool.** The ~170 captains do
   **not** use SheetSmart — they use a separate app, the **Zone Dashboard**, fed
   from the individual zone/captain spreadsheets. *Critical consequence:* the
   captain sheets SheetSmart writes to are the **same sheets the Zone Dashboard
   reads**, so SheetSmart's writes have real blast radius downstream. Safety,
   undo, and approval-gating are non-negotiable, not nice-to-haves.

2. **Model shift: from "run jobs" to "continuous reconciliation."** The realized
   app should **constantly watch** the master, captain sheets, and sources;
   **surface what's changing**; **automatically fight drift/rot**; and **ask for
   the Operator's approval** before anything consequential. Manual playbooks
   still exist, but the default posture is *ambient monitoring + proposed changes
   awaiting approval*, not *the human remembers to run operation #7*. Think
   "inbox of proposed, safe changes" over "control panel of buttons."

3. **Trajectory: database becomes the system of record (incrementally).** The
   Operator leaned toward SheetSmart eventually **owning** the resident records
   and **publishing out** to the master + captain sheets (Q2). This is the
   "beating heart." Approach it safely, in stages, never as a big-bang migration:
   - *Stage 1 — Trusted mirror:* the DB continuously ingests + reconciles from the
     sheets and can reproduce them exactly. Sheets remain operationally canonical.
   - *Stage 2 — Authoritative for defined fields:* once proven, specific fields
     become owned by the DB and published outward, with the sheets as views.
   - *Stage 3 — System of record:* the DB is canonical; sheets are projections
     the Zone Dashboard and captains consume. Only pursue once Stage 1–2 earn it.
   Keep `db.js` and a clean domain model so this evolution stays open (it also
   makes the eventual SQLite→Postgres move painless). *Concretely, the
   captain-sheet generation capability (Workflow B, §5.7 / `ZONE_PIPELINE_SPEC.md`)
   is the first real "publish a projection outward" mechanism — build its writer
   with the Stage 2/3 publishing model in mind, not as a one-off export.*

4. **Conflict handling = approval-based resolution (Q3).** Not just log-and-
   dismiss. The Conflict Inbox lets the Operator **approve a resolution** ("keep
   master / take captain / enter a value") and SheetSmart writes it — through the
   write-guard, snapshotted and revertible.

5. **Undo is in (Q4).** DB-backed pre-write snapshots + one-click "revert this
   run." Trust is the product.

6. **Modern UX + typed safety adopted (Q5).** Decision A = yes to a modern
   component frontend; Decision B = yes to TypeScript for the engine/API. This
   also directly serves the six-month-handoff requirement (Principle 8). Keep the
   simple single-service / SQLite / one-server backbone (Decision C unchanged).

7. **Automation is in scope (Q6).** Scheduled reconciliation + change surfacing +
   summary notifications — introduced after the core is trusted (Phase E), but
   architected for from the start (the continuous-reconciliation model above).

**Net:** the north star is a continuously-reconciling, approval-gated,
fully-reversible data backbone that trends toward being the organization's system
of record — legible enough to hand off, simple enough for one non-developer to
operate.

---

## 10. Immediate next steps

1. **Decisions are made** (§9.5): modern component frontend + TypeScript engine/
   API; single-service/SQLite/one-server backbone kept; undo, approval-based
   conflicts, and eventual system-of-record trajectory all in. No fork left to
   resolve before starting.
2. **Reframe the roadmap around continuous reconciliation** as you build: Health
   (§5.4) and the Conflict/Changes inbox become the *home surface*, not a report
   you generate. Manual playbooks (§5.2) remain available underneath.
3. **Start Phase A:** stand up the new TypeScript + component-framework shell and
   design system (Altagether style guide), port Sources into it, and build the
   **Field Dictionary** seeded from the master's real 52 fields (Appendix A) — the
   foundation both for drift management and for the DB-as-mirror trajectory.
4. **Design the domain model deliberately** (residents, fields, sources, syncs,
   runs, snapshots, conflicts) so Stage-1 "trusted mirror" (§9.5.3) is possible
   later without a rewrite.
5. Keep every phase gated by Operator testing; keep the parity harness honest
   before any live write; snapshot before every live write from day one.

---

## Appendix A — Master schema (52 fields, tab "Master Data File")

`_Sort Order`, `address_id`, `_SitusHouseNo`, `_SitusDirection`, `_SitusStreet`,
`_SitusUnit`, `House`, `Street`, `City`, `State`, `Zip`, `Latitude`, `Longitude`,
`APN`, `resident_id`, `Resident Name`, `First Name`, `Middle Name`, `Last Name`,
`Age`, `Gender`, `Home Phone`, `Cell`, `Email`, `Damage`, `Address Plan`,
`Build Status`, `Person - Renter`, `Person - Needs Follow-Up`,
`Person - Unable to Reach`, `Person Notes`, `Last Outreach Attempt Date`,
`Outreach Log`, `Address Notes`, `Address - Unit Type`, `Captain Assigned`,
`Address - For Sale`, `Address - Sold Since Fire`, `Latest Sale Date`,
`Latest Sale Price`, `Latest New Owner`, `Lot SqFt`, `Sales History`,
`Former Resident`, `Deceased`, `Wants_Updates`, `ZoneName`, `NC Name`,
`NC Phone`, `NC Email`, `Remediation Status`, `Successfully Contacted`.

Identity key: `resident_id`. Zone field: `ZoneName`. Likely checkbox fields:
`Address - For Sale`, `Address - Sold Since Fire` (count `=== true`, not
non-blank — legacy 1.5 / `Code.gs`). Text-safe candidates: `APN`, `resident_id`,
`address_id`, `Zip`, `_SitusUnit`.

## Appendix B — Sales tracker (tab "Sales Events", 12 fields)

`Address`, `APN`, `Address - Sold Since Fire`, `Sale Price`, `Sale Date`,
`Lot SqFt`, `Latitude`, `Longitude`, `New Owner`, `Buyer Notes`, `sort_order`,
`Sales History`. (There is also a `Sales Rollup by APN` tab.) Historic external
match key: **APN**.

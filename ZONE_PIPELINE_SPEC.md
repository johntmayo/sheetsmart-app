# Zone Pipeline Spec — Zone Assignment & Captain-Sheet Generation

**Status:** design for **new functionality not yet in the roadmap or the app.** Nothing here is built. It absorbs two existing external tools into SheetSmart.
**Read alongside:** `SHEETSMART_VISION_AND_ROADMAP.md` (north star — this spec is folded into its §4 model and §7 roadmap) and `SHEETSMART_PHASE_B_HANDOFF.md` (current build state + the pure-engine/route/preview pattern to mirror).
**Reference code (read-only, behavioral source of truth):** `reference-tools/data-pull-extension/` — the two working tools this spec absorbs. Port from that code; it already works against the real data. Do not restore its redacted secrets (§6).

> **Why this exists / how it fits the vision.** SheetSmart is being built as a *continuously-reconciling, approval-gated, reversible data backbone* that trends toward being the org's system of record (roadmap §9.5). The two capabilities here are not bolt-ons — they slot straight into that model:
> - **Workflow A (Assign/Reconcile Zones + Captain Info)** computes values for fields that are **already canonical** (`ZoneName`, `NC Name`, `NC Phone`, `NC Email` are in the master's 52 fields and the Field Dictionary). So it's *reconciliation of derived fields* — a Health check + an approval-gated playbook, exactly like the rest of the app.
> - **Workflow B (Generate Captain Sheets by Zone)** creates the 120 captain spreadsheets from the zone-tagged master. That is the first concrete form of **"publish a projection outward"** — Stage 2/3 of the system-of-record trajectory (roadmap §9.5.3).

---

## 1. The full lifecycle (where this fits)

```
   External data (sales tracker, etc.)
              │
              ▼
   ┌──────────────────────┐
   │  MASTER (52 fields)   │  includes Latitude, Longitude, ZoneName, NC Name/Phone/Email
   └──────────────────────┘
        │  ① ASSIGN / RECONCILE ZONES + CAPTAIN INFO   ← this spec (Workflow A)
        │     lat/lon → Mapbox polygon → set ZoneName + NC Name/Phone/Email
        ▼
   ┌──────────────────────┐
   │ MASTER (zone-current) │
   └──────────────────────┘
        │  ② GENERATE / PUBLISH CAPTAIN SHEETS BY ZONE ← this spec (Workflow B)
        │     one spreadsheet per zone, validations preserved
        ▼
   ┌──────────────────────┐
   │  120 CAPTAIN sheets   │  ← also the data source for the captain-facing Zone Dashboard
   └──────────────────────┘
        │  ③ ONGOING: audit + push/pull/merge + schema ops   ← the app's current scope
        ▼
   (kept aligned over time; drift reconciled continuously)
```

Stages ① and ② run at setup and whenever zones are redrawn or residents/zones are added; stage ③ is the day-to-day loop already being built (Phases B–D). **Blast radius note:** the 120 captain sheets are what the separate **Zone Dashboard** app reads, so both stages here ultimately affect a live captain-facing app. Safety, approval-gating, and undo (roadmap §5.3/§9.5) are non-negotiable for both.

---

## 2. Source tools being absorbed (what the reference code does)

### 2.1 Data Pull Extension → **Workflow A: Assign / Reconcile Zones + Captain Info**
Reference: `reference-tools/data-pull-extension/background.js` (the real logic), `content.js` (in-sheet button/progress UI), `config.js` (config shape, secrets redacted), `manifest.json` (scopes/hosts).

What it does today (`background.js` → `processSheet`):
1. **Auth** to Google Sheets via in-browser user OAuth. *(SheetSmart replaces this with the existing service-account client `src/google.ts` — see §5.1.)*
2. **Fetch Mapbox zone polygons**: `GET https://api.mapbox.com/datasets/v1/{USERNAME}/{DATASET_ID}/features?access_token={TOKEN}` → a GeoJSON FeatureCollection of ~120 zones (`fetchMapboxFeatures`).
3. **Build a bbox spatial index** per feature (`buildSpatialIndex`, `computeBBoxForGeom`).
4. **Read the master data tab** as a full A1:ZZ values grid.
5. **Locate lat/lon columns**: auto-detect by header (`lon`/`longitude`/`long`, `lat`/`latitude`); fall back to fixed indices `LONG_COL_INDEX=16` (Q), `LAT_COL_INDEX=17` (R). *(In SheetSmart, resolve these through the **Field Dictionary** — `Longitude`/`Latitude` are canonical fields — instead of fixed indices, mirroring `previewEngine.resolveFieldHeader`.)*
6. **For each row**: read `[lon, lat]`; if not finite → blanks; else `findContainingFeature` does a bbox pre-check then exact **point-in-polygon** (`pointInPolygon` handles holes; `pointInMultiPolygon` handles multipolygons). **First containing feature wins.**
7. **Append 4 output fields** from the matched feature's `properties`:
   | Output field (canonical, already in master) | Source Mapbox property |
   |---------------------------------------------|------------------------|
   | `ZoneName`                                  | `ZoneName`             |
   | `NC Name`                                   | `ContactName`          |
   | `NC Phone`                                  | `ContactPhone`         |
   | `NC Email`                                  | `ContactEmail`         |
   (`NC` = "Neighborhood Captain". Captain contact currently lives in **Mapbox feature properties** — see open question §7.1.)
8. **Writes results to a NEW tab** `Zones Join <YYYY-MM-DD>` and **copies dropdown/checkbox validations** from a template row (`copyTemplateValidationsToOutput`).

**Key reframing for SheetSmart:** the extension always writes a throwaway tab. SheetSmart instead **reconciles the master's existing `ZoneName`/NC columns in place**, through the write-guard, with a dry-run preview and undo — see §3. The geometry/index/validation code is plain, browser-independent JavaScript and ports almost verbatim into a TypeScript `zoneEngine.ts`.

### 2.2 Zone Export Tool → **Workflow B: Generate / Publish Captain Sheets by Zone**
Reference: `reference-tools/data-pull-extension/zone-export-apps-script/Code.gs` + `Sidebar.html` + `AGENT_HANDOFF.md`.

What it does today (bound Apps Script; `Code.gs` → `exportZones`):
1. User picks a **source tab** and **selects one or more zones** (or "select all").
2. Validates required headers: `ZoneName`, `NC Name`, `NC Phone`, `NC Email` (`assertRequiredHeaders_`).
3. Per zone: filter rows where `ZoneName` matches; **create a new spreadsheet** named `"<Zone> - <NC Names>"` (`buildExportFileName_`; NC names deduped, `;`-split); **copy the source sheet** (preserving structure/format/validation), clear old rows, write header + filtered rows, **re-apply template-row validations** (`propagateTemplateValidations_`), trim extra rows.
4. Returns per-zone results (row count, new spreadsheet URL).

This is the **initial creation / regeneration** of captain sheets — distinct from ongoing "push missing residents" (which appends rows to sheets that already exist).

---

## 3. Workflow A — Assign / Reconcile Zones + Captain Info (SheetSmart design)

**Shape (mirror the existing pattern):** a pure `src/lib/zoneEngine.ts` (geometry + join, no I/O, unit-tested like `auditEngine`/`mergeEngine`), a `src/routes/zones.routes.ts`, and surfaces in **Health** (a reconciliation check) and **Playbooks** (a guided, approval-gated action). Live writes go through the existing `src/lib/writeGuard.ts` and the Phase-C snapshot/undo path.

**Inputs/connections:**
- **Master** (target).
- **Zone source** — a new connection type (§5.2): Mapbox `username`, `dataset_id`, and a token (secret env var `MAPBOX_TOKEN`, not stored in the DB).
- Lat/lon + output columns resolved via the **Field Dictionary** (all six are canonical fields), so the match is explainable, not a fixed-index guess.

**Behavior:**
- Fetch features once, build the bbox index, join every master row by point-in-polygon (port `background.js` geometry verbatim into `zoneEngine.ts`).
- The 4 target columns already exist on the master; if a future master lacks one, add-missing-column-first (consistent with the cell-fill engine).
- **Write policy (documented exception, like Pull Data's `overwrite`):** `ZoneName` and the NC fields are **deterministic, SheetSmart-owned derived columns** computed from lat/lon + the polygon set + the captain roster. Default them to **recompute/overwrite when the computed value differs**, but *only* via dry-run preview + full logging + snapshot/undo — never a silent overwrite. Provide a per-run **`fill_blank` mode** (assign only where blank) for cautious first runs. Rationale: a stale zone is a bug, not hand-entered user data — but the operator still approves the change.
- **Reconciliation outcomes to surface distinctly** (this is the Health value):
  - `zone_unassigned` — valid lat/lon but in **no** polygon.
  - `zone_missing_coords` — blank/invalid lat/lon (can't assign).
  - `zone_conflict` — recomputed zone differs from the current `ZoneName` (surface even when overwriting; this is the approval moment).
  - `zone_multi` (optional) — point in >1 polygon (today: first wins; log the ambiguity).
- **Continuous-reconciliation framing (the vision):** "Are all residents correctly zoned, and does every zoned resident carry the right captain contact?" becomes an **ambient Health metric** and a **proposed-change** the operator approves — not a job someone remembers to run.

**Perf/quotas:** one Mapbox call, all geometry in memory, one batched read + one batched write of the master (handoff §4.7). Trivially within limits. **Risk: low** — deterministic, pure logic with working reference code and a single-sheet write.

---

## 4. Workflow B — Generate / Publish Captain Sheets by Zone (SheetSmart design)

**Shape:** a generation service (needs a Google **writer** with Drive scope) + a strongly-gated Playbook. Think of it as **"publish the master's zone slices outward"** — the first real projection in the system-of-record trajectory.

**Inputs/connections:**
- **Source**: the zone-current master (or a chosen tab).
- **Zone selection**: one, many, or all zones (default the picker from the source's distinct `ZoneName` values, like `getZoneOptions`).
- **Destination**: the **captain folder** connection — new files created *inside* it (see ownership gotcha §5.1).

**Behavior:**
- Validate required headers (`ZoneName`, `NC Name`, `NC Phone`, `NC Email`) up front.
- Per selected zone: filter rows, create a spreadsheet named `"<Zone> - <deduped NC Names>"`, write header + rows, and **reproduce dropdown/checkbox validations** from the template row.
- **Dry run** lists exactly which files would be created (names + row counts) and flags any zone whose file **already exists** in the folder.
- **Never overwrite/regenerate an existing captain sheet by default.** Once a captain sheet exists, ongoing changes flow through the sync playbooks (③), not regeneration — regenerating would blow away captain edits *and* disrupt the live Zone Dashboard. Generation is for **net-new zones / first-time setup**; regenerating an existing sheet is a separate, explicitly-confirmed action.

**Validation/formatting fidelity (porting note):** Apps Script's `copyTo` cheaply carried *all* formatting. The Sheets API port must reproduce this deliberately:
- Data validations: replicate `copyTemplateValidationsToOutput` (already in `background.js`) — read the template row's `dataValidation` and apply per-column via `spreadsheets.batchUpdate` `repeatCell`.
- Decide explicitly what *other* formatting must carry (conditional formatting, checkbox rendering, column widths, frozen header). At minimum validations + checkbox rendering are required (Zone Export `AGENT_HANDOFF.md` checklist). **Recommended:** seed each new file by copying a **blank template spreadsheet** via the Drive API, then fill it — this preserves formatting far more faithfully than building a sheet from scratch, and matches the "publish a projection" model.

**Risk: higher** — bulk Drive file creation, elevated scope, feeds a live downstream app. Gate it like the destructive schema ops.

---

## 5. Architecture implications (read before building either workflow)

### 5.1 Auth model + the file-ownership gotcha (MUST handle)
The extension authorized as **the user**; the Zone Export tool ran as **the user**, so new spreadsheets landed in the user's Drive automatically. SheetSmart uses a **service account** (`src/google.ts`), which changes two things:
- **Mapbox fetch** is just an HTTPS call with a token — no auth change, works server-side as-is.
- **File-creation ownership (Workflow B):** files created by the service account are **owned by it**, count against *its* limited Drive storage, and **won't appear in the admin's Drive** unless shared. So generation must, per file: create it (ideally inside the captain folder via Drive `files.create` with `parents`, or create-then-move), and **share it to the admin** (and/or transfer ownership). Confirm the ownership model with the Operator before building B. **This is the single biggest difference from the reference tools.**
- **Scope upgrade:** the app today uses read-only Drive (`google.ts` reads only). **Workflow A needs Sheets write** (already coming in Phase C). **Workflow B additionally needs Drive write** (`drive` or `drive.file`) to create/move/share files. Keep the elevated Drive scope scoped to generation and document it.

### 5.2 New connection type: `zone_source`
Add alongside `master` / `captain_folder` / `external`: **`zone_source`** — fields `provider` (`mapbox`), `username`, `dataset_id`, and a reference to the token secret (token lives in `MAPBOX_TOKEN`, never the DB). Cache the fetched FeatureCollection per run (optionally a `zone_features_cache` so an assign run and its dry-run preview use the identical polygon set).

### 5.3 Reuse the geometry code as-is (port to `zoneEngine.ts`)
`computeBBoxForGeom`, `pointInRing`, `pointInPolygon` (holes), `pointInMultiPolygon`, `buildSpatialIndex`, `bboxContains`, `findContainingFeature`, `columnIndexToA1`, `normalizeHeaderName`, `copyTemplateValidationsToOutput` in `background.js` are plain JS with no browser deps. Lift them into `src/lib/zoneEngine.ts` (typed), and unit-test the geometry (point inside / outside / in a hole / in a multipolygon) in `test/zoneEngine.test.ts`. This is the **lowest-risk new code in the project.**

### 5.4 Data-model additions
- `connections.type` gains `zone_source`.
- A zone-assignment run type (e.g. `run` type `zone_assign`, mode `dry`/`live`) and a generation run type (`generate_sheets`).
- `run_log_entries.type` gains `zone_assign`, `zone_unassigned`, `zone_missing_coords`, `zone_conflict`, `sheet_created`.
- Playbooks: add **"Refresh zones & captains"** (Workflow A) and **"Generate captain sheets"** (Workflow B).
- The output fields already exist as **Field Dictionary** entries (`ZoneName`, `NC Name`, `NC Phone`, `NC Email`, `Latitude`, `Longitude`) — reuse them; do not invent new logical fields.

---

## 6. Secrets & rotation (action for the owner)
The live `config.js` contained, in plaintext, a Google OAuth **client id + client secret** and a **Mapbox token**. In this reference copy they are **redacted** (`reference-tools/data-pull-extension/config.js`).
- In SheetSmart these become env vars, never source: add `MAPBOX_TOKEN`; store `MAPBOX_USERNAME` / `MAPBOX_DATASET_ID` as the `zone_source` connection. The Google client id/secret are **not needed** — the service account (`src/google.ts`) replaces the extension's user-OAuth entirely.
- **Rotate the old Google client secret and the Mapbox token.** They shipped inside a distributed browser extension and its backups; treat them as possibly exposed. Create a new Mapbox token (delete the old) and rotate/retire the old OAuth client secret.

---

## 7. Open questions (decide with the Operator when the project resumes)
1. **Captain-contact source of truth.** NC Name/Phone/Email live in **Mapbox feature properties** — an awkward home for changing PII (editing a captain's phone means editing a Mapbox dataset). Given the roadmap's Field-Dictionary + eventual DB-as-record direction, should the captain roster become a **first-class SheetSmart entity** (a "zone roster" table/sheet the tool owns), with Mapbox used only for polygons? *(Recommended long-term.)*
2. **Formatting fidelity on generated sheets.** Beyond validations/checkboxes, which formatting must carry? Template-copy (recommended) vs build-from-scratch. (§4.)
3. **File ownership/sharing model.** Service-account-owned + shared to admin, or ownership transferred to admin? Storage implications. (§5.1.)
4. **Keep Mapbox, or internalize zones?** Long-term, should the ~120 zone polygons live inside SheetSmart (uploaded GeoJSON) rather than depending on an external Mapbox dataset + token?
5. **Unassigned / multi-zone residents.** How should the Operator review residents in no zone or overlapping zones? (Health surface exists — §3 — confirm desired handling.)
6. **Re-zone semantics.** When zones are redrawn in Mapbox, re-running Workflow A reassigns residents. Confirm the overwrite-with-approval default (§3) matches expectations, and whether this should be a scheduled reconciliation (roadmap Phase E automation).

---

## 8. Build order (relative to the current roadmap)
These are **net-new capabilities with working reference code**, so they carry less unknown-behavior risk than the merge-engine port. Slot them into the existing lettered roadmap (`SHEETSMART_VISION_AND_ROADMAP.md` §7):

- **Workflow A (Assign/Reconcile Zones)** — low risk (deterministic pure geometry, single-sheet write, fields already canonical).
  - *Phase B (now):* build `zoneEngine.ts` + tests and a **read-only preview/Health check** ("N residents unzoned, M would change zone, K missing coords"), validated against the extension's output via the parity harness.
  - *Phase C:* enable the live, approval-gated, snapshotted write through `writeGuard` (same path as the other live playbooks).
- **Workflow B (Generate/Publish Captain Sheets)** — higher risk (bulk Drive file creation, elevated scope, ownership decision, feeds the live Zone Dashboard).
  - *Phase D–E:* build after the core loop + schema ops are trusted, with the same "explicit confirmation + accurate dry-run preview + no-overwrite-existing" bar as the destructive schema ops. It is also the natural first step of the **system-of-record "publish outward"** trajectory (§9.5.3), so design its writer with that in mind.
- **Parity for both:** run the extension + Zone Export tool on the frozen copies (the same fixtures as the audit/preview parity harness), capture outputs, and diff the SheetSmart port against them before any live run.

---

*This spec absorbs the Data Pull extension and the Zone Export tool into SheetSmart, aligned to the realized-vision architecture. The working originals are preserved read-only under `reference-tools/` as the behavioral source of truth — port from them, don't reinvent them.*

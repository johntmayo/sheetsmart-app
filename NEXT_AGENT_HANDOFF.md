# SheetSmart continuation handoff

You are taking over an active effort to finish and **validate** SheetSmart in production. SheetSmart is a single-operator administrative app that safely reconciles a master Google Sheet, captain-zone Google Sheets, Mapbox zone boundaries, and captain-originated changes.

## September 18, 2026: project paused over unacceptable performance

**This supersedes the “Immediate next action” and production-testing guidance below.**

The owner has stopped testing and intends to return to the manual process. This is not mild UX feedback:

- Individual SheetSmart scans and workflow steps routinely take **5–7 minutes**.
- Testing one end-to-end component can consume close to an hour.
- The owner estimates spending roughly **40 hours** developing and troubleshooting SheetSmart.
- Their previous Google Apps Script implementation performed the same practical task in about **60 seconds**, was free to run, and took far less time to build.
- The owner considers the current app overengineered, cumbersome, and worse than the manual process because its time cost overwhelms its safety and administrative benefits.

Do not ask the owner to continue production validation or defend the current architecture. Do not resume development unless they explicitly choose to revisit the project.

### Evidence behind the slowness

The current implementation makes the reported delay plausible:

- A boundary scan reads the master plus every spreadsheet directly inside the captain folder. The latest production test scanned **124 captain spreadsheets**.
- These are separate Google Sheets API calls, commonly reading `A:ZZ`, with concurrency limits of 5 or 10 depending on the workflow.
- `app/src/google.ts` treats Google 429/quota responses by waiting **65–70 seconds** before retrying, with up to eight attempts. A few quota windows turn one action into a multi-minute wait.
- Approval-time safety checks often repeat the same folder-wide reads immediately after the preview, so preview plus apply may exceed 250 spreadsheet reads.
- Render is probably not the principal bottleneck. The app spends most of this time waiting on external Google calls and quota backoff.
- Apps Script runs within Google’s infrastructure and has a much cheaper path to Sheets than 124 independent external API reads.

Safety features such as preview, revalidation, snapshots, and Undo remain valuable, but they do not require repeatedly rereading every unchanged spreadsheet.

### Focused performance plan if the owner ever restarts

Avoid a wholesale rewrite. Measure first, then make the smallest high-impact changes:

1. **Add timings and quota visibility.** Record total Google calls, per-stage duration, 429 count, and cumulative retry wait in the run summary. Do not log sheet contents or sensitive notes.
2. **Cache unchanged sheet scan data.** Use the Drive folder listing’s `modifiedTime` as an invalidation signal. Cache only the minimum non-sensitive index each workflow needs. Re-read new or modified sheets.
3. **Make new-zone detection cheap.** Compare Mapbox zone names with standardized spreadsheet filenames and read only one template plus ambiguous files. Creating a missing sheet should not require 124 full sheet reads.
4. **Make boundary scans master-first.** Compute changed addresses and involved zones from the master and Mapbox before loading captain data. Read only source/destination sheets involved in proposed moves.
5. **Narrow apply-time revalidation.** Verify folder/file modification times, then fully re-read the selected source and destination sheets immediately before writing. Preserve stale-preview protection without repeating the entire preview.
6. **Exclude inactive files.** Move obsolete/test spreadsheets into a subfolder; current folder listing is non-recursive, so those files will not be scanned.
7. **Check Google quota options.** Request a higher Sheets API read quota if available, but do not treat quota increases as a substitute for eliminating redundant reads.
8. **Use deliberate request pacing.** A shared read limiter can avoid waves of 429 responses. Simply increasing concurrency is likely to make quota behavior worse.

Suggested acceptance targets before asking the owner to test again:

- Missing-zone scan: **under 30 seconds** when the folder is unchanged.
- Warm boundary preview: **under 60 seconds**.
- Apply revalidation: **under 30 seconds before actual writes begin**.
- UI must show the current stage, files completed/total, and quota-wait time during longer work.

### Last production test state

- A temporary Mapbox zone was drawn and SheetSmart successfully created its empty formatted captain spreadsheet.
- The next boundary preview initially failed to recognize a non-numbered empty sheet. Commit `853279f` fixes named-zone detection and was pushed to `main`.
- The owner stopped before rerunning the boundary preview after that deployment.
- The temporary polygon and generated spreadsheet may still exist. Do not alter or remove either without explicit approval.

## How to work with the user (read this first)

- **The user is the project owner, not a developer.** Use plain language. Explain what a result means and what they should do next.
- **Default to handholding:** **one small numbered step at a time.** Wait for “done” (or an error paste) before the next step. Do not dump long multi-part checklists in a single message unless they ask for the full picture.
- They are **testing and refining on production Render** before giving a colleague the URL + login password. Do not assume they want git commits or code changes unless they ask.
- Move the project forward autonomously when coding, but **never apply live spreadsheet changes** without the app’s explicit preview/confirmation gates.
- Preserve Undo, snapshots, revalidation, privacy protections, and household-level integrity.
- Avoid jargon (“fingerprint,” “canonical,” “reconciliation”) without a plain-English gloss.
- Do not expose private note contents in logs or UI. `Person Notes`, `Address Notes`, and `Outreach Log` are sensitive.
- **Render is the correct host for SheetSmart** (~$7–8/mo Starter + 1 GB disk). **Not Vercel** (that’s the separate Zone Dashboard app).

## Production deployment (Render) — current state

- **URL:** `https://sheetsmart.onrender.com`
- **Repo:** `https://github.com/johntmayo/sheetsmart-app` (Render may show `johnnyayo` / `johnltmayo`)
- **Deploy branch:** `main`
- **Root directory:** `app`
- **Start command:** `npm start`
- **Build command** (required — `NODE_ENV=production` otherwise skips TypeScript/React devDependencies):

  ```text
  npm install --include=dev && npm run build && npm install --include=dev --prefix web && npm run build --prefix web
  ```

- Render UI prefixes commands with `app/ $` — that is the working directory, not something to type.
- **Persistent disk:** mount `/var/data`; env `DATABASE_PATH=/var/data/sheetsmart.sqlite`
- **Node:** `NODE_VERSION=22.18.0` and/or `app/.node-version` in repo

### Render environment variables (checklist)

| Key | Notes |
|-----|--------|
| `ADMIN_PASSWORD` | Login password (share with colleague when ready) |
| `SESSION_SECRET` | Random string; operator may not have saved it — reset is OK |
| `GOOGLE_SERVICE_ACCOUNT_JSON_B64` | Same long base64 line as local `app/.env` |
| `GOOGLE_IMPERSONATE_USER` | `info@altagether.org` — **required** to create captain sheets |
| `MAPBOX_TOKEN` | `pk.…` with datasets:read |
| `DATABASE_PATH` | `/var/data/sheetsmart.sqlite` |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22.18.0` |
| Do **not** set `PORT` | Render sets it |

Secrets live in **Render Environment**, not in git. Local `app/.env` is gitignored.

### Google setup (already done)

- Service account: `sheetsmart-bot@sheetsmart-503108.iam.gserviceaccount.com`
- Master, captain **Shared** folder, etc. shared with bot as **Editor**
- **Domain-wide delegation** (Google Admin): client ID `112155719808160268631`, scopes: `https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive`
- Captain folder **“Shared”** is **My Drive** owned by `info@altagether.org` — **not** a Google “Shared Drive” product
- **“Storage quota exceeded”** on create captain sheet = misleading; usually missing impersonation or trying to create in My Drive without delegation (see `DEPLOY.md`)

### Production Sources (configured on Render)

Fresh Render DB — connections were re-entered in UI (they do **not** copy from local SQLite):

- Master spreadsheet — **Test OK**
- Captain folder — **Test OK**
- Dashboard **Connected as:** sheetsmart-bot@…
- Mapbox: token in env only (not a “Source” row); zone check works

**Docs:** `DEPLOY.md` (go-live), `app/README.md`

## Operator testing status (March 2026)

- Build/deploy on Render **succeeded** after fixing build command + `NODE_VERSION`
- Operator **logged in**, configured Sources, ran **Zone assignment check** (read-only)
- **Not yet** confident enough to send colleague the link — still testing read-only then preview workflows
- **Not yet** completed Dashboard **Run sheet match check** on Render (recommended next read-only test)

### Testing ladder (use one step at a time with the operator)

| Step | Action | Writes? |
|------|--------|--------|
| 1 | Dashboard → **Run sheet match check** | No |
| 2 | Dashboard → **Check zones** (re-check as needed) | No |
| 3 | Zone results → **Show** detail — look for stale zone names (e.g. deleted captain) | No |
| 4 | Playbooks → **preview / scan only** | No |
| 5 | Live workflows on **copies** first, then production when trusted | Yes |

## Zone check UX confusion (deleted Mapbox zone / dropped captain)

**Scenario:** Operator deleted a Mapbox zone (e.g. captain Steve dropped out). Master still lists that zone and Steve as NC; captain spreadsheet may still exist in Shared folder.

**How Dashboard zone assignment check works today** (`reconcileZones` in `app/src/lib/zoneEngine.ts`):

- Per resident: **lat/lon → point-in-polygon** on Mapbox (not “does this zone name still exist on Mapbox?”)
- **Would change zone** = non-blank master zone **and** coords inside a **different named** Mapbox polygon
- **In no zone (valid coords)** = coords inside **no** polygon — common after a zone is **deleted**; master can still show the old zone name → counts here (**not** under “Would change zone”)
- **121 zones on master** vs **112 zones found on map** — distinct zone **names** on rows vs zones hit by geometry; hints at orphan/stale labels; UI does not explain this loudly
- Check is **read-only** — does not clear NC Name or remove obsolete captain sheet from Drive

**Operator expectation:** “Shouldn’t it flag Steve’s zone is gone?” — **Partially:** look in **In no zone** + detail table; not primarily **Would change zone**.

**Fixing data** (separate write workflows): boundary moves if people relocated; Mapbox contact audit (`captains` vs `master` scope); folder reconcile; manual cleanup of obsolete captain sheet. Master backfill scope is largely **fill blank**, not mass overwrite of stale zone labels.

Possible product improvements if user asks: new outcome for “master zone set, Mapbox empty”; orphan zone name report; clearer copy on Dashboard metrics.

## Product decisions already made

- SheetSmart is an admin-only tool. Captains use a separate Zone Dashboard.
- Mapbox polygons are authoritative for zone boundaries.
- A household is identified by `address_id`; every resident has an immutable `resident_id`.
- All residents at one address move together between captain sheets.
- Changes are previewed, approval-gated, revalidated immediately before writing, and undoable.
- SQLite on Render persistent disk stores configuration, jobs, run history, conflicts, tombstones, and safety metadata. Google Sheets hold operational data.
- Captain deletions use soft deletion plus a private operations workbook, archival evidence, tombstones, activity events, and restoration.
- Property-sales distribution is retired. Sales data comes from Zone Dashboard central source.
- Missing-address intake is master-first (Mapbox optional downstream, not admission gate).
- APN is non-unique metadata. Address intake deduplicates by normalized situs.
- `House`, `Street`, and retired sales columns removed via cleanup workflow.
- `_SitusUnit` must be text. Boolean cleanup semantics documented in prior handoff.

## What is working (live Playbooks)

- Folder-wide Mapbox boundary reconciliation, including moves and Undo.
- Creation of missing zone spreadsheets (**requires** `GOOGLE_IMPERSONATE_USER` on Render).
- Captain-added resident/address import with duplicate-situs protection.
- Missing-address intake (bulk import completed September 2026).
- **Live folder-wide captain → master field pull** with Conflict inbox logging.
- **Live folder-wide master → captain sync** (append missing residents; fill blank captain cells).
- Conflict inbox apply with undo.
- Folder cleanup preview/apply/Undo.
- Durable SQLite-backed jobs with atomic preview consumption.
- Operations workbook ingestion, deletion application, tombstones, activity feed.
- **Live Mapbox captain-contact audit** — scopes `captains` | `master` (master = large one-time backfill of blank zone/NC columns; separate from captain drift).

**Git:** deploy from **`main`**. Recent merges include Render deploy doc, Google impersonation, Node pin, web build `--include=dev`, Dashboard section spacing (`app/web/src/styles/app.css`).

## Address intake status (September 2026)

Bulk missing-address import **complete** (~1,400 addresses). ~**8 duplicate-check rows** may remain — review under Playbooks → Add missing addresses safely.

## Immediate next action

None. The project is paused at the owner’s request. Preserve the production state and wait for explicit direction.

## Deferred (do not build unless the user reprioritizes)

- Meaningful progress indicators for long scans / background jobs
- Live production zone-column bootstrap on raw master (copy-only path exists)
- Reduce redundant re-reads on apply-after-scan
- Raise batch limits after stable production runs
- Cell-level tick boxes on live folder pull
- UX for orphan zone names and “zone removed from Mapbox” outcomes

## Important implementation locations

- Zone reconcile / health: `app/src/lib/zoneEngine.ts`, `app/src/routes/zones.routes.ts`, `app/web/src/pages/Dashboard.tsx`
- Google impersonation / Drive create: `app/src/google.ts`, `app/src/config.ts`
- Captain → master pull: `app/src/lib/captainPullEngine.ts`, `app/src/captainPullTasks.ts`, `app/web/src/components/CaptainPullPlaybook.tsx`
- Master → captain sync: `app/src/lib/captainSyncEngine.ts`, `app/src/captainSyncTasks.ts`, `app/web/src/components/CaptainSyncPlaybook.tsx`
- Mapbox contact audit: `app/src/lib/mapboxContactAuditEngine.ts`, `app/web/src/components/MapboxContactAuditPlaybook.tsx`
- Boundaries: `app/src/routes/folderReconcile.routes.ts`, `app/web/src/components/FolderReconcilePlaybook.tsx`
- Zone sheet create: `app/src/routes/zoneSheets.routes.ts`, `app/web/src/components/ZoneSheetsPlaybook.tsx`
- Execution / undo: `app/src/executionTasks.ts`, `app/src/routes/safeExecution.routes.ts`
- Deploy guide: `DEPLOY.md`
- **Update this file** when milestones shift.

## Zone rename vs. resident relocation (Mapbox contact audit)

See `detectZoneRenames` in `mapboxContactAuditEngine.ts`:

- **Rename** — whole sheet relabelled; old label gone from Mapbox roster → correct ZoneName in place.
- **Relocation** — partial disagreement or old label still on Mapbox → skip row entirely; use **Move residents when zone boundaries change**.

Do not write new zone captain onto a row still labelled with the old zone.

## Address placeholder contract (do not break)

- `Address Placeholder` — booleans; `Placeholder Resident`; UUID `resident_id`; source `address_id` adopted when present; preserve capitalization.

## Safety invariants

- Never overwrite `resident_id` on an existing record.
- Household = `address_id`; move/delete as a unit.
- No silent duplicate situs under different `address_id`.
- No tombstone resurrection.
- No sensitive notes in logs/UI.
- Revalidate before live writes; no stale preview row numbers.
- Mapbox owns zone/captain-assignment fields on write.
- Undo must fail safely if newer edits would be clobbered.

## Do not reintroduce

- Uppercasing source street/city on write
- Internal `__address_placeholder__:…` resident IDs
- Ignoring source `address_id` when present
- Coordinate-only duplicate review holds

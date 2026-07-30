# SheetSmart (web app)

A standalone admin tool that keeps **120** Google "captain" spreadsheets aligned
with one **master** resident dataset. It audits sheets for drift, moves data
between them safely (fill blanks, append missing rows, log conflicts instead of
overwriting), and manages columns — always with a **dry run** before any live
write.

This folder is the actual application. The planning documents live one level up
(`SHEETSMART_BUILD_HANDOFF.md`, `WEB_APP_MIGRATION_SPEC.md`) and the original
Google Apps Script — the behavioral source of truth — lives in
`../legacy-appsscript/`.

---

## What is built so far

This is **Phase 0 + Phase 1** of the handoff's phased plan, plus the tested core
of the safety engine:

- **Runnable Node/Express app** with a single-admin password login and a signed
  session cookie.
- **SQLite database** (one file) behind a thin `db.js`, with the full data model
  (connections, workflows, mappings, policies, sensitive columns, runs, run log
  entries, conflicts, jobs).
- **Google service-account client** (`google.js`) with retry/backoff, A1 helpers,
  and **read-only** folder listing + header reads. Nothing writes to a sheet yet.
- **Read-only "Test connection"** — lists the captain folder's spreadsheets and
  reads the master's headers (the Phase 0 gate).
- **Config screens** — Connections, Workflows (all 12 types), column mappings,
  column policies, and the sensitive-columns list — all saved in the database.
- **In-process job runner** (`jobs.js`) with restart-durability, ready for the
  audit/dry-run/live jobs added in later phases.
- **The write-guard** (`lib/writeGuard.ts`) and **column matcher**
  (`lib/columns.ts`) — the highest-risk logic — ported from the legacy tool and
  covered by unit tests (`npm test`, 21 passing).

The **entire backend (engine + API) is now TypeScript** (Decision B in
`SHEETSMART_VISION_AND_ROADMAP.md` §6/§9.5). Source lives in `src/*.ts`, compiles
to `dist/` with `npm run build`, and runs as plain compiled JavaScript in
production (`npm start`) — no runtime TypeScript loader required on the server.

Plus **Phase A** of the realized vision (`SHEETSMART_VISION_AND_ROADMAP.md`):

- **A modern frontend** (React + Vite + TypeScript in `web/`) built on the
  Altagether design system, replacing the vanilla SPA. It builds to static files
  the same Express server serves — still one service to run and deploy.
- **The Field Dictionary** — the canonical list of logical fields (seeded from
  the master's real 52 fields) with each field's data type, identity/sensitive/
  text-safe flags, default sync policy, and aliases. This is where column drift
  becomes a managed fact instead of a silent guess.

**Not built yet (later phases, and they need your real sheets to build safely):**
Audit report, dry-run/live execution of workflows, the parity harness, and the
schema (rename/delete) operations. The "Dry run / Live run" buttons are visible
but disabled until then.

---

## Run it locally (2 minutes)

You need [Node.js](https://nodejs.org) 18 or newer (you have it if `node -v`
prints a version).

```bash
cd app
npm install
```

Create your settings file by copying the example:

```bash
# Windows PowerShell
Copy-Item .env.example .env
# macOS / Linux
cp .env.example .env
```

Open `.env` and set at least:

- `ADMIN_PASSWORD` — the password you'll type to open the app.
- `SESSION_SECRET` — any long random string.

Both the backend and the frontend are **TypeScript**. Build the backend
(`src/*.ts` → `dist/`) and the frontend (`web/` → `web/dist/`) once, then start:

```bash
npm run build:web   # installs web deps + builds app/web -> app/web/dist
npm run build       # compiles the TypeScript backend src/ -> dist/
npm start           # serves API + the built UI on http://localhost:3000
```

Open <http://localhost:3000>, sign in with your `ADMIN_PASSWORD`, and you'll see
the dashboard. Everything except live Google connections works immediately; the
dashboard will simply show **"Google not connected"** until you finish the
checklist below.

> If you skip `npm run build:web`, the server falls back to the older vanilla UI
> in `public/` so it still runs — but the realized UI lives in `web/`.

**Working on the backend?** Skip the compile step and run the server straight
from TypeScript with hot-reload:

```bash
npm run dev         # tsx watch src/server.ts — restarts on save, no build needed
```

**Working on the UI?** Run the backend (`npm run dev` or `npm start`) in one
terminal and the frontend dev server in another for instant hot-reload (it
proxies `/api` to the backend):

```bash
npm run web:dev     # http://localhost:5173 during development
```

Type-check the whole backend, and run the safety tests, any time with:

```bash
npm run typecheck   # tsc --noEmit over src/ and test/
npm test            # node's test runner over the TypeScript tests (via tsx)
```

---

## Your checklist (the things only YOU can do)

These need accounts, a browser, or a credit card, so the app can't do them for
you. Do them roughly in order. Treat every key like a password. (This mirrors
Section 9 of the handoff.)

### A. Google Cloud + service account
1. Go to <https://console.cloud.google.com> and sign in with the Google account
   that administers the sheets.
2. Create a new project (top bar → project dropdown → **New Project**), name it
   `sheetsmart`, and select it.
3. Enable two APIs: search **Google Sheets API** → Enable, then **Google Drive
   API** → Enable.
4. Left menu → **APIs & Services → Credentials → Create Credentials → Service
   account**. Name it `sheetsmart-bot`, skip the optional roles, click Done.
5. Open the service account → **Keys → Add Key → Create new key → JSON**. A
   `.json` file downloads. **This file is a password to your data — keep it
   safe.**
6. Turn that JSON into one base64 line and paste it into `.env` as
   `GOOGLE_SERVICE_ACCOUNT_JSON_B64`:

   ```powershell
   # Windows PowerShell (replace the path with your downloaded file)
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\sheetsmart-bot-key.json"))
   ```
   ```bash
   # macOS / Linux
   base64 -w0 /path/to/sheetsmart-bot-key.json    # (use `base64 -i file` on macOS)
   ```
   Copy the single line of output and set `GOOGLE_SERVICE_ACCOUNT_JSON_B64=` to it
   in `.env`, then restart the app. The dashboard will show the bot's email for
   confirmation. (The private key is never displayed or logged.)

### B. Share your sheets with the bot
7. Open the **master** spreadsheet → **Share** → paste the bot's email
   (`sheetsmart-bot@…gserviceaccount.com`, shown on the dashboard once connected)
   → give it **Editor** → Send.
8. Open the Google Drive **folder** of 120 captain sheets → **Share** → same
   email → **Editor** → Send.
9. Do the same for the **sales tracker** / any external source spreadsheet.
10. In SheetSmart → **Connections → Add connection**, create one entry each for
    the master (type *master*), the captain folder (type *captain_folder*), and
    the sales tracker (type *external*). The Google ID comes from the URL:
    `.../spreadsheets/d/THIS_PART/edit` for sheets, `.../folders/THIS_PART` for a
    folder. Click **Test** on each — the master should show its headers and the
    folder should list all the captain sheets. **That is the Phase 0 gate.**

### C. Before any live writes (later, for Phase 3)
11. Make a **copy** of the master and a couple of captain sheets (File → Make a
    copy). Point SheetSmart at the copies for the first live-write tests. These
    copies also become the parity-harness fixtures. Only switch to the real
    sheets once the copies behave correctly.
12. Learn Google Sheets **Version history** (File → Version history) — that's
    your undo button.

### D. Hosting (later, when you want it online — see handoff Section 9D/E)
Render.com paid always-on instance (~$7/mo) + a small persistent disk for the
SQLite file, deployed from a **private** GitHub repo. The `.env` values become
Render environment variables; `DATABASE_PATH` must point at the persistent disk
(e.g. `/var/data/sheetsmart.sqlite`).

---

## Project layout

```
app/
├── src/                       TypeScript backend (compiles to dist/)
│   ├── server.ts              Express wiring
│   ├── config.ts              env/config (nothing else reads process.env)
│   ├── db.ts                  SQLite + full schema (thin, swappable)
│   ├── auth.ts                admin password + signed session cookie
│   ├── google.ts              service-account client, retry, A1 helpers (read-only)
│   ├── jobs.ts                in-process job queue (restart-durable)
│   ├── dictionarySeed.ts      the 52-field Field Dictionary seed
│   ├── types.ts               shared backend types (injected Deps, etc.)
│   ├── lib/
│   │   ├── values.ts          cell-equality semantics (ported)
│   │   ├── columns.ts         fuzzy column matcher + zone detection (ported)
│   │   ├── writeGuard.ts      THE safety decision point (ported, tested)
│   │   └── mergeEngine.ts     pure merge/append planners (ported, tested)
│   └── routes/                auth, status, connections, workflows, settings, runs, audit, dictionary
├── dist/                      compiled backend output (git-ignored; `npm run build`)
├── web/                       realized frontend — React + Vite + TypeScript
│   ├── src/
│   │   ├── App.tsx            router + app shell (Health, Sources, Field Dictionary, …)
│   │   ├── pages/             one file per screen
│   │   ├── components/        shared UI (Toast, Modal, StatusPill, …)
│   │   ├── lib/               typed API client, shared types, data hook
│   │   └── styles/app.css     the Altagether design system, in CSS variables
│   └── dist/                  build output the server serves (git-ignored)
├── public/                    legacy vanilla UI (fallback if web/ isn't built)
├── test/                      node:test unit tests in TypeScript (npm test)
├── tsconfig.json              backend type-check config (src + test)
├── tsconfig.build.json        backend emit config (src -> dist)
├── .env.example               copy to .env and fill in
└── package.json
```

## Safety model (never bypass)

Every proposed cell write goes through `lib/writeGuard.ts`:
fill blanks only by default · never write a blank over a value · log conflicts
instead of overwriting · `resident_id` is always protected · only `overwrite`-
policy columns may replace a non-blank value · unlisted columns default to
conflict-only. See `SHEETSMART_BUILD_HANDOFF.md` Section 5.

# SheetSmart — go live on Render

SheetSmart is an **always-on Node server** with a SQLite database and long-running Google Sheets jobs. **Do not deploy it to Vercel** (that platform is for the separate Zone Dashboard app). Use **Render** with a **persistent disk**.

Estimated cost: about **$7/month** for a paid always-on web service plus a small disk.

---

## Before you start

These are **one-time Google / Mapbox setup** steps. Your **local `.env`** is only for running on your laptop; **Render needs the same secrets copied into its Environment tab** (except paths like `DATABASE_PATH`).

Check each item:

1. **Google service account** — `sheetsmart-bot@sheetsmart-503108.iam.gserviceaccount.com` exists and you have its JSON as `GOOGLE_SERVICE_ACCOUNT_JSON_B64` (local `.env` **and** Render).
   - **Verify:** SheetSmart Dashboard → **Connected as:** shows that email.
2. **Sheets shared with the bot** — master spreadsheet, captain **Shared** folder, and template sheets: bot has **Editor**.
   - **Verify:** Connections → **Test** succeeds locally (or after deploy, on Render).
3. **Domain-wide delegation** (Google Admin) — client ID **`112155719808160268631`**, scopes:
   `https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive`
   - **Verify:** Admin → Security → API controls → Domain-wide delegation lists that client ID.
4. **`GOOGLE_IMPERSONATE_USER=info@altagether.org`** on **Render** (and local `.env` for dev). Required to **create** captain sheets.
5. **`MAPBOX_TOKEN`** on **Render** (and local `.env`). Token needs **datasets:read** (starts with `pk.`).

If the Render **build** fails on `better-sqlite3`, the repo’s `app/.node-version` pins Node **22.18.0**. You can also set Render env **`NODE_VERSION=22.18.0`** and redeploy.

---

## 1. Push code to GitHub

The repo should already be on GitHub (`origin`). From your machine:

```powershell
git push -u origin HEAD
```

Render deploys from this repository. Keep the repo **private**.

---

## 2. Create the Render web service

1. Sign in at [render.com](https://render.com) with the same GitHub account.
2. **New → Web Service** → connect the `sheetsmart-app` repository.
3. Settings:

| Setting | Value |
|---|---|
| **Name** | `sheetsmart` (or your choice) |
| **Region** | Closest to you (e.g. Oregon) |
| **Branch** | The branch you want live (e.g. `main` or your feature branch) |
| **Root Directory** | `app` |
| **Runtime** | Node |
| **Build Command** | `npm install --include=dev && npm run build && npm install --include=dev --prefix web && npm run build --prefix web` |
| **Start Command** | `npm start` |
| **Instance type** | **Starter** or higher — **not Free** (free tier sleeps and kills long sheet jobs) |

---

## 3. Add a persistent disk

Without this, run history and connections are lost on every restart.

1. In the service → **Disks** → **Add disk**
2. **Mount path:** `/var/data`
3. **Size:** 1 GB is enough to start
4. Save

---

## 4. Set environment variables

In the service → **Environment**, add:

| Key | Value | Notes |
|---|---|---|
| `ADMIN_PASSWORD` | *(choose a strong password)* | What you type to log in |
| `SESSION_SECRET` | *(long random string)* | Signs login cookies; any 32+ random characters |
| `GOOGLE_SERVICE_ACCOUNT_JSON_B64` | *(copy from local `.env`)* | Same base64 line you use locally |
| `GOOGLE_IMPERSONATE_USER` | `info@altagether.org` | Required for captain-sheet creation |
| `MAPBOX_TOKEN` | *(copy from local `.env`)* | `pk.…` token with datasets:read |
| `DATABASE_PATH` | `/var/data/sheetsmart.sqlite` | Must match the disk mount |
| `NODE_ENV` | `production` | Runtime only; build command must use `npm install --include=dev` so TypeScript installs. |

Do **not** set `DISABLE_AUTH`. Leave `PORT` unset — Render provides it.

After saving, Render redeploys automatically.

---

## 5. First login and setup

1. Open the Render URL (e.g. `https://sheetsmart.onrender.com`).
2. Log in with `ADMIN_PASSWORD`.
3. On the **Dashboard**, confirm **Connected as:** shows the service account email.
4. Go to **Sources / Connections** and add:
   - **master** — master spreadsheet ID + tab
   - **captain_folder** — the “Shared” folder ID
   - **zone_source** / Mapbox settings if prompted on Zone Health
5. Click **Test** on each connection.

A fresh deploy starts with an **empty database**. Connections, run history, and field-dictionary edits from local dev do **not** transfer unless you copy the SQLite file onto the disk (see below).

---

## 6. Smoke test before real sheets

1. Run a **read-only** check (Dashboard audit or zone preview).
2. Run one **live** workflow against **copies** of the master and a captain sheet first.
3. When copies behave correctly, point connections at production IDs.

---

## 7. Backups

Periodically download the database from Render:

1. Service → **Shell** (or SFTP if you set it up)
2. File: `/var/data/sheetsmart.sqlite`

Store backups somewhere safe. Run history and undo metadata live in this file.

---

## 8. Updating after code changes

```powershell
git push origin YOUR_BRANCH
```

Render rebuilds on push. The disk (and database) survive redeploys.

To add a new environment variable locally, also add it in Render → **Environment** and redeploy.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| “Storage quota exceeded” when creating captain sheets | `GOOGLE_IMPERSONATE_USER` missing on Render, or domain-wide delegation not authorized |
| Jobs die mid-run | Free tier sleeping — upgrade to paid always-on |
| Empty connections after deploy | Expected on first deploy — re-enter in UI or restore SQLite backup |
| “Not connected” on Dashboard | `GOOGLE_SERVICE_ACCOUNT_JSON_B64` missing or malformed |
| 401 on every page | Wrong `ADMIN_PASSWORD` or expired session — log in again |

---

## Quick reference: local vs Render

| | Local | Render |
|---|---|---|
| Config file | `app/.env` | Environment tab |
| Database | `app/data/sheetsmart.sqlite` | `/var/data/sheetsmart.sqlite` |
| URL | `http://localhost:3000` | `https://YOUR-SERVICE.onrender.com` |
| Restart | Stop/start terminal | Manual redeploy or push to git |

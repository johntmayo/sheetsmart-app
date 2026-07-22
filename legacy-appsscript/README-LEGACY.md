# legacy-appsscript/ — reference only

These files are the **current, working Google Apps Script implementation** of Sheet Smart, copied here as the **behavioral source of truth** for the web-app rebuild.

- **Do not run or edit these files.** They belong to the live Apps Script project bound to the "Sheet Smart Config" spreadsheet. This copy is a frozen reference.
- **Do port from them.** When the build plan says "match the old output," this code is what defines that output.
- **Read `AGENTS.md` first** — it is the maintainer's guide and enumerates all 12 operations, every Settings key, and every write policy precisely.

Reading order for the logic:
1. `AGENTS.md` — the map.
2. `MergeEngine.gs` — the merge/fill/append/pull core (the heart of the behavior).
3. `Code.gs` — the Phase-1 audit and exactly how it counts completeness (note the checkbox-vs-blank distinction).
4. `Corrections.gs` — how each operation is wired to settings and logging.
5. `Sidebar.html` — what inputs each operation exposes.

Background/context: `PRD.md`, `phase_progress.md`, `README.md`.
One-off historical migrations (not part of the web app): `AddressIdMigration.gs`, `FOR REFERENCE - backfill_resident_id.gs`.

See `../SHEETSMART_BUILD_HANDOFF.md` Section 1.5 for the list of non-obvious behaviors that are easy to miss if you only read the prose.

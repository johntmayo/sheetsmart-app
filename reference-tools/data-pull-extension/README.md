
# Spreadsheet Data Pull (fixed)

Changes:
- **No ES module import in content scripts.** `config.js` is now global (via `globalThis.CONFIG`).
- `manifest.json` injects `config.js` before `content.js`.
- `background.js` (module) imports `./config.js` and reads `globalThis.CONFIG`.

Setup steps remain the same: set your Google Web OAuth CLIENT_ID in `config.js`, add the `https://<EXTENSION_ID>.chromiumapp.org/` redirect URI, load unpacked, open your target Sheet.

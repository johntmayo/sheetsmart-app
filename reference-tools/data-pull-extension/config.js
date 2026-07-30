// Global CONFIG for both background (module) and content scripts (plain script)
//
// ⚠️ SECRETS REDACTED FOR THIS REFERENCE COPY.
// The original config.js (in the live extension) contained real values for
// CLIENT_ID, CLIENT_SECRET, and MAPBOX.TOKEN. They were removed before copying
// this into the SheetSmart brief so they don't end up committed to a git repo.
//
// In the SheetSmart web app these do NOT go in a source file at all — they become
// environment variables / secrets (see SHEETSMART_BUILD_HANDOFF.md §3 and
// ZONE_PIPELINE_SPEC.md). The values below are placeholders that show the SHAPE
// of the config the port needs to reproduce.
//
// NOTE TO OWNER: the real Google OAuth client secret and Mapbox token were sitting
// in plaintext in the extension. Consider rotating both (they may have been shared
// or backed up). See ZONE_PIPELINE_SPEC.md "Secrets & rotation".
globalThis.CONFIG = {
  BUILD_STAMP: "2026-02-16-debug-c",
  CLIENT_ID: "REDACTED.apps.googleusercontent.com",        // was a real Google OAuth client id
  CLIENT_SECRET: "REDACTED",                               // was a real Google OAuth client secret — ROTATE
  SHEET_ID: "REDACTED_MASTER_SPREADSHEET_ID",              // the master spreadsheet the extension ran against
  MAPBOX: {
    USERNAME: "altagether",
    DATASET_ID: "REDACTED_MAPBOX_DATASET_ID",              // the zone-polygon dataset
    TOKEN: "REDACTED_MAPBOX_TOKEN"                          // was a real Mapbox token — ROTATE
  },
  LONG_COL_INDEX: 16, // Q  (fallback if no lon/longitude/long header is found)
  LAT_COL_INDEX: 17,  // R  (fallback if no lat/latitude header is found)
  TEMPLATE_VALIDATION: {
    // Sheet tab to read data rows from.
    DATA_SHEET_TITLE: "Master Data File",
    // Sheet tab that contains template validations (dropdowns/checkboxes).
    TEMPLATE_SHEET_TITLE: "Master Data File",
    // Row in the source/master tab that contains your template dropdown/checkbox setup.
    TEMPLATE_ROW_NUMBER: 2,
    // Don't copy the template row itself into output data rows.
    SKIP_TEMPLATE_ROW_IN_OUTPUT: true,
    // Copy validation only for explicit header names (deterministic mode).
    COLUMN_HEADERS: [
      "Damage",
      "Address Plan",
      "Build Status",
      "Address - Unit Type",
      "Captain Assigned",
      "Person - Renter",
      "Person - Needs Follow-Up",
      "Person - Unable to Reach",
      "Address - For Sale",
      "Address - Sold Since Fire"
    ],
    // Optional: set true to show validation copy diagnostics in progress text.
    DEBUG_VALIDATION: false
  }
};

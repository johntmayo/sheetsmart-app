# Zone Dashboard → SheetSmart operations contract

SheetSmart exposes the live contract at `GET /api/operations/contract`. The
current schema version is `1.0`.

## Sales-data ownership

Zone Dashboard is the central source for sales data. SheetSmart retains the
existing master columns `Address - For Sale`, `Address - Sold Since Fire`,
`Latest Sale Date`, `Latest Sale Price`, `Latest New Owner`, `Lot SqFt`, and
`Sales History` so historical data remains readable, but never imports those
values from captain sheets or distributes them to captains. Their SheetSmart
policy is permanently **Never write** and **Master only**.

Outside spreadsheet connections are optional inputs for address intake. They
are not sales feeds.

## Exact tab schemas

`Deleted Records` must use this exact order:

```text
operation_id,schema_version,action,actor,zone,timestamp,resident_id,address_id,resident_name,address_label,source_sheet_id,source_sheet_tab,full_row_json
```

`Activity Events` must use this exact order:

```text
event_id,schema_version,actor,zone,event_type,resident_id,address_id,resident_name,address_label,quantity,timestamp
```

All IDs, actor, zone, timestamps, source sheet fields, and `full_row_json` are
required for deletion rows. Display labels may be blank. Timestamps are ISO
8601 with a time zone. `quantity` is a positive integer. `full_row_json` is an
object whose keys are original headers and whose values are primitive sheet
cell values; nested objects/arrays are rejected.

`Deleted Records.action` accepts only `delete_person` or `delete_address`.
Restoration is an administrator action performed through SheetSmart Undo;
Zone Dashboard may report the completed result as a `restore` activity event,
but must never clear deletion state itself.

Example person archive:

```text
op_01,1.0,delete_person,Alice,Zone 12,2026-09-04T07:00:00Z,res_01,addr_01,Sam Rivera,10 Oak St,spreadsheet_id,Residents,"{""resident_id"":""res_01"",""address_id"":""addr_01"",""Resident Name"":""Sam Rivera""}"
```

Example safe activity:

```text
evt_01,1.0,Alice,Zone 12,person_deleted,res_01,addr_01,Sam Rivera,10 Oak St,1,2026-09-04T07:00:01Z
```

## Required write order for deletion

1. Show a destructive confirmation explaining that the record disappears
   immediately and restoration requires contacting the administrator.
2. Generate one stable `operation_id`. Reuse it for every retry.
3. Append the complete pre-delete row to the private `Deleted Records` tab.
   For a whole address, append one row for every resident before marking any
   of them.
4. Only after every archive append succeeds, write the stable `operation_id`
   into that row’s `Deleted Record` column. Do not physically delete the row.
   Zone Dashboard excludes rows with a nonblank deletion marker from active
   people, while still using their address fields to retain an empty address.
5. Append one minimal event to `Activity Events`, reusing its `event_id` on
   retry. Failure to append activity must not roll back or repeat the deletion.

SheetSmart deduplicates both IDs. It imports the archive, activates tombstones,
propagates the same reversible marker to remaining master/captain copies, and exposes
recovery through Runs.

Generate operation/event IDs as UUIDs or another collision-resistant value.
Before retrying an append after an ambiguous response, search the corresponding
ID column. If an identical row already exists, treat the append as successful.
If the ID exists with different data, stop and alert an administrator. SheetSmart
also collapses identical retry rows and rejects conflicting reuse.

The Dashboard backend—not browser JavaScript—must hold Google credentials and
append to the workbook. Share the workbook only with its owner, SheetSmart’s
service account, and the explicitly configured Zone Dashboard service account.
Public, link, domain, group, and unlisted-user sharing is rejected.

## Privacy boundary

`Deleted Records` is an administrator-only archive and contains the complete
row JSON needed for restoration.

`Activity Events` must contain only its exact allowlisted headers. Never write
outreach text, person notes, address notes, phone numbers, email addresses, or
free-form metadata. SheetSmart rejects the entire activity import if extra
columns appear.

## Event types

- `address_added`
- `person_added`
- `address_deleted`
- `person_deleted`
- `outreach_logged`
- `follow_up_changed`
- `restore`

The producer supplies actor, zone, timestamp, relevant IDs/display labels, and
a positive integer quantity. SheetSmart creates the final plain-English
sentence.

For `outreach_logged`, use `quantity` for the number of affected people and do
not include what was written. `resident_id`/`resident_name` may be blank for an
aggregated event. For person events, include resident and address identities.
For address events, `resident_id` may be blank only when no archived row is
being represented.

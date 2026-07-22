// Seed data for the Field Dictionary — the canonical list of logical fields the
// whole tool reasons about. Derived from the real master schema (52 fields;
// SHEETSMART_VISION_AND_ROADMAP.md Appendix A) plus the identity/type/text-safe
// facts the legacy tool relies on (handoff 1.5 / legacy Code.gs).
//
// This is a *seed*, not a lock: every field here is editable by the Operator in
// the UI. Corrections (e.g. a new alias for a drifted header) are meant to be
// added over time so the tool learns the drift instead of guessing silently.
//
// Defaults reasoning:
// - default_policy 'fill_blank' everywhere (fill blanks only), except the
//   identity key resident_id which is always 'never' (it is sacred; handoff 5).
// - Checkboxes: only the two the source doc explicitly calls checkboxes are
//   seeded as such (they count with `=== true`, not non-blank). Others are left
//   as text for the Operator to confirm rather than guessed at.
// - text-safe: APN, resident_id, address_id, Zip, _SitusUnit (Appendix A) — must
//   be written RAW so Sheets can't mangle IDs/zips into dates/numbers.
// - sensitive: the clear resident PII (contact details + free-text notes) so a
//   push to a captain sheet flags them for confirmation. Informational only.

import type { DataType } from './db';
import type { Policy } from './lib/writeGuard';

// A single seed row: the field's dictionary attributes plus its known aliases.
export interface SeedField {
  canonical_name: string;
  data_type: DataType;
  is_identity: 0 | 1;
  is_sensitive: 0 | 1;
  is_text_safe: 0 | 1;
  default_policy: Policy;
  notes: string;
  sort_order: number;
  aliases: string[];
}

const IDENTITY = new Set(['resident_id']);
const CHECKBOX = new Set(['Address - For Sale', 'Address - Sold Since Fire']);
const TEXT_SAFE = new Set(['APN', 'resident_id', 'address_id', 'Zip', '_SitusUnit']);
const SENSITIVE = new Set(['Home Phone', 'Cell', 'Email', 'Person Notes', 'NC Phone', 'NC Email']);

// Known drift aliases for the high-churn fields (handoff 4.3). Canonical names
// are always matched implicitly by the normalizing matcher, so we only list
// extra real-world variants here.
const EXTRA_ALIASES: Record<string, string[]> = {
  resident_id: ['residentid', 'resident id'],
  address_id: ['addressid', 'address id'],
  APN: ['parcel number', 'parcel', 'apn number'],
  'Resident Name': ['name', 'full name'],
  'Last Outreach Attempt Date': ['last contact date', 'last outreach date', 'last outreach'],
  _SitusHouseNo: ['house #', 'house no', 'situs house no'],
  _SitusStreet: ['street name', 'situs street'],
  House: ['house number'],
  Zip: ['zip code', 'zipcode', 'postal code'],
  Cell: ['cell phone', 'mobile', 'mobile phone'],
  'Home Phone': ['phone', 'phone number', 'home phone number'],
  ZoneName: ['zone', 'zone name'],
};

// The 52 master fields, in sheet order (Appendix A).
export const MASTER_FIELDS: string[] = [
  '_Sort Order', 'address_id', '_SitusHouseNo', '_SitusDirection', '_SitusStreet',
  '_SitusUnit', 'House', 'Street', 'City', 'State', 'Zip', 'Latitude', 'Longitude',
  'APN', 'resident_id', 'Resident Name', 'First Name', 'Middle Name', 'Last Name',
  'Age', 'Gender', 'Home Phone', 'Cell', 'Email', 'Damage', 'Address Plan',
  'Build Status', 'Person - Renter', 'Person - Needs Follow-Up',
  'Person - Unable to Reach', 'Person Notes', 'Last Outreach Attempt Date',
  'Outreach Log', 'Address Notes', 'Address - Unit Type', 'Captain Assigned',
  'Address - For Sale', 'Address - Sold Since Fire', 'Latest Sale Date',
  'Latest Sale Price', 'Latest New Owner', 'Lot SqFt', 'Sales History',
  'Former Resident', 'Deceased', 'Wants_Updates', 'ZoneName', 'NC Name',
  'NC Phone', 'NC Email', 'Remediation Status', 'Successfully Contacted',
];

// Heuristic type inference for the seed (Operator can correct any of these).
const NUMBER_FIELDS = new Set(['_Sort Order', 'Age', 'Latitude', 'Longitude', 'Latest Sale Price', 'Lot SqFt']);
const DATE_FIELDS = new Set(['Last Outreach Attempt Date', 'Latest Sale Date']);

function inferType(name: string): DataType {
  if (CHECKBOX.has(name)) return 'checkbox';
  if (NUMBER_FIELDS.has(name)) return 'number';
  if (DATE_FIELDS.has(name)) return 'date';
  return 'text';
}

export function buildSeed(): SeedField[] {
  return MASTER_FIELDS.map((name, i) => ({
    canonical_name: name,
    data_type: inferType(name),
    is_identity: IDENTITY.has(name) ? 1 : 0,
    is_sensitive: SENSITIVE.has(name) ? 1 : 0,
    is_text_safe: TEXT_SAFE.has(name) ? 1 : 0,
    default_policy: (IDENTITY.has(name) ? 'never' : 'fill_blank') as Policy,
    notes: name === 'ZoneName' ? 'Zone is inferred as the mode of this column per captain sheet.' : '',
    sort_order: i,
    aliases: EXTRA_ALIASES[name] || [],
  }));
}

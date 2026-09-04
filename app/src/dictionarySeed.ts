// Seed data for the Field Dictionary — the canonical list of logical fields the
// whole tool reasons about. Derived from the real master schema (52 fields;
// SHEETSMART_VISION_AND_ROADMAP.md Appendix A) plus the identity/type/text-safe
// facts the legacy tool relies on (handoff 1.5 / legacy Code.gs).
//
// Most settings are editable by the Operator. The seven Zone Dashboard-owned
// sales fields are the exception: their distribution, write policy, and
// ownership note are enforced by the API and startup migration.
//
// Defaults reasoning:
// - default_policy 'fill_blank' everywhere (fill blanks only), except the
//   identity key and Zone Dashboard-owned sales fields, which are 'never'.
// - Checkboxes: approved binary fields use blank/false as unchecked and true
//   as checked. This list is intentionally explicit rather than inferred.
// - text-safe: APN, resident_id, address_id, Zip, _SitusUnit (Appendix A) — must
//   be written RAW so Sheets can't mangle IDs/zips into dates/numbers.
// - sensitive: the clear resident PII (contact details + free-text notes) so a
//   push to a captain sheet flags them for confirmation. Informational only.

import type { DataType } from './db';
import {
  isZoneDashboardSalesField,
  ZONE_DASHBOARD_SALES_FIELDS,
  ZONE_DASHBOARD_SALES_NOTE,
} from './lib/salesFieldPolicy';
import type { Policy } from './lib/writeGuard';

// A single seed row: the field's dictionary attributes plus its known aliases.
export interface SeedField {
  canonical_name: string;
  data_type: DataType;
  is_identity: 0 | 1;
  is_sensitive: 0 | 1;
  is_text_safe: 0 | 1;
  distribute_to_captain: 0 | 1;
  default_policy: Policy;
  notes: string;
  sort_order: number;
  aliases: string[];
}

const IDENTITY = new Set(['resident_id']);
export const APPROVED_BOOLEAN_FIELDS = [
  'Wants_Updates',
  'Former Resident',
  'Deceased',
  'Person - Needs Follow-Up',
  'Person - Unable to Reach',
  'Person - Renter',
  'Successfully Contacted',
] as const;
const CHECKBOX = new Set([
  'Address - For Sale',
  'Address - Sold Since Fire',
  ...APPROVED_BOOLEAN_FIELDS,
]);
const TEXT_SAFE = new Set(['APN', 'resident_id', 'address_id', 'Zip', '_SitusUnit']);
const MASTER_ONLY = new Set<string>([...ZONE_DASHBOARD_SALES_FIELDS, 'House', 'Street']);
const SENSITIVE = new Set([
  'Age',
  'Gender',
  'Home Phone',
  'Cell',
  'Email',
  'Damage',
  'Address Plan',
  'Build Status',
  'Person - Renter',
  'Person - Needs Follow-Up',
  'Person - Unable to Reach',
  'Person Notes',
  'Last Outreach Attempt Date',
  'Outreach Log',
  'Address Notes',
  'Former Resident',
  'Deceased',
  'Wants_Updates',
  'Remediation Status',
  'Successfully Contacted',
  'NC Phone',
  'NC Email',
]);

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
  'Former Resident', 'Deceased', 'Deleted Record', 'Wants_Updates', 'ZoneName', 'NC Name',
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
    distribute_to_captain: MASTER_ONLY.has(name) ? 0 : 1,
    default_policy: (IDENTITY.has(name) || isZoneDashboardSalesField(name) ? 'never' : 'fill_blank') as Policy,
    notes: isZoneDashboardSalesField(name)
      ? ZONE_DASHBOARD_SALES_NOTE
      : name === 'ZoneName'
        ? 'Zone is inferred as the mode of this column per captain sheet.'
        : '',
    sort_order: i,
    aliases: EXTRA_ALIASES[name] || [],
  }));
}

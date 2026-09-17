/**
 * Sales data is owned by Zone Dashboard's central source. SheetSmart keeps
 * these historical master columns readable, but never moves values into them
 * from captain sheets or distributes them back to captains.
 */
export const ZONE_DASHBOARD_SALES_FIELDS = [
  'Address - For Sale',
  'Address - Sold Since Fire',
  'Latest Sale Date',
  'Latest Sale Price',
  'Latest New Owner',
  'Lot SqFt',
  'Sales History',
] as const;

export const ZONE_DASHBOARD_SALES_NOTE =
  'Owned by Zone Dashboard central sales data. Retained on the master for history; SheetSmart never imports this field from captain sheets or distributes it to captains.';

const SALES_FIELD_KEYS = new Set<string>(
  ZONE_DASHBOARD_SALES_FIELDS.map((field) => field.toLocaleLowerCase())
);

export function isZoneDashboardSalesField(column: string): boolean {
  return SALES_FIELD_KEYS.has(String(column || '').trim().toLocaleLowerCase());
}

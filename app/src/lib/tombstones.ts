import type { Grid } from './mergeEngine';
import type { Tombstone } from './deletionEngine';
import type * as database from '../db';

export function loadActiveTombstones(db: typeof database): Tombstone[] {
  return [
    ...db
      .all<{ resident_id: string }>('SELECT resident_id FROM resident_tombstones WHERE active=1')
      .map<Tombstone>((row) => ({ kind: 'resident', id: row.resident_id })),
    ...db
      .all<{ address_id: string }>('SELECT address_id FROM address_tombstones WHERE active=1')
      .map<Tombstone>((row) => ({ kind: 'address', id: row.address_id })),
  ];
}

export function filterGridByTombstones(
  grid: Grid,
  tombstones: Tombstone[],
  options: { residentHeader?: string | null; addressHeader?: string | null } = {}
): Grid {
  if (grid.length === 0 || tombstones.length === 0) return grid;
  const headers = (grid[0] || []).map((value) => String(value ?? '').trim());
  const residentCol = headers.indexOf(options.residentHeader || 'resident_id');
  const addressCol = headers.indexOf(options.addressHeader || 'address_id');
  if (residentCol === -1 && addressCol === -1) return grid;
  const residentIds = new Set(
    tombstones.filter((item) => item.kind === 'resident').map((item) => item.id)
  );
  const addressIds = new Set(
    tombstones.filter((item) => item.kind === 'address').map((item) => item.id)
  );
  return [
    [...(grid[0] || [])],
    ...grid.slice(1).filter((row) => {
      const residentId = residentCol === -1 ? '' : String(row?.[residentCol] ?? '').trim();
      const addressId = addressCol === -1 ? '' : String(row?.[addressCol] ?? '').trim();
      return !residentIds.has(residentId) && !addressIds.has(addressId);
    }),
  ];
}

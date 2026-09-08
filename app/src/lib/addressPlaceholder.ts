import type { CellValue } from './values';

export const ADDRESS_PLACEHOLDER_COLUMN = 'Address Placeholder';
export const ADDRESS_PLACEHOLDER_NAME = 'Placeholder Resident';

export function isAddressPlaceholderValue(value: CellValue | undefined): boolean {
  return value === true || String(value ?? '').trim().toUpperCase() === 'TRUE';
}

export function isAddressPlaceholderName(value: CellValue | undefined): boolean {
  return String(value ?? '').trim().toLowerCase() === ADDRESS_PLACEHOLDER_NAME.toLowerCase();
}

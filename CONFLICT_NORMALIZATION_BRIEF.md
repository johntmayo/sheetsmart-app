# Conflict Normalization Brief

## Purpose

SheetSmart is surfacing conflicts when the master and captain sheets contain values that look different to the application but mean the same thing. This brief records the investigation findings and a recommended approach for correcting the data and improving the application.

## What the investigation found

The current Conflict Inbox contains 292 open conflicts, all retained from one live pull-to-master run on August 3, 2026. They are historical records and are not automatically revalidated against the current Google Sheets values.

At least 222 of the 292 conflicts (76%) are demonstrable false positives:

- 126 show `false` on both sides. The original cells likely used different underlying representations, such as a checkbox boolean on one sheet and the text `"false"` on the other.
- 96 compare a readable date with the equivalent Google Sheets date serial.
- Two other date conflicts are genuine disagreements rather than formatting differences.
- The remaining 68 conflicts may be legitimate content differences and should be reviewed individually.

Long notes may look identical in the table because the UI truncates them, but the application compares their full contents.

## Why this happens

SheetSmart reads Google Sheets using `UNFORMATTED_VALUE`. This preserves useful raw values, but it means:

- A real Sheets date usually arrives as a number such as `46211`.
- A date stored as plain text may arrive as `"7/8/2026"`.
- A checkbox arrives as a boolean `true` or `false`.
- A cell containing typed text may arrive as `"true"` or `"false"`.
- Empty cells may be omitted and appear as blank or `undefined`.

The comparison code performs generic normalization, but it does not use the field type recorded in the Field Dictionary. Consequently:

- It does not convert a Sheets date serial into a calendar date before comparing it with date text.
- Boolean `false` and text `"false"` can follow different comparison paths.
- Date-like text is interpreted without knowing whether the column is actually a date or an identifier.
- The `is_text_safe` designation for fields such as `_SitusUnit`, ZIP, APN, and IDs does not currently affect comparison behavior.

The conflict record then converts both values to text for storage and display. That is why two originally different value types can both appear as `false` in the inbox.

## Apartment and unit values

Unit identifiers containing slashes, such as `1/2`, need special treatment. If the cell remains plain text, SheetSmart can preserve and compare it safely. If Google Sheets has already interpreted the entry as a date, however, the original user input may be lost.

For example, after Sheets converts a unit entry to an internal date serial, the application cannot reliably determine whether the user intended:

- an apartment identifier,
- a fraction,
- or an actual date.

SheetSmart should detect and flag this situation, but it should not guess. Manual correction is the safe response.

## Recommended data cleanup

1. Confirm which columns are genuinely checkbox fields. The current dictionary identifies only `Address - For Sale` and `Address - Sold Since Fire`, although fields such as `Former Resident`, `Wants_Updates`, and `Person - Needs Follow-Up` also appear to contain boolean values.
2. Standardize confirmed checkbox columns with Google Sheets checkbox validation across the master and captain templates.
3. Standardize confirmed date columns as date-formatted cells rather than a mixture of dates and plain text.
4. Format `_SitusUnit`, ZIP, APN, `resident_id`, and `address_id` columns as plain text before entering or pasting data.
5. Manually correct any unit value that Sheets has already converted to a date.
6. Review the 68 remaining non-obvious conflicts individually.
7. Preserve the two genuine date disagreements for an operator decision rather than normalizing them away.

## Recommended application changes

### 1. Use field-aware comparison

Pass Field Dictionary metadata into the comparison engine and normalize according to the declared field type:

- **Checkbox:** compare booleans, boolean-looking text, and the agreed blank/unchecked representation consistently.
- **Date:** convert Sheets serials and accepted date strings to a timezone-independent calendar date before comparison.
- **Number:** compare canonical numeric values.
- **Text or text-safe:** compare as text and never apply date or numeric coercion.

Normalization must be column-specific. A global rule that treats every number as a possible date would create new errors.

### 2. Define checkbox semantics explicitly

Decide whether blank and unchecked are equivalent for each checkbox field. Do not treat `false` as blank globally.

The current global target-side rule treats `false` as blank. Under a `fill_blank` policy, this can allow an incoming `true` to replace an existing `false` as an automatic fill. That behavior should be reviewed as a safety issue while implementing typed checkbox handling.

### 3. Revalidate the Conflict Inbox

Before presenting or applying an old conflict:

1. Read the current master and captain cells.
2. Compare them using the field-aware rules.
3. Mark the conflict resolved or obsolete if the values are now equivalent.
4. Mark it stale if either side changed materially.
5. Keep genuine disagreements open.

This should preserve the historical audit record rather than deleting rows.

### 4. Preserve typed conflict context

Store enough context to distinguish the original value types and provide readable display values. Useful fields include:

- raw value,
- formatted value,
- field type,
- normalized comparison key,
- checkbox validation or effective cell format when available.

This would let the UI explain that `46211` and `7/8/2026` represent the same date instead of displaying an unexplained number.

### 5. Detect suspected text coercion

For text-safe columns, flag cells that have a numeric raw value and a date-like effective format. Show these as suspected Google Sheets coercion and require manual correction. Do not automatically convert them back into guessed unit identifiers.

### 6. Improve conflict presentation

The Conflict Inbox should:

- display date serials as calendar dates for declared date fields,
- display checkbox states consistently,
- distinguish blank from unchecked when the field semantics require it,
- allow long values to be expanded,
- show why the conflict was created,
- and identify stale or historical conflicts.

## Suggested implementation order

1. Add table-driven tests for checkbox shapes, date serials, text-safe identifiers, and slash-containing units.
2. Wire Field Dictionary `data_type` and `is_text_safe` metadata into pull and merge comparisons.
3. Implement strict typed normalization.
4. Correct the global `false`-as-blank behavior.
5. Add fresh conflict revalidation and historical cleanup behavior.
6. Preserve typed/raw/formatted context in new conflict records.
7. Improve the Conflict Inbox display.
8. Add a read-only sheet-health report for inconsistent checkbox validation, date formatting, and text-safe columns.
9. Only after review, consider an explicitly approved formatting-repair workflow for Google Sheets.

## Acceptance cases

An implementation should demonstrate at least the following:

- Date serial `46211` equals `7/8/2026` in a declared date column.
- Date serial `46213` does not equal `7/8/2026`.
- Boolean `false` equals text `"false"` in a declared checkbox column.
- Checkbox behavior for blank versus unchecked matches an explicitly documented rule.
- Text `"false"` remains text in a normal text column.
- Unit `1/2` remains text in `_SitusUnit`.
- A date-coerced value in `_SitusUnit` is flagged for review, not automatically repaired.
- ZIP and identifier values preserve leading zeroes and are never date-normalized.
- Revalidation closes equivalent historical conflicts without removing their audit history.

## Bottom line

The inconsistent Google Sheets formatting is real, but SheetSmart can prevent most of it from becoming operator-facing conflicts. Date and checkbox equivalence can be handled safely when comparison is driven by declared field types. Apartment units that have already been converted by Google Sheets are the important exception: the application can detect them, but manual correction is safer than attempting to reconstruct lost intent.

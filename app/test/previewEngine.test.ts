import test from 'node:test';
import assert from 'node:assert';
import {
  buildCellFillConfig,
  resolveFieldHeader,
  summarizeCellFill,
  summarizePushMissing,
  type DictField,
} from '../src/lib/previewEngine';
import { buildSourceLookup, planCellFill, planPushMissingResidents } from '../src/lib/mergeEngine';

const DICT: DictField[] = [
  { canonical_name: 'resident_id', is_identity: 1, is_sensitive: 0, default_policy: 'never', aliases: ['resident id'] },
  { canonical_name: 'Cell', is_identity: 0, is_sensitive: 1, default_policy: 'fill_blank', aliases: ['mobile'] },
  { canonical_name: 'Damage', is_identity: 0, is_sensitive: 0, default_policy: 'fill_blank', aliases: [] },
  { canonical_name: 'Build Status', is_identity: 0, is_sensitive: 0, default_policy: 'overwrite', aliases: [] },
];

test('resolveFieldHeader matches canonical name or an alias, drift-tolerant', () => {
  const field = DICT[1]; // Cell / mobile
  assert.strictEqual(resolveFieldHeader(field, ['resident_id', 'Cell']), 'Cell');
  assert.strictEqual(resolveFieldHeader(field, ['resident_id', 'Mobile']), 'Mobile'); // alias, case-insensitive
  assert.strictEqual(resolveFieldHeader(field, ['resident_id']), null);
});

test('buildCellFillConfig resolves match key on each side and maps fields by dictionary', () => {
  const master = ['resident_id', 'Cell', 'Damage', 'Build Status'];
  const captain = ['Resident ID', 'Mobile', 'Damage']; // drifted key + alias; no Build Status
  const cfg = buildCellFillConfig(master, captain, 'resident_id', DICT);

  assert.strictEqual(cfg.matchSourceHeader, 'resident_id');
  assert.strictEqual(cfg.matchTargetHeader, 'Resident ID'); // resolved via alias despite drift
  // Cell->Mobile and Damage->Damage map; Build Status is source-only -> unmatched.
  assert.deepStrictEqual(
    cfg.columnMap.sort((a, b) => a.source.localeCompare(b.source)),
    [
      { source: 'Cell', target: 'Mobile' },
      { source: 'Damage', target: 'Damage' },
    ],
  );
  assert.ok(cfg.unmatchedFields.includes('Build Status'));
  assert.strictEqual(cfg.policies['Mobile'], 'fill_blank');
  assert.ok(cfg.protectedColumns.includes('Resident ID'));
});

test('buildCellFillConfig config drives planCellFill end to end across drift', () => {
  const masterGrid = [
    ['resident_id', 'Cell', 'Damage'],
    ['R1', '555-1', 'Major'],
    ['R2', '555-2', 'Minor'],
  ];
  const captainGrid = [
    ['Resident ID', 'Mobile', 'Damage'], // drifted key + alias
    ['R1', '', 'Major'], // Mobile blank -> fill; Damage equal -> no-op
    ['R2', '999', ''], // Mobile differs -> conflict (fill_blank); Damage blank -> fill
  ];
  const cfg = buildCellFillConfig(masterGrid[0], captainGrid[0], 'resident_id', DICT);
  const { lookup } = buildSourceLookup(masterGrid, cfg.matchSourceHeader!);
  const plan = planCellFill(captainGrid, lookup, cfg.matchTargetHeader!, cfg.columnMap, {
    policies: cfg.policies,
    protectedColumns: cfg.protectedColumns,
    defaultPolicy: 'fill_blank',
  });

  assert.strictEqual(plan.filled.length, 2); // R1 Mobile, R2 Damage
  assert.strictEqual(plan.conflicts.length, 1); // R2 Mobile 999 vs 555-2
  assert.strictEqual(plan.overwritten.length, 0);
});

test('summarizeCellFill produces plain-language, reassuring impact text', () => {
  const master = [
    ['resident_id', 'Cell', 'Damage'],
    ['R1', '555-1', 'Major'],
  ];
  const captain = [
    ['resident_id', 'Cell', 'Damage'],
    ['R1', '', ''],
  ];
  const cfg = buildCellFillConfig(master[0], captain[0], 'resident_id', DICT);
  const { lookup } = buildSourceLookup(master, cfg.matchSourceHeader!);
  const plan = planCellFill(captain, lookup, cfg.matchTargetHeader!, cfg.columnMap, {
    policies: cfg.policies,
    defaultPolicy: 'fill_blank',
  });
  const impact = summarizeCellFill([plan]);
  assert.strictEqual(impact.filled, 2);
  assert.match(impact.headline, /fill 2 blank cells/);
  assert.match(impact.detail, /Nothing would be overwritten/);
});

test('summarizePushMissing describes appends and sensitive flags in plain language', () => {
  const master = [
    ['resident_id', 'ZoneName', 'Resident Name', 'Cell'],
    ['R1', 'Zone A', 'Ann', '555-1'],
    ['R2', 'Zone A', 'Bob', '555-2'],
  ];
  const captain = [
    ['resident_id', 'ZoneName', 'Resident Name', 'Cell'],
    ['R1', 'Zone A', 'Ann', ''],
  ];
  const plan = planPushMissingResidents(captain, master, { sensitiveColumns: ['Cell'] });
  const impact = summarizePushMissing([plan]);
  assert.strictEqual(impact.appended, 1);
  assert.strictEqual(impact.flagged, 1);
  assert.match(impact.headline, /add 1 new resident/);
  assert.match(impact.detail, /sensitive contact info/);
});

import test from 'node:test';
import assert from 'node:assert';
import { buildSeed } from '../src/dictionarySeed';
import { PREVIEW_PLAYBOOKS } from '../src/routes/preview.routes';
import { WORKFLOW_TYPES } from '../src/routes/workflows.routes';
import { ZONE_DASHBOARD_SALES_FIELDS, ZONE_DASHBOARD_SALES_NOTE } from '../src/lib/salesFieldPolicy';

test('sales import is absent from current preview and workflow catalogs', () => {
  assert.ok(!PREVIEW_PLAYBOOKS.some((playbook) => String(playbook.key) === 'import_sales'));
  assert.ok(!WORKFLOW_TYPES.some((workflow) => workflow.type === 'import_to_master'));
  assert.ok(WORKFLOW_TYPES.some((workflow) => /Resident \/ Non-sales Fields/.test(workflow.label)));
});

test('all Zone Dashboard sales fields seed with permanent master-only settings', () => {
  const byName = new Map(buildSeed().map((field) => [field.canonical_name, field]));

  for (const name of ZONE_DASHBOARD_SALES_FIELDS) {
    const field = byName.get(name);
    assert.ok(field, `${name} should remain in the master dictionary`);
    assert.strictEqual(field.distribute_to_captain, 0);
    assert.strictEqual(field.default_policy, 'never');
    assert.strictEqual(field.notes, ZONE_DASHBOARD_SALES_NOTE);
  }
});

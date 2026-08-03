import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { exportSchema, verifyBundle } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('exportSchema produces a self-verifying bundle', async () => {
  await f.seedExportScenario();
  const bundle = await exportSchema(f.pool, { schema: f.schema });

  assert.equal(bundle.version, 1);
  assert.equal(bundle.schema, f.schema);
  assert.deepEqual(verifyBundle(bundle), { ok: true, problems: [] });

  const table = bundle.tables.find((t) => t.name === 'test_table');
  assert.deepEqual(table.columns.map((c) => c.name), ['id', 'test_column']);
  assert.equal(table.rows.length, 2);
  assert.ok(
    bundle.registry.some((r) => r.dropped_at && r.column_name === 'doomed'),
    'tombstones travel in the bundle',
  );
});

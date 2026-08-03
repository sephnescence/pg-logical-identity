import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { exportSchema, ops, verifyBundle } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('export refuses a drifted schema', async () => {
  await f.seedExportScenario();
  await f.pool.query(`ALTER TABLE ${f.schema}.test_table RENAME COLUMN test_column TO sneaky`);
  await assert.rejects(exportSchema(f.pool, { schema: f.schema }), /drift/);

  await f.run(ops.reconcile, { schema: f.schema });
  const bundle = await exportSchema(f.pool, { schema: f.schema });
  assert.deepEqual(verifyBundle(bundle), { ok: true, problems: [] }, 'exports after healing');
});

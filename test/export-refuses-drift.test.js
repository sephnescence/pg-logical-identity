import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { exportSchema, ops, verifyBundle } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('export refuses a drifted schema', async () => {
  await f.seedExportScenario();
  await f.pool.query(`ALTER TABLE ${f.schema}.test_table RENAME COLUMN test_column TO sneaky`);
  await expect(exportSchema(f.pool, { schema: f.schema })).rejects.toThrow(/drift/);

  await f.run(ops.reconcile, { schema: f.schema });
  const bundle = await exportSchema(f.pool, { schema: f.schema });
  expect(verifyBundle(bundle)).toEqual({ ok: true, problems: [] }); // exports after healing
});

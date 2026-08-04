import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { exportSchema, verifyBundle, importSchema } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('verifyBundle catches a tampered bundle and import refuses it untouched', async () => {
  await f.seedExportScenario();
  const target = await f.createTargetDb();
  const bundle = await exportSchema(f.pool, { schema: f.schema });

  const bad = structuredClone(bundle);
  bad.tables[0].columns = bad.tables[0].columns.filter((c) => c.name !== 'test_column');

  const check = verifyBundle(bad);
  expect(check.ok).toBe(false);
  expect(check.problems.some((p) => p.includes('test_table.test_column'))).toBeTruthy();

  await expect(importSchema(target, { bundle: bad })).rejects.toThrow(/failed verification/);
  const { rows } = await target.query(
    `SELECT 1 FROM pg_namespace WHERE nspname = $1`, [f.schema],
  );
  expect(rows.length).toBe(0); // nothing was created in the target database
});

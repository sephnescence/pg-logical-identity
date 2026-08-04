import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { ops, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('out-of-band created objects are reported as untracked', async () => {
  await f.seedTenant();
  await f.pool.query(`CREATE TABLE ${f.schema}.rogue (x integer)`);
  await f.pool.query(`ALTER TABLE ${f.schema}.test_table ADD COLUMN rogue_col integer`);

  const report = await verify(f.pool, f.schema);
  expect(report.ok).toBe(false);
  const statuses = report.drift.map((d) => `${d.kind}:${d.status}:${d.actual}`).sort();
  expect(statuses).toEqual(['column:untracked:rogue_col', 'table:untracked:rogue']);

  // untracked drift is a human decision, not auto-healed
  const { healed, remaining } = await f.run(ops.reconcile, { schema: f.schema });
  expect(healed).toBe(0);
  expect(remaining.length).toBe(2);
});

import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { ops, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('out-of-band table drop is reported as missing, not healed', async () => {
  await f.seedTenant();
  await f.pool.query(`DROP TABLE ${f.schema}.test_table`);

  const report = await verify(f.pool, f.schema);
  expect(report.ok).toBe(false);
  const missing = report.drift.filter((d) => d.status === 'missing');
  expect(missing.filter((d) => d.kind === 'table').length).toBe(1);
  expect(missing.filter((d) => d.kind === 'column').length).toBe(1);

  const { healed, remaining } = await f.run(ops.reconcile, { schema: f.schema });
  expect(healed).toBe(0);
  expect(remaining.length).toBe(2);
});

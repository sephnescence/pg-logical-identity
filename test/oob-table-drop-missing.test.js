import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('out-of-band table drop is reported as missing, not healed', async () => {
  await f.seedTenant();
  await f.pool.query(`DROP TABLE ${f.schema}.test_table`);

  const report = await verify(f.pool, f.schema);
  assert.equal(report.ok, false);
  const missing = report.drift.filter((d) => d.status === 'missing');
  assert.equal(missing.filter((d) => d.kind === 'table').length, 1);
  assert.equal(missing.filter((d) => d.kind === 'column').length, 1);

  const { healed, remaining } = await f.run(ops.reconcile, { schema: f.schema });
  assert.equal(healed, 0);
  assert.equal(remaining.length, 2);
});

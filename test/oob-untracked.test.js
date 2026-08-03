import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('out-of-band created objects are reported as untracked', async () => {
  await f.seedTenant();
  await f.pool.query(`CREATE TABLE ${f.schema}.rogue (x integer)`);
  await f.pool.query(`ALTER TABLE ${f.schema}.test_table ADD COLUMN rogue_col integer`);

  const report = await verify(f.pool, f.schema);
  assert.equal(report.ok, false);
  const statuses = report.drift.map((d) => `${d.kind}:${d.status}:${d.actual}`).sort();
  assert.deepEqual(statuses, ['column:untracked:rogue_col', 'table:untracked:rogue']);

  // untracked drift is a human decision, not auto-healed
  const { healed, remaining } = await f.run(ops.reconcile, { schema: f.schema });
  assert.equal(healed, 0);
  assert.equal(remaining.length, 2);
});

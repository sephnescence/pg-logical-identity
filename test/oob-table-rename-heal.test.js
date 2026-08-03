import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('out-of-band table rename is detected by oid and healed', async () => {
  const ids = await f.seedTenant();
  await f.pool.query(`ALTER TABLE ${f.schema}.test_table RENAME TO sneaky_table`);

  const report = await verify(f.pool, f.schema);
  const tableDrift = report.drift.find((d) => d.kind === 'table');
  assert.deepEqual(tableDrift, {
    logicalId: ids.tableId,
    kind: 'table',
    status: 'renamed',
    expected: 'test_table',
    actual: 'sneaky_table',
  });

  const { healed } = await f.run(ops.reconcile, { schema: f.schema });
  assert.ok(healed >= 1);
  assert.equal((await verify(f.pool, f.schema)).ok, true);
});

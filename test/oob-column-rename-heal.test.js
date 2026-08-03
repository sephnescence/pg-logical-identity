import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, verify, getByLogicalId } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('out-of-band column rename is detected by identity and healed', async () => {
  const ids = await f.seedTenant();
  await f.pool.query(`ALTER TABLE ${f.schema}.test_table RENAME COLUMN test_column TO sneaky`);

  const report = await verify(f.pool, f.schema);
  assert.equal(report.ok, false);
  assert.deepEqual(report.drift, [{
    logicalId: ids.columnIds.test_column,
    kind: 'column',
    status: 'renamed',
    expected: 'test_column',
    actual: 'sneaky',
    tableName: 'test_table',
  }]);

  const { healed, remaining } = await f.run(ops.reconcile, { schema: f.schema });
  assert.equal(healed, 1);
  assert.deepEqual(remaining, []);
  assert.equal((await verify(f.pool, f.schema)).ok, true);
  assert.equal(
    (await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema)).column_name,
    'sneaky',
    'registry adopted the catalog name — same logical id throughout',
  );
});

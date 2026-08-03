import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('dropColumn tombstones the registry row and the catalog attnum', async () => {
  await f.seedTenant();
  const { logicalId } = await f.run(ops.addColumn, {
    schema: f.schema, table: 'test_table', name: 'extra_col', type: 'integer',
  });
  await f.run(ops.dropColumn, { schema: f.schema, table: 'test_table', name: 'extra_col' });

  const row = await getByLogicalId(f.pool, logicalId, f.schema);
  assert.notEqual(row.dropped_at, null);

  const { rows } = await f.pool.query(
    `SELECT attisdropped FROM pg_attribute WHERE attrelid = $1::oid AND attnum = 2`,
    [row.table_oid],
  );
  assert.equal(rows[0].attisdropped, true, 'catalog keeps a tombstone at attnum 2');
  assert.equal((await verify(f.pool, f.schema)).ok, true, 'dropped rows are excluded from verify');
});

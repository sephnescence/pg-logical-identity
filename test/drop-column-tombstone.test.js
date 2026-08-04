import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('dropColumn tombstones the registry row and the catalog attnum', async () => {
  await f.seedTenant();
  const { logicalId } = await f.run(ops.addColumn, {
    schema: f.schema, table: 'test_table', name: 'extra_col', type: 'integer',
  });
  await f.run(ops.dropColumn, { schema: f.schema, table: 'test_table', name: 'extra_col' });

  const row = await getByLogicalId(f.pool, logicalId, f.schema);
  expect(row.dropped_at).not.toBe(null);

  const { rows } = await f.pool.query(
    `SELECT attisdropped FROM pg_attribute WHERE attrelid = $1::oid AND attnum = 2`,
    [row.table_oid],
  );
  expect(rows[0].attisdropped).toBe(true); // catalog keeps a tombstone at attnum 2
  expect((await verify(f.pool, f.schema)).ok).toBe(true); // dropped rows are excluded from verify
});

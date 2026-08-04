import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { ops, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('dropTable tombstones the table and all its columns', async () => {
  await f.seedTenant();
  await f.run(ops.dropTable, { schema: f.schema, table: 'test_table' });

  const { rows } = await f.pool.query(
    `SELECT count(*)::int AS n FROM identity_registry.objects
     WHERE schema_name = $1 AND table_name = 'test_table' AND dropped_at IS NULL`,
    [f.schema],
  );
  expect(rows[0].n).toBe(0);
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

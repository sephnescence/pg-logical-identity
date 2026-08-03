import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('dropTable tombstones the table and all its columns', async () => {
  await f.seedTenant();
  await f.run(ops.dropTable, { schema: f.schema, table: 'test_table' });

  const { rows } = await f.pool.query(
    `SELECT count(*)::int AS n FROM identity_registry.objects
     WHERE schema_name = $1 AND table_name = 'test_table' AND dropped_at IS NULL`,
    [f.schema],
  );
  assert.equal(rows[0].n, 0);
  assert.equal((await verify(f.pool, f.schema)).ok, true);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('cloneSchema carries logical ids across schemas with fresh physical identity', async () => {
  const ids = await f.seedTenant();
  const { logicalId: extraId } = await f.run(ops.addColumn, {
    schema: f.schema, table: 'test_table', name: 'extra_col', type: 'integer',
  });
  await f.run(ops.dropColumn, { schema: f.schema, table: 'test_table', name: 'extra_col' });

  const { tables } = await f.run(ops.cloneSchema, { from: f.schema, to: f.clone });
  assert.equal(tables, 1);

  const src = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  const dst = await getByLogicalId(f.pool, ids.columnIds.test_column, f.clone);
  assert.ok(dst, 'same logical id resolves in the clone');
  assert.equal(dst.column_name, 'test_column');
  assert.notEqual(dst.table_oid, src.table_oid, 'clone has its own oid');

  // pg_dump-style compaction: the source has a tombstone at attnum 2, the
  // clone does not — attnums are NOT comparable across clones, logical ids are.
  assert.equal(src.attnum, 1);
  assert.equal(dst.attnum, 1);
  const srcExtra = await getByLogicalId(f.pool, extraId, f.schema);
  assert.notEqual(srcExtra.dropped_at, null);
  assert.equal(await getByLogicalId(f.pool, extraId, f.clone), null,
    'dropped columns do not travel to clones');

  assert.equal((await verify(f.pool, f.schema)).ok, true);
  assert.equal((await verify(f.pool, f.clone)).ok, true);
});

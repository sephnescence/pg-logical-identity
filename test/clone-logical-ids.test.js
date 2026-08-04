import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('cloneSchema carries logical ids across schemas with fresh physical identity', async () => {
  const ids = await f.seedTenant();
  const { logicalId: extraId } = await f.run(ops.addColumn, {
    schema: f.schema, table: 'test_table', name: 'extra_col', type: 'integer',
  });
  await f.run(ops.dropColumn, { schema: f.schema, table: 'test_table', name: 'extra_col' });

  const { tables } = await f.run(ops.cloneSchema, { from: f.schema, to: f.clone });
  expect(tables).toBe(1);

  const src = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  const dst = await getByLogicalId(f.pool, ids.columnIds.test_column, f.clone);
  expect(dst).toBeTruthy(); // same logical id resolves in the clone
  expect(dst.column_name).toBe('test_column');
  expect(dst.table_oid).not.toBe(src.table_oid); // clone has its own oid

  // pg_dump-style compaction: the source has a tombstone at attnum 2, the
  // clone does not — attnums are NOT comparable across clones, logical ids are.
  expect(src.attnum).toBe(1);
  expect(dst.attnum).toBe(1);
  const srcExtra = await getByLogicalId(f.pool, extraId, f.schema);
  expect(srcExtra.dropped_at).not.toBe(null);
  // dropped columns do not travel to clones
  expect(await getByLogicalId(f.pool, extraId, f.clone)).toBe(null);

  expect((await verify(f.pool, f.schema)).ok).toBe(true);
  expect((await verify(f.pool, f.clone)).ok).toBe(true);
});

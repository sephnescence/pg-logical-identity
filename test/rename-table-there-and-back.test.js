import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('renaming a table there and back preserves identity throughout', async () => {
  const ids = await f.seedTenant();
  const original = await getByLogicalId(f.pool, ids.tableId, f.schema);

  await f.run(ops.renameTable, { schema: f.schema, from: 'test_table', to: 'renamed_table' });
  const mid = await getByLogicalId(f.pool, ids.tableId, f.schema);
  expect(mid.table_name).toBe('renamed_table');
  expect(mid.table_oid).toBe(original.table_oid);

  await f.run(ops.renameTable, { schema: f.schema, from: 'renamed_table', to: 'test_table' });
  const back = await getByLogicalId(f.pool, ids.tableId, f.schema);
  expect(back.table_name).toBe('test_table'); // round trip restores the original name
  expect(back.table_oid).toBe(original.table_oid); // oid stable across both renames

  const colRow = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  expect(colRow.table_name).toBe('test_table'); // column rows follow both renames
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

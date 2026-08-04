import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('renameTable preserves oid and keeps column rows linked', async () => {
  const ids = await f.seedTenant();
  const beforeRow = await getByLogicalId(f.pool, ids.tableId, f.schema);
  await f.run(ops.renameTable, { schema: f.schema, from: 'test_table', to: 'renamed_table' });

  const afterRow = await getByLogicalId(f.pool, ids.tableId, f.schema);
  expect(afterRow.table_name).toBe('renamed_table');
  expect(afterRow.table_oid).toBe(beforeRow.table_oid); // oid survives table rename

  const colRow = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  expect(colRow.table_name).toBe('renamed_table'); // column rows follow the table rename
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

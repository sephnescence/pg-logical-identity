import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('renaming a table there and back preserves identity throughout', async () => {
  const ids = await f.seedTenant();
  const original = await getByLogicalId(f.pool, ids.tableId, f.schema);

  await f.run(ops.renameTable, { schema: f.schema, from: 'test_table', to: 'renamed_table' });
  const mid = await getByLogicalId(f.pool, ids.tableId, f.schema);
  assert.equal(mid.table_name, 'renamed_table');
  assert.equal(mid.table_oid, original.table_oid);

  await f.run(ops.renameTable, { schema: f.schema, from: 'renamed_table', to: 'test_table' });
  const back = await getByLogicalId(f.pool, ids.tableId, f.schema);
  assert.equal(back.table_name, 'test_table', 'round trip restores the original name');
  assert.equal(back.table_oid, original.table_oid, 'oid stable across both renames');

  const colRow = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  assert.equal(colRow.table_name, 'test_table', 'column rows follow both renames');
  assert.equal((await verify(f.pool, f.schema)).ok, true);
});

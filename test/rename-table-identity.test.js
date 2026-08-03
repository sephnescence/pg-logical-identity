import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('renameTable preserves oid and keeps column rows linked', async () => {
  const ids = await f.seedTenant();
  const beforeRow = await getByLogicalId(f.pool, ids.tableId, f.schema);
  await f.run(ops.renameTable, { schema: f.schema, from: 'test_table', to: 'renamed_table' });

  const afterRow = await getByLogicalId(f.pool, ids.tableId, f.schema);
  assert.equal(afterRow.table_name, 'renamed_table');
  assert.equal(afterRow.table_oid, beforeRow.table_oid, 'oid survives table rename');

  const colRow = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  assert.equal(colRow.table_name, 'renamed_table', 'column rows follow the table rename');
  assert.equal((await verify(f.pool, f.schema)).ok, true);
});

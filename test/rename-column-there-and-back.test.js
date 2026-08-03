import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('renaming a column there and back preserves identity throughout', async () => {
  const ids = await f.seedTenant();

  await f.run(ops.renameColumn, {
    schema: f.schema, table: 'test_table', from: 'test_column', to: 'renamed_column',
  });
  const mid = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  assert.equal(mid.column_name, 'renamed_column');
  assert.equal(mid.attnum, 1);

  await f.run(ops.renameColumn, {
    schema: f.schema, table: 'test_table', from: 'renamed_column', to: 'test_column',
  });
  const back = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  assert.equal(back.column_name, 'test_column', 'round trip restores the original name');
  assert.equal(back.attnum, 1, 'attnum stable across both renames');

  assert.deepEqual(await f.infoSchemaColumns(f.schema, 'test_table'), ['test_column']);
  assert.equal((await verify(f.pool, f.schema)).ok, true);
});

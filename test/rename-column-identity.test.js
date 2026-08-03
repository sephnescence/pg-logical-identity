import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('renameColumn preserves logical id and attnum', async () => {
  const ids = await f.seedTenant();
  await f.run(ops.renameColumn, {
    schema: f.schema, table: 'test_table', from: 'test_column', to: 'renamed_column',
  });

  const row = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  assert.equal(row.column_name, 'renamed_column');
  assert.equal(row.attnum, 1, 'attnum unchanged by rename');

  const cols = await f.infoSchemaColumns(f.schema, 'test_table');
  assert.ok(cols.includes('renamed_column'));
  assert.ok(!cols.includes('test_column'), 'old name gone from information_schema');
  assert.equal((await verify(f.pool, f.schema)).ok, true);
});

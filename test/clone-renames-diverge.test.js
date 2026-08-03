import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('renames diverge per clone while logical identity stays shared', async () => {
  const ids = await f.seedTenant();
  await f.run(ops.cloneSchema, { from: f.schema, to: f.clone });

  await f.run(ops.renameColumn, {
    schema: f.clone, table: 'test_table', from: 'test_column', to: 'clone_name',
  });

  const src = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  const dst = await getByLogicalId(f.pool, ids.columnIds.test_column, f.clone);
  assert.equal(src.column_name, 'test_column', 'source untouched');
  assert.equal(dst.column_name, 'clone_name', 'clone renamed');
  assert.equal((await verify(f.pool, f.schema)).ok, true);
  assert.equal((await verify(f.pool, f.clone)).ok, true);
});

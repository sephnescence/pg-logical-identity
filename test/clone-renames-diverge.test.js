import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('renames diverge per clone while logical identity stays shared', async () => {
  const ids = await f.seedTenant();
  await f.run(ops.cloneSchema, { from: f.schema, to: f.clone });

  await f.run(ops.renameColumn, {
    schema: f.clone, table: 'test_table', from: 'test_column', to: 'clone_name',
  });

  const src = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  const dst = await getByLogicalId(f.pool, ids.columnIds.test_column, f.clone);
  expect(src.column_name).toBe('test_column'); // source untouched
  expect(dst.column_name).toBe('clone_name'); // clone renamed
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
  expect((await verify(f.pool, f.clone)).ok).toBe(true);
});

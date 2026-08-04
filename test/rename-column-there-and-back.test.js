import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('renaming a column there and back preserves identity throughout', async () => {
  const ids = await f.seedTenant();

  await f.run(ops.renameColumn, {
    schema: f.schema, table: 'test_table', from: 'test_column', to: 'renamed_column',
  });
  const mid = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  expect(mid.column_name).toBe('renamed_column');
  expect(mid.attnum).toBe(1);

  await f.run(ops.renameColumn, {
    schema: f.schema, table: 'test_table', from: 'renamed_column', to: 'test_column',
  });
  const back = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  expect(back.column_name).toBe('test_column'); // round trip restores the original name
  expect(back.attnum).toBe(1); // attnum stable across both renames

  expect(await f.infoSchemaColumns(f.schema, 'test_table')).toEqual(['test_column']);
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

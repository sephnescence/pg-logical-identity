import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { ops, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('renameColumn preserves logical id and attnum', async () => {
  const ids = await f.seedTenant();
  await f.run(ops.renameColumn, {
    schema: f.schema, table: 'test_table', from: 'test_column', to: 'renamed_column',
  });

  const row = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  expect(row.column_name).toBe('renamed_column');
  expect(row.attnum).toBe(1); // attnum unchanged by rename

  const cols = await f.infoSchemaColumns(f.schema, 'test_table');
  expect(cols.includes('renamed_column')).toBeTruthy();
  expect(!cols.includes('test_column')).toBeTruthy(); // old name gone from information_schema
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { addColumn, renameColumn, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('failed events are atomic and retryable', async () => {
  const ids = await f.seedTenant();
  await addColumn(f.pool, {
    schema: f.schema, table: 'test_table', name: 'extra_col2', type: 'integer',
  });

  // Unknown source column: fails before any DDL.
  await expect(
    renameColumn(f.pool, { schema: f.schema, table: 'test_table', from: 'nope', to: 'x' }),
  ).rejects.toThrow(/No tracked column/);

  // Name collision: registry check passes, the ALTER itself fails —
  // the transaction must roll back the registry update too.
  await expect(renameColumn(f.pool, {
    schema: f.schema, table: 'test_table', from: 'test_column', to: 'extra_col2',
  })).rejects.toThrow(/already exists/);
  const row = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  expect(row.column_name).toBe('test_column'); // registry untouched after failed ALTER
  // physical table untouched after failed ALTER
  expect(await f.infoSchemaColumns(f.schema, 'test_table')).toEqual(['test_column', 'extra_col2']);

  // The same logical operation succeeds on retry with a valid target.
  await renameColumn(f.pool, {
    schema: f.schema, table: 'test_table', from: 'test_column', to: 'retried_ok',
  });
  expect((await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema)).column_name).toBe('retried_ok');
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

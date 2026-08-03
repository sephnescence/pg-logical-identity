import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { addColumn, renameColumn, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('failed events are atomic and retryable', async () => {
  const ids = await f.seedTenant();
  await addColumn(f.pool, {
    schema: f.schema, table: 'test_table', name: 'extra_col2', type: 'integer',
  });

  // Unknown source column: fails before any DDL.
  await assert.rejects(
    renameColumn(f.pool, { schema: f.schema, table: 'test_table', from: 'nope', to: 'x' }),
    /No tracked column/,
  );

  // Name collision: registry check passes, the ALTER itself fails —
  // the transaction must roll back the registry update too.
  await assert.rejects(
    renameColumn(f.pool, {
      schema: f.schema, table: 'test_table', from: 'test_column', to: 'extra_col2',
    }),
    /already exists/,
  );
  const row = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  assert.equal(row.column_name, 'test_column', 'registry untouched after failed ALTER');
  assert.deepEqual(
    await f.infoSchemaColumns(f.schema, 'test_table'),
    ['test_column', 'extra_col2'],
    'physical table untouched after failed ALTER',
  );

  // The same logical operation succeeds on retry with a valid target.
  await renameColumn(f.pool, {
    schema: f.schema, table: 'test_table', from: 'test_column', to: 'retried_ok',
  });
  assert.equal(
    (await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema)).column_name,
    'retried_ok',
  );
  assert.equal((await verify(f.pool, f.schema)).ok, true);
});

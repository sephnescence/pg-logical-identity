import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('attnums are never reused after a drop', async () => {
  await f.seedTenant();
  await f.run(ops.addColumn, {
    schema: f.schema, table: 'test_table', name: 'extra_col', type: 'integer',
  });
  await f.run(ops.dropColumn, { schema: f.schema, table: 'test_table', name: 'extra_col' });

  const { attnum } = await f.run(ops.addColumn, {
    schema: f.schema, table: 'test_table', name: 'extra_col2', type: 'integer',
  });
  assert.equal(attnum, 3, 'new column skips the dropped attnum 2');
});

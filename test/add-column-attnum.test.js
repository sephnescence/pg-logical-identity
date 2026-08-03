import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { ops, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('addColumn gets the next attnum and a fresh logical id', async () => {
  const ids = await f.seedTenant();
  const { logicalId, attnum } = await f.run(ops.addColumn, {
    schema: f.schema, table: 'test_table', name: 'extra_col', type: 'integer',
  });
  assert.equal(attnum, 2);
  assert.notEqual(logicalId, ids.columnIds.test_column);
  assert.equal((await verify(f.pool, f.schema)).ok, true);
});

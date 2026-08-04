import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { ops, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('addColumn gets the next attnum and a fresh logical id', async () => {
  const ids = await f.seedTenant();
  const { logicalId, attnum } = await f.run(ops.addColumn, {
    schema: f.schema, table: 'test_table', name: 'extra_col', type: 'integer',
  });
  expect(attnum).toBe(2);
  expect(logicalId).not.toBe(ids.columnIds.test_column);
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

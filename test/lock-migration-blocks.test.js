import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { addColumn, applyEvents, beginMigration, exportSchema, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('migration lock blocks export and untokened events, admits tokened ones', async () => {
  await f.seedTenant();
  const mig = await beginMigration(f.pool, { schema: f.schema, owner: 'test-worker' });
  expect(mig.stale).toBe(null);

  await expect(exportSchema(f.pool, { schema: f.schema })).rejects.toThrow(/migrating/);
  await expect(
    addColumn(f.pool, { schema: f.schema, table: 'test_table', name: 'note', type: 'text' }),
  ).rejects.toThrow(/migrating/);

  // the worker holding the token proceeds
  const results = await applyEvents(
    f.pool,
    [{ op: 'add_column', schema: f.schema, table: 'test_table', name: 'note', type: 'text' }],
    { lockToken: mig.token },
  );
  expect(results[0].logicalId).toBeTruthy();

  // a second worker cannot start a migration while the first is alive
  await expect(
    beginMigration(f.pool, { schema: f.schema, owner: 'other-worker' }),
  ).rejects.toThrow(/held by a live session/);

  await mig.end();
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

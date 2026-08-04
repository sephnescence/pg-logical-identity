import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { applyEvents, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('applyEvents runs a batch of changes as sequential atomic events', async () => {
  await f.pool.query(`CREATE SCHEMA ${f.schema}`);
  const results = await applyEvents(f.pool, [
    { op: 'create_table', schema: f.schema, table: 'events_table', columns: [{ name: 'id', type: 'bigint' }] },
    { op: 'add_column', schema: f.schema, table: 'events_table', name: 'payload', type: 'jsonb' },
    { op: 'rename_column', schema: f.schema, table: 'events_table', from: 'payload', to: 'body' },
  ]);
  expect(results.length).toBe(3);
  expect(await f.infoSchemaColumns(f.schema, 'events_table')).toEqual(['id', 'body']);
  expect((await verify(f.pool, f.schema)).ok).toBe(true);

  // A failing batch reports which event failed; committed prefix stays committed.
  await expect(applyEvents(f.pool, [
    { op: 'add_column', schema: f.schema, table: 'events_table', name: 'extra', type: 'text' },
    { op: 'rename_column', schema: f.schema, table: 'events_table', from: 'ghost', to: 'x' },
  ])).rejects.toMatchObject({
    message: expect.stringMatching(/Event 1 \(rename_column\) failed/),
    failedIndex: 1,
  });
  expect(await f.infoSchemaColumns(f.schema, 'events_table')).toEqual(['id', 'body', 'extra']);
  expect((await verify(f.pool, f.schema)).ok).toBe(true); // registry consistent after partial batch
});

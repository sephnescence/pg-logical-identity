import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { applyEvents, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('applyEvents runs a batch of changes as sequential atomic events', async () => {
  await f.pool.query(`CREATE SCHEMA ${f.schema}`);
  const results = await applyEvents(f.pool, [
    { op: 'create_table', schema: f.schema, table: 'events_table', columns: [{ name: 'id', type: 'bigint' }] },
    { op: 'add_column', schema: f.schema, table: 'events_table', name: 'payload', type: 'jsonb' },
    { op: 'rename_column', schema: f.schema, table: 'events_table', from: 'payload', to: 'body' },
  ]);
  assert.equal(results.length, 3);
  assert.deepEqual(await f.infoSchemaColumns(f.schema, 'events_table'), ['id', 'body']);
  assert.equal((await verify(f.pool, f.schema)).ok, true);

  // A failing batch reports which event failed; committed prefix stays committed.
  await assert.rejects(
    applyEvents(f.pool, [
      { op: 'add_column', schema: f.schema, table: 'events_table', name: 'extra', type: 'text' },
      { op: 'rename_column', schema: f.schema, table: 'events_table', from: 'ghost', to: 'x' },
    ]),
    (err) => {
      assert.match(err.message, /Event 1 \(rename_column\) failed/);
      assert.equal(err.failedIndex, 1);
      return true;
    },
  );
  assert.deepEqual(await f.infoSchemaColumns(f.schema, 'events_table'), ['id', 'body', 'extra']);
  assert.equal((await verify(f.pool, f.schema)).ok, true, 'registry consistent after partial batch');
});

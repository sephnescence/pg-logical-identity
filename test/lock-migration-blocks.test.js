import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { addColumn, applyEvents, beginMigration, exportSchema, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('migration lock blocks export and untokened events, admits tokened ones', async () => {
  await f.seedTenant();
  const mig = await beginMigration(f.pool, { schema: f.schema, owner: 'test-worker' });
  assert.equal(mig.stale, null);

  await assert.rejects(exportSchema(f.pool, { schema: f.schema }), /migrating/);
  await assert.rejects(
    addColumn(f.pool, { schema: f.schema, table: 'test_table', name: 'note', type: 'text' }),
    /migrating/,
  );

  // the worker holding the token proceeds
  const results = await applyEvents(
    f.pool,
    [{ op: 'add_column', schema: f.schema, table: 'test_table', name: 'note', type: 'text' }],
    { lockToken: mig.token },
  );
  assert.ok(results[0].logicalId);

  // a second worker cannot start a migration while the first is alive
  await assert.rejects(
    beginMigration(f.pool, { schema: f.schema, owner: 'other-worker' }),
    /held by a live session/,
  );

  await mig.end();
  assert.equal((await verify(f.pool, f.schema)).ok, true);
});

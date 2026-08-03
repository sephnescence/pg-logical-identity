import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { beginMigration, reconcile, cloneSchema } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('reconcile and cloneSchema pass through the same per-schema gate', async () => {
  await f.seedTenant();
  const mig = await beginMigration(f.pool, { schema: f.schema, owner: 'gate-test' });

  await assert.rejects(reconcile(f.pool, f.schema), /migrating/);
  await assert.rejects(
    cloneSchema(f.pool, { from: f.schema, to: f.clone }),
    /migrating/,
  );
  const { rows } = await f.pool.query(
    `SELECT 1 FROM pg_namespace WHERE nspname = $1`, [f.clone],
  );
  assert.equal(rows.length, 0, 'refused clone left nothing behind');

  // the migration worker itself may reconcile mid-batch with its token
  const { healed } = await reconcile(f.pool, f.schema, { lockToken: mig.token });
  assert.equal(healed, 0);
  await mig.end();
});

import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { beginMigration, reconcile, cloneSchema } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('reconcile and cloneSchema pass through the same per-schema gate', async () => {
  await f.seedTenant();
  const mig = await beginMigration(f.pool, { schema: f.schema, owner: 'gate-test' });

  await expect(reconcile(f.pool, f.schema)).rejects.toThrow(/migrating/);
  await expect(cloneSchema(f.pool, { from: f.schema, to: f.clone })).rejects.toThrow(/migrating/);
  const { rows } = await f.pool.query(
    `SELECT 1 FROM pg_namespace WHERE nspname = $1`, [f.clone],
  );
  expect(rows.length).toBe(0); // refused clone left nothing behind

  // the migration worker itself may reconcile mid-batch with its token
  const { healed } = await reconcile(f.pool, f.schema, { lockToken: mig.token });
  expect(healed).toBe(0);
  await mig.end();
});

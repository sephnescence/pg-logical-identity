import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { beginMigration } from '../src/registry.js';
import { applyMigrations } from '../src/migrate.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('applyMigrations passes through the schema gate like any event', async () => {
  const migrations = [{
    name: '0000_init',
    sql: `CREATE TABLE "users" ("id" bigint NOT NULL);`,
  }];

  const mig = await beginMigration(f.pool, { schema: f.schema, owner: 'test-worker' });
  await expect(
    applyMigrations(f.pool, { schema: f.schema, migrations }),
  ).rejects.toThrow(/migrating/);

  const results = await applyMigrations(f.pool, {
    schema: f.schema, migrations, lockToken: mig.token,
  });
  expect(results[0].skipped).toBe(false);
  await mig.end();
});

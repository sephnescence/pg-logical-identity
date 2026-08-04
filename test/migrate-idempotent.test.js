import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { applyMigrations } from '../src/migrate.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('applied migrations are skipped per schema on re-run', async () => {
  const migrations = [{
    name: '0000_init',
    sql: `CREATE TABLE "users" ("id" bigint NOT NULL);`,
  }];

  const first = await applyMigrations(f.pool, { schema: f.schema, migrations });
  expect(first[0].skipped).toBe(false);

  const second = await applyMigrations(f.pool, { schema: f.schema, migrations });
  expect(second[0].skipped).toBe(true);

  const { rows } = await f.pool.query(
    `SELECT count(*)::int AS n FROM identity_registry.objects WHERE schema_name = $1`,
    [f.schema],
  );
  expect(rows[0].n).toBe(2); // one table + one column, not doubled

  // the same migration list applies independently to a second tenant schema
  const cloneRun = await applyMigrations(f.pool, { schema: f.clone, migrations });
  expect(cloneRun[0].skipped).toBe(false);
});

import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { verify } from '../src/registry.js';
import { applyMigrations } from '../src/migrate.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('ORM drop migrations tombstone identities instead of deleting them', async () => {
  await applyMigrations(f.pool, {
    schema: f.schema,
    migrations: [
      {
        name: '0000_init',
        sql: `CREATE TABLE "users" ("id" bigint NOT NULL, "legacy" text);
              --> statement-breakpoint
              CREATE TABLE "scratch" ("x" integer);`,
      },
      {
        name: '0001_cleanup',
        sql: `ALTER TABLE "users" DROP COLUMN "legacy";--> statement-breakpoint
              DROP TABLE "scratch";`,
      },
    ],
  });

  const { rows } = await f.pool.query(
    `SELECT kind, table_name, column_name, dropped_at FROM identity_registry.objects
     WHERE schema_name = $1 ORDER BY kind DESC, table_name, attnum`,
    [f.schema],
  );
  const tombstoned = rows.filter((r) => r.dropped_at !== null);
  expect(tombstoned.map((r) => `${r.kind}:${r.table_name}:${r.column_name ?? ''}`).sort())
    .toEqual(['column:scratch:x', 'column:users:legacy', 'table:scratch:']);
  expect(rows.filter((r) => r.dropped_at === null)).toHaveLength(2); // users + users.id

  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

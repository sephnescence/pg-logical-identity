import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture, UUID_RE } from './helpers/fixture.js';
import { verify } from '../src/registry.js';
import { applyMigrations } from '../src/migrate.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('an ORM migration creating a table registers table and column identities', async () => {
  const results = await applyMigrations(f.pool, {
    schema: f.schema,
    migrations: [{
      name: '0000_init',
      sql: `CREATE TABLE "users" (
              "id" bigint PRIMARY KEY NOT NULL,
              "email" text NOT NULL
            );
            --> statement-breakpoint
            CREATE UNIQUE INDEX "users_email_idx" ON "users" ("email");`,
    }],
  });

  expect(results[0].sync.registered).toEqual({ tables: 1, columns: 2 });

  const { rows } = await f.pool.query(
    `SELECT logical_id, kind, column_name FROM identity_registry.objects
     WHERE schema_name = $1 AND dropped_at IS NULL ORDER BY kind DESC, attnum`,
    [f.schema],
  );
  expect(rows.map((r) => `${r.kind}:${r.column_name ?? ''}`))
    .toEqual(['table:', 'column:id', 'column:email']);
  for (const r of rows) expect(r.logical_id).toMatch(UUID_RE);

  // the index is passthrough DDL — no registry row, no drift
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

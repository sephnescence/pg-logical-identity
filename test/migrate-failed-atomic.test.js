import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { applyMigrations } from '../src/migrate.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

const m1 = {
  name: '0000_init',
  sql: `CREATE TABLE "users" ("id" bigint NOT NULL);`,
};

test('a failed migration leaves no DDL, registry rows, or applied marker; retry resumes', async () => {
  const bad = {
    name: '0001_broken',
    sql: `ALTER TABLE "users" ADD COLUMN "note" text;--> statement-breakpoint
          CREATE INDEX "oops" ON "no_such_table" ("x");`,
  };

  let err;
  try {
    await applyMigrations(f.pool, { schema: f.schema, migrations: [m1, bad] });
  } catch (e) {
    err = e;
  }
  expect(err.failedIndex).toBe(1);
  expect(err.message).toMatch(/0001_broken/);

  // migration 0 committed; the failed one left nothing — not even its ADD COLUMN
  expect(await f.infoSchemaColumns(f.schema, 'users')).toEqual(['id']);
  const { rows } = await f.pool.query(
    `SELECT name FROM identity_registry.migrations WHERE schema_name = $1`,
    [f.schema],
  );
  expect(rows.map((r) => r.name)).toEqual(['0000_init']);

  // fix the migration and resume — 0000 skips, 0001 applies
  const fixed = {
    name: '0001_broken',
    sql: `ALTER TABLE "users" ADD COLUMN "note" text;`,
  };
  const results = await applyMigrations(f.pool, { schema: f.schema, migrations: [m1, fixed] });
  expect(results.map((r) => r.skipped)).toEqual([true, false]);
  expect(await f.infoSchemaColumns(f.schema, 'users')).toEqual(['id', 'note']);
});

import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { getByLogicalId, verify } from '../src/registry.js';
import { applyMigrations } from '../src/migrate.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

const m1 = {
  name: '0000_init',
  sql: `CREATE TABLE "users" ("id" bigint NOT NULL, "full_name" text);`,
};
// drizzle-kit emits real RENAMEs (it prompts "renamed or new?" on generate) —
// oid/attnum survive them, so identity is healed rather than reminted, even
// with a new column added in the same migration.
const m2 = {
  name: '0001_reshape',
  sql: `ALTER TABLE "users" RENAME TO "accounts";--> statement-breakpoint
        ALTER TABLE "accounts" RENAME COLUMN "full_name" TO "display_name";--> statement-breakpoint
        ALTER TABLE "accounts" ADD COLUMN "created_at" timestamptz;`,
};

test('ORM rename migrations preserve logical identity', async () => {
  await applyMigrations(f.pool, { schema: f.schema, migrations: [m1] });
  const { rows: before } = await f.pool.query(
    `SELECT logical_id, kind FROM identity_registry.objects
     WHERE schema_name = $1 AND (kind = 'table' OR column_name = 'full_name')`,
    [f.schema],
  );
  const tableId = before.find((r) => r.kind === 'table').logical_id;
  const colId = before.find((r) => r.kind === 'column').logical_id;

  const results = await applyMigrations(f.pool, { schema: f.schema, migrations: [m1, m2] });
  expect(results[0].skipped).toBe(true);
  expect(results[1].sync).toMatchObject({ healed: 2, tombstoned: 0 });
  expect(results[1].sync.registered.columns).toBe(1); // created_at is genuinely new

  const table = await getByLogicalId(f.pool, tableId, f.schema);
  expect(table.table_name).toBe('accounts');
  const col = await getByLogicalId(f.pool, colId, f.schema);
  expect(col.column_name).toBe('display_name');
  expect(col.table_name).toBe('accounts');

  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

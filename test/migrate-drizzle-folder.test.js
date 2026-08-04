import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { verify } from '../src/registry.js';
import { applyMigrations, loadDrizzleMigrations } from '../src/migrate.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('a drizzle-kit migrations folder loads via its journal and applies cleanly', async () => {
  const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'drizzle');
  const migrations = loadDrizzleMigrations(folder);
  expect(migrations.map((m) => m.name))
    .toEqual(['0000_flimsy_wolverine', '0001_curved_riptide']);

  const results = await applyMigrations(f.pool, { schema: f.schema, migrations });
  expect(results[0].sync.registered).toEqual({ tables: 1, columns: 3 });
  expect(results[1].sync).toMatchObject({ healed: 1 }); // full_name -> display_name

  expect(await f.infoSchemaColumns(f.schema, 'users'))
    .toEqual(['id', 'display_name', 'email', 'created_at']);
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

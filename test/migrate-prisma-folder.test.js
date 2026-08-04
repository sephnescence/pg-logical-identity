import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { verify } from '../src/registry.js';
import { applyMigrations, loadPrismaMigrations } from '../src/migrate.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('a prisma migrations folder loads in timestamp order and applies cleanly', async () => {
  const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'prisma');
  const migrations = loadPrismaMigrations(folder);
  expect(migrations.map((m) => m.name))
    .toEqual(['20260801120000_init', '20260801130000_add_body']);

  const results = await applyMigrations(f.pool, { schema: f.schema, migrations });
  expect(results[0].sync.registered).toEqual({ tables: 1, columns: 2 });
  expect(results[1].sync.registered.columns).toBe(1);

  expect(await f.infoSchemaColumns(f.schema, 'posts')).toEqual(['id', 'title', 'body']);
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

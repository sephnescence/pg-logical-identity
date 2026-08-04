import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture, UUID_RE } from './helpers/fixture.js';
import { verify } from '../src/registry.js';
import { applyMigrations, loadDrizzleMigrations } from '../src/migrate.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

const TABLE_ID = '11111111-1111-4111-8111-111111111111';
const ID_COL_ID = '22222222-2222-4222-8222-222222222222';
const LABEL_ID = '33333333-3333-4333-8333-333333333333';
const WEIGHT_ID = '44444444-4444-4444-8444-444444444444';

const registryIds = async (schema) => {
  const { rows } = await f.pool.query(
    `SELECT kind, table_name, column_name, logical_id
     FROM identity_registry.objects
     WHERE schema_name = $1 AND dropped_at IS NULL`,
    [schema],
  );
  return Object.fromEntries(rows.map((r) => [
    r.kind === 'table' ? r.table_name : `${r.table_name}.${r.column_name}`,
    r.logical_id,
  ]));
};

test('COMMENT-declared logical ids are registered verbatim, survive renames, and repeat across tenant schemas', async () => {
  const folder = path.join(
    path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'drizzle-declared',
  );
  const migrations = loadDrizzleMigrations(folder);

  await applyMigrations(f.pool, { schema: f.schema, migrations });
  const ids = await registryIds(f.schema);

  // Declared ids adopted verbatim — including the one embedded in prose —
  // and the rename in 0001 carried the label declaration to the new name.
  expect(ids['widget']).toBe(TABLE_ID);
  expect(ids['widget.id']).toBe(ID_COL_ID);
  expect(ids['widget.title']).toBe(LABEL_ID);
  expect(ids['widget.weight']).toBe(WEIGHT_ID);

  // The undeclared column still gets a minted id, distinct from the declared ones.
  expect(ids['widget.internal']).toMatch(UUID_RE);
  expect(Object.values(ids)).toHaveLength(new Set(Object.values(ids)).size);

  expect((await verify(f.pool, f.schema)).ok).toBe(true);

  // A second tenant schema registers the SAME declared ids (and its own
  // fresh mint for the undeclared column) — the cross-tenant anchor that
  // downstream per-column configuration keys on.
  await applyMigrations(f.pool, { schema: f.clone, migrations });
  const cloneIds = await registryIds(f.clone);
  expect(cloneIds['widget']).toBe(TABLE_ID);
  expect(cloneIds['widget.id']).toBe(ID_COL_ID);
  expect(cloneIds['widget.title']).toBe(LABEL_ID);
  expect(cloneIds['widget.weight']).toBe(WEIGHT_ID);
  expect(cloneIds['widget.internal']).not.toBe(ids['widget.internal']);
});

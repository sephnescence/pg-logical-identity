import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { exportSchema, verifyBundle } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('exportSchema produces a self-verifying bundle', async () => {
  await f.seedExportScenario();
  const bundle = await exportSchema(f.pool, { schema: f.schema });

  expect(bundle.version).toBe(1);
  expect(bundle.schema).toBe(f.schema);
  expect(verifyBundle(bundle)).toEqual({ ok: true, problems: [] });

  const table = bundle.tables.find((t) => t.name === 'test_table');
  expect(table.columns.map((c) => c.name)).toEqual(['id', 'test_column']);
  expect(table.rows.length).toBe(2);
  // tombstones travel in the bundle
  expect(bundle.registry.some((r) => r.dropped_at && r.column_name === 'doomed')).toBeTruthy();
});

import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { bootstrap } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('bootstrap is idempotent', async () => {
  // setup() already bootstrapped once — a second run must be a no-op
  await bootstrap(f.pool);
  // scoped to this file's namespace: the registry is shared across the
  // parallel suite, so a global count would see other files' rows
  const { rows } = await f.pool.query(
    `SELECT count(*)::int AS n FROM identity_registry.objects WHERE schema_name = $1`,
    [f.schema],
  );
  expect(rows[0].n).toBe(0);
});

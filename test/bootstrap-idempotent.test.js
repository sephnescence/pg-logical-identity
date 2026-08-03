import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { bootstrap } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('bootstrap is idempotent', async () => {
  // setup() already bootstrapped once — a second run must be a no-op
  await bootstrap(f.pool);
  // scoped to this file's namespace: the registry is shared across the
  // parallel suite, so a global count would see other files' rows
  const { rows } = await f.pool.query(
    `SELECT count(*)::int AS n FROM identity_registry.objects WHERE schema_name = $1`,
    [f.schema],
  );
  assert.equal(rows[0].n, 0);
});

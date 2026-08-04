import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { addColumn, beginMigration, forceUnlock } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('stale migration lock from a crashed worker is detected and reclaimed', async () => {
  await f.seedTenant();
  // simulate a crash: state says migrating, but no session holds the advisory
  // lock (upsert — the fixture seeds through the ungated ops layer, so the
  // control row may not exist yet)
  const goStale = () => f.pool.query(
    `INSERT INTO identity_registry.control (schema_name, state, lock_token, locked_by)
     VALUES ($1, 'migrating', gen_random_uuid(), 'crashed')
     ON CONFLICT (schema_name) DO UPDATE
       SET state = 'migrating', lock_token = gen_random_uuid(), locked_by = 'crashed'`,
    [f.schema],
  );

  await goStale();
  // events refuse the stale state until it is reclaimed
  await expect(
    addColumn(f.pool, { schema: f.schema, table: 'test_table', name: 'x', type: 'text' }),
  ).rejects.toThrow(/migrating/);

  const mig = await beginMigration(f.pool, { schema: f.schema, owner: 'recovery-worker' });
  expect(mig.stale).toBe('migrating'); // takeover reports what it reclaimed
  await mig.end();

  // forceUnlock is the operator-facing variant of the same recovery
  await goStale();
  expect(await forceUnlock(f.pool, { schema: f.schema })).toBe(true);
  const { rows } = await f.pool.query(
    `SELECT state, lock_token FROM identity_registry.control WHERE schema_name = $1`, [f.schema],
  );
  expect(rows).toEqual([{ state: 'idle', lock_token: null }]);

  // but forceUnlock refuses while the holder is alive
  const live = await beginMigration(f.pool, { schema: f.schema, owner: 'live-worker' });
  expect(await forceUnlock(f.pool, { schema: f.schema })).toBe(false);
  await live.end();
});

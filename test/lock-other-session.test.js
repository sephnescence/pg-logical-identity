import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { addColumn, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('events are refused while another worker session owns the schema', async () => {
  await f.seedTenant();
  // another session holding the schema's worker lock (as beginMigration does,
  // seen from outside) — an untokened event must not interleave with it
  const other = await f.pool.connect();
  try {
    await other.query(`SELECT pg_advisory_lock(421001, hashtext($1))`, [f.schema]);
    await expect(
      addColumn(f.pool, { schema: f.schema, table: 'test_table', name: 'x', type: 'text' }),
    ).rejects.toThrow(/owned by another worker session/);
    await other.query(`SELECT pg_advisory_unlock(421001, hashtext($1))`, [f.schema]);
  } finally {
    other.release();
  }
  // once the owner is gone, the same event succeeds — no residue to clean up
  const { logicalId } = await addColumn(f.pool, {
    schema: f.schema, table: 'test_table', name: 'x', type: 'text',
  });
  expect(logicalId).toBeTruthy();
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

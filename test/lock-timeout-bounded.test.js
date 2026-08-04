import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { addColumn, config, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('an event blocked by an application lock times out instead of hanging', async () => {
  await f.seedTenant();
  config.lockTimeout = '250ms';
  const blocker = await f.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE ${f.schema}.test_table IN ACCESS EXCLUSIVE MODE`);
    await expect(
      addColumn(f.pool, { schema: f.schema, table: 'test_table', name: 'never', type: 'text' }),
    ).rejects.toThrow(/lock timeout/);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    config.lockTimeout = '5s';
  }
  // the timed-out event rolled back completely — no column, no registry row
  const { rows } = await f.pool.query(
    `SELECT 1 FROM identity_registry.objects
     WHERE schema_name = $1 AND column_name = 'never'`,
    [f.schema],
  );
  expect(rows.length).toBe(0);
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
});

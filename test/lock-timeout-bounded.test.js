import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { addColumn, config, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('an event blocked by an application lock times out instead of hanging', async () => {
  await f.seedTenant();
  config.lockTimeout = '250ms';
  const blocker = await f.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE ${f.schema}.test_table IN ACCESS EXCLUSIVE MODE`);
    await assert.rejects(
      addColumn(f.pool, { schema: f.schema, table: 'test_table', name: 'never', type: 'text' }),
      /lock timeout/,
    );
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
  assert.equal(rows.length, 0);
  assert.equal((await verify(f.pool, f.schema)).ok, true);
});

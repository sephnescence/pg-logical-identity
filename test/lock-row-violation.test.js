import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { addColumn } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('a concurrent control-row lock fails loudly as an assumption violation', async () => {
  await f.seedTenant();
  // the fixture seeds through the ungated ops layer, so create the control
  // row explicitly — this test is about locking it
  await f.pool.query(
    `INSERT INTO identity_registry.control (schema_name) VALUES ($1)
     ON CONFLICT (schema_name) DO NOTHING`,
    [f.schema],
  );
  const c = await f.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT 1 FROM identity_registry.control WHERE schema_name = $1 FOR UPDATE`, [f.schema],
    );
    await assert.rejects(
      addColumn(f.pool, { schema: f.schema, table: 'test_table', name: 'x', type: 'text' }),
      /one-worker-per-schema assumption was violated/,
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

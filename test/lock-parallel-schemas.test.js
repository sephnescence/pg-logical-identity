import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { applyEvents, beginMigration, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url, { workers: 3 });
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('one worker thread per schema migrates many schemas in parallel', async () => {
  const schemas = f.workers;
  await Promise.all(schemas.map((s) => f.pool.query(`CREATE SCHEMA ${s}`)));

  const results = await Promise.all(schemas.map(async (schema) => {
    const mig = await beginMigration(f.pool, { schema, owner: `thread-${schema}` });
    try {
      return await applyEvents(f.pool, [
        { op: 'create_table', schema, table: 'items', columns: [{ name: 'id', type: 'bigint' }] },
        { op: 'add_column', schema, table: 'items', name: 'label', type: 'text' },
        { op: 'rename_column', schema, table: 'items', from: 'label', to: 'name' },
      ], { lockToken: mig.token });
    } finally {
      await mig.end();
    }
  }));

  expect(results.length).toBe(3);
  for (const schema of schemas) {
    expect((await verify(f.pool, schema)).ok).toBe(true);
    const { rows } = await f.pool.query(
      `SELECT state FROM identity_registry.control WHERE schema_name = $1`, [schema],
    );
    expect(rows[0].state).toBe('idle');
  }
});

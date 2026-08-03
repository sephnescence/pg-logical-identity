import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { exportSchema, verifyBundle, importSchema } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('verifyBundle catches a tampered bundle and import refuses it untouched', async () => {
  await f.seedExportScenario();
  const target = await f.createTargetDb();
  const bundle = await exportSchema(f.pool, { schema: f.schema });

  const bad = structuredClone(bundle);
  bad.tables[0].columns = bad.tables[0].columns.filter((c) => c.name !== 'test_column');

  const check = verifyBundle(bad);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.includes('test_table.test_column')));

  await assert.rejects(importSchema(target, { bundle: bad }), /failed verification/);
  const { rows } = await target.query(
    `SELECT 1 FROM pg_namespace WHERE nspname = $1`, [f.schema],
  );
  assert.equal(rows.length, 0, 'nothing was created in the target database');
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { exportSchema, importSchema, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('importSchema restores into a separate database with logical ids intact', async () => {
  const ids = await f.seedExportScenario();
  const target = await f.createTargetDb();
  const bundle = await exportSchema(f.pool, { schema: f.schema });

  const result = await importSchema(target, { bundle });
  assert.deepEqual(result, {
    schema: f.schema, tables: 1, columns: 2, skippedTombstones: 1,
  });

  const dst = await getByLogicalId(target, ids.columnIds.test_column, f.schema);
  const src = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  assert.equal(dst.column_name, 'test_column', 'same logical id resolves in the new database');
  assert.notEqual(dst.table_oid, src.table_oid, 're-anchored to fresh physical identity');

  const { rows } = await target.query(
    `SELECT id, test_column FROM ${f.schema}.test_table ORDER BY id`,
  );
  assert.deepEqual(rows.map((r) => r.test_column), ['alpha', 'beta'], 'data survived the move');
  assert.equal((await verify(target, f.schema)).ok, true);

  // dropped-column history stays behind — its anchors belong to the source db
  assert.equal(await getByLogicalId(target, ids.columnIds.doomed, f.schema), null);
});

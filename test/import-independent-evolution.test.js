import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { exportSchema, importSchema, renameColumn, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('the imported schema evolves independently under the same logical ids', async () => {
  const ids = await f.seedExportScenario();
  const target = await f.createTargetDb();
  const bundle = await exportSchema(f.pool, { schema: f.schema });
  await importSchema(target, { bundle });

  await renameColumn(target, {
    schema: f.schema, table: 'test_table', from: 'test_column', to: 'imported_name',
  });
  const dst = await getByLogicalId(target, ids.columnIds.test_column, f.schema);
  const src = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  assert.equal(dst.column_name, 'imported_name');
  assert.equal(src.column_name, 'test_column', 'source database untouched');
  assert.equal((await verify(target, f.schema)).ok, true);
});

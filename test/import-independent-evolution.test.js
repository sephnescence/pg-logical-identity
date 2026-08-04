import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { exportSchema, importSchema, renameColumn, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

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
  expect(dst.column_name).toBe('imported_name');
  expect(src.column_name).toBe('test_column'); // source database untouched
  expect((await verify(target, f.schema)).ok).toBe(true);
});

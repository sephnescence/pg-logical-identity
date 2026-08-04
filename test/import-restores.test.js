import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { exportSchema, importSchema, getByLogicalId, verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('importSchema restores into a separate database with logical ids intact', async () => {
  const ids = await f.seedExportScenario();
  const target = await f.createTargetDb();
  const bundle = await exportSchema(f.pool, { schema: f.schema });

  const result = await importSchema(target, { bundle });
  expect(result).toEqual({
    schema: f.schema, tables: 1, columns: 2, skippedTombstones: 1,
  });

  const dst = await getByLogicalId(target, ids.columnIds.test_column, f.schema);
  const src = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  expect(dst.column_name).toBe('test_column'); // same logical id resolves in the new database
  expect(dst.table_oid).not.toBe(src.table_oid); // re-anchored to fresh physical identity

  const { rows } = await target.query(
    `SELECT id, test_column FROM ${f.schema}.test_table ORDER BY id`,
  );
  expect(rows.map((r) => r.test_column)).toEqual(['alpha', 'beta']); // data survived the move
  expect((await verify(target, f.schema)).ok).toBe(true);

  // dropped-column history stays behind — its anchors belong to the source db
  expect(await getByLogicalId(target, ids.columnIds.doomed, f.schema)).toBe(null);
});

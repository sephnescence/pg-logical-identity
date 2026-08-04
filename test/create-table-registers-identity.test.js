import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture, UUID_RE } from './helpers/fixture.js';
import { getByLogicalId } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('createTable registers table and column with catalog identity', async () => {
  const ids = await f.seedTenant();
  expect(ids.tableId).toMatch(UUID_RE);
  expect(ids.columnIds.test_column).toMatch(UUID_RE);

  const tableRow = await getByLogicalId(f.pool, ids.tableId, f.schema);
  const { rows } = await f.pool.query(
    `SELECT to_regclass('${f.schema}.test_table')::oid::text AS oid`,
  );
  expect(tableRow.table_oid).toBe(rows[0].oid); // stored oid matches live catalog oid

  const colRow = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  expect(colRow.attnum).toBe(1); // first user column has attnum 1
  expect(colRow.table_oid).toBe(tableRow.table_oid);
});

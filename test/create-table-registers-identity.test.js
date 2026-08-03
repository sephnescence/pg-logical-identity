import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture, UUID_RE } from './helpers/fixture.js';
import { getByLogicalId } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('createTable registers table and column with catalog identity', async () => {
  const ids = await f.seedTenant();
  assert.match(ids.tableId, UUID_RE);
  assert.match(ids.columnIds.test_column, UUID_RE);

  const tableRow = await getByLogicalId(f.pool, ids.tableId, f.schema);
  const { rows } = await f.pool.query(
    `SELECT to_regclass('${f.schema}.test_table')::oid::text AS oid`,
  );
  assert.equal(tableRow.table_oid, rows[0].oid, 'stored oid matches live catalog oid');

  const colRow = await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema);
  assert.equal(colRow.attnum, 1, 'first user column has attnum 1');
  assert.equal(colRow.table_oid, tableRow.table_oid);
});

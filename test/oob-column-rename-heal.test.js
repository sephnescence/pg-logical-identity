import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { ops, verify, getByLogicalId } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('out-of-band column rename is detected by identity and healed', async () => {
  const ids = await f.seedTenant();
  await f.pool.query(`ALTER TABLE ${f.schema}.test_table RENAME COLUMN test_column TO sneaky`);

  const report = await verify(f.pool, f.schema);
  expect(report.ok).toBe(false);
  expect(report.drift).toEqual([{
    logicalId: ids.columnIds.test_column,
    kind: 'column',
    status: 'renamed',
    expected: 'test_column',
    actual: 'sneaky',
    tableName: 'test_table',
  }]);

  const { healed, remaining } = await f.run(ops.reconcile, { schema: f.schema });
  expect(healed).toBe(1);
  expect(remaining).toEqual([]);
  expect((await verify(f.pool, f.schema)).ok).toBe(true);
  // registry adopted the catalog name — same logical id throughout
  expect((await getByLogicalId(f.pool, ids.columnIds.test_column, f.schema)).column_name)
    .toBe('sneaky');
});

import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { exportSchema, importSchema } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('import refuses when the target schema already exists', async () => {
  await f.seedExportScenario();
  const target = await f.createTargetDb();
  const bundle = await exportSchema(f.pool, { schema: f.schema });

  await importSchema(target, { bundle });
  await expect(importSchema(target, { bundle })).rejects.toThrow(/already exists/);
});

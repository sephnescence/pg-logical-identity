import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { exportSchema, importSchema } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('import refuses when the target schema already exists', async () => {
  await f.seedExportScenario();
  const target = await f.createTargetDb();
  const bundle = await exportSchema(f.pool, { schema: f.schema });

  await importSchema(target, { bundle });
  await assert.rejects(importSchema(target, { bundle }), /already exists/);
});

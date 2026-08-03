import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Fixture } from './helpers/fixture.js';
import { verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
before(() => f.setup());
after(() => f.teardown());

test('verify reports clean after createTable', async () => {
  await f.seedTenant();
  const report = await verify(f.pool, f.schema);
  assert.deepEqual(report, { ok: true, drift: [] });
});

import { test, beforeAll, afterAll, expect } from '@jest/globals';
import { Fixture } from './helpers/fixture.js';
import { verify } from '../src/registry.js';

const f = new Fixture(import.meta.url);
beforeAll(() => f.setup());
afterAll(() => f.teardown());

test('verify reports clean after createTable', async () => {
  await f.seedTenant();
  const report = await verify(f.pool, f.schema);
  expect(report).toEqual({ ok: true, drift: [] });
});

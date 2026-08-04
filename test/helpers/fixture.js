import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { bootstrap, ops, withTx } from '../../src/registry.js';

export const BASE = 'postgres://postgres:postgres@127.0.0.1:54329';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const slugFrom = (metaUrl) => path.basename(fileURLToPath(metaUrl))
  .replace(/\.test\.js$/, '')
  .replaceAll(/[^a-zA-Z0-9]+/g, '_')
  .toLowerCase();

// Shared setup/teardown for the one-test-per-file suites: each file creates
// one instance from its own import.meta.url, runs setup() in beforeAll() and
// teardown() in afterAll(), then builds the scenario it needs.
//
// Every file gets schema/database names derived from its filename, so files
// never touch each other's objects and Jest's parallel workers never
// conflict. The
// registry itself is shared (as in production — many tenant schemas, one
// registry); setup() only clears this file's rows from it.
//
// Isolation is namespacing + reset rather than a wrapping transaction: the
// subject under test manages its own transactions (events BEGIN/COMMIT
// internally, and Postgres has no nested transactions), the lock tests need
// multiple real sessions (advisory locks are session-scoped), and
// CREATE DATABASE cannot run inside any transaction.
export class Fixture {
  constructor(metaUrl, { workers = 0 } = {}) {
    const slug = slugFrom(metaUrl);
    this.schema = `t_${slug}`;
    this.clone = `t_${slug}_clone`;
    this.targetDb = `db_${slug}`;
    this.workers = Array.from({ length: workers }, (_, i) => `${this.schema}_w${i + 1}`);
    this.pool = new pg.Pool({ connectionString: `${BASE}/postgres`, max: 5 });
    this.target = null;
    this.ids = null;
  }

  get allSchemas() {
    return [this.schema, this.clone, ...this.workers];
  }

  async setup() {
    await bootstrap(this.pool);
    await this.pool.query(`DROP SCHEMA IF EXISTS ${this.allSchemas.join(', ')} CASCADE`);
    await this.pool.query(
      `DELETE FROM identity_registry.objects WHERE schema_name = ANY($1)`, [this.allSchemas],
    );
    await this.pool.query(
      `DELETE FROM identity_registry.control WHERE schema_name = ANY($1)`, [this.allSchemas],
    );
  }

  async teardown() {
    if (this.target) {
      await this.target.end();
      await this.withCreatedbLock((c) =>
        c.query(`DROP DATABASE IF EXISTS ${this.targetDb} WITH (FORCE)`));
    }
    await this.pool.end();
  }

  // Run one core op inside its own transaction — the fast path for tests
  // that are about identity semantics, not the locking policy (the E2E
  // login-helper equivalent; the lock-* files test the gate itself).
  async run(op, args) {
    return withTx(this.pool, (c) => op(c, args));
  }

  // Schema with one tracked table; stores and returns { tableId, columnIds }.
  async seedTenant(columns = [{ name: 'test_column', type: 'text' }]) {
    await this.pool.query(`CREATE SCHEMA ${this.schema}`);
    this.ids = await this.run(ops.createTable, {
      schema: this.schema, table: 'test_table', columns,
    });
    return this.ids;
  }

  // Tenant with row data and a tombstoned column — the export/import scenario.
  async seedExportScenario() {
    await this.seedTenant([
      { name: 'id', type: 'bigint' },
      { name: 'test_column', type: 'text' },
      { name: 'doomed', type: 'integer' },
    ]);
    await this.run(ops.dropColumn, { schema: this.schema, table: 'test_table', name: 'doomed' });
    await this.pool.query(
      `INSERT INTO ${this.schema}.test_table (id, test_column) VALUES (1, 'alpha'), (2, 'beta')`,
    );
    return this.ids;
  }

  // Fresh database for cross-database import tests.
  async createTargetDb() {
    await this.withCreatedbLock(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${this.targetDb} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${this.targetDb}`);
    });
    this.target = new pg.Pool({ connectionString: `${BASE}/${this.targetDb}`, max: 5 });
    return this.target;
  }

  // CREATE DATABASE copies template1 and concurrent copies conflict, so all
  // parallel test processes serialize database creation on one advisory lock.
  async withCreatedbLock(fn) {
    const c = await this.pool.connect();
    try {
      await c.query(`SELECT pg_advisory_lock(421001, hashtext('createdb'))`);
      await fn(c);
      await c.query(`SELECT pg_advisory_unlock(421001, hashtext('createdb'))`);
    } finally {
      c.release();
    }
  }

  async infoSchemaColumns(schema, table) {
    const { rows } = await this.pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schema, table],
    );
    return rows.map((r) => r.column_name);
  }
}

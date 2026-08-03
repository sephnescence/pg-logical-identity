import { randomUUID } from "node:crypto";

// Quote an SQL identifier. DDL cannot take bind parameters for identifiers,
// so every schema/table/column name interpolated into DDL goes through this.
export const ident = (name) => '"' + String(name).replaceAll('"', '""') + '"';

// Every transaction runs under a lock_timeout so an operation waiting on a
// lock the package cannot see (e.g. an application transaction holding a
// tenant table) fails deterministically and retryably instead of hanging
// while it holds the schema's worker gate.
export const config = { lockTimeout: "5s" };

function lockTimeoutSql() {
  const v = String(config.lockTimeout);
  if (!/^\d+(ms|s|min)?$/.test(v))
    throw new Error(`Invalid config.lockTimeout: ${v}`);
  return `SET LOCAL lock_timeout = '${v}'`;
}

export async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(lockTimeoutSql());
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // never let a failed ROLLBACK (e.g. dead connection) mask the real error
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Registry schema
//
// One row per (logical object, schema). The same logical_id appears in
// multiple schemas when a schema has been cloned — that is what makes a
// column in tenant_a "the same column" as its counterpart in tenant_b.
//
// table_oid/attnum are the live catalog anchors: they survive renames inside
// this database, so verify() can detect out-of-band renames by looking the
// object up by identity rather than by name.
// ---------------------------------------------------------------------------

export async function bootstrap(pool) {
  return withTx(pool, async (c) => {
    // Serialize concurrent bootstraps: CREATE ... IF NOT EXISTS still throws
    // duplicate-key errors when two sessions race through the not-exists check.
    await c.query(`SELECT pg_advisory_xact_lock($1, hashtext('bootstrap'))`, [
      LOCK_NS,
    ]);
    await c.query(`
    CREATE SCHEMA IF NOT EXISTS identity_registry;
    CREATE TABLE IF NOT EXISTS identity_registry.objects (
      logical_id  uuid NOT NULL,
      kind        text NOT NULL CHECK (kind IN ('table', 'column')),
      schema_name text NOT NULL,
      table_name  text NOT NULL,
      column_name text,
      table_oid   oid  NOT NULL,
      attnum      smallint,
      dropped_at  timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (logical_id, schema_name),
      CHECK ((kind = 'table') = (column_name IS NULL)),
      CHECK ((kind = 'table') = (attnum IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS objects_live_name_uq
      ON identity_registry.objects (schema_name, table_name, coalesce(column_name, ''))
      WHERE dropped_at IS NULL;
    CREATE TABLE IF NOT EXISTS identity_registry.control (
      schema_name text PRIMARY KEY,
      state       text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'migrating')),
      lock_token  uuid,
      locked_by   text,
      locked_at   timestamptz
    );
    `);
  });
}

// --- operation lock --------------------------------------------------------
// Concurrency model: ONE worker per schema at any moment. A migration worker
// may spawn a thread per schema — the locks are keyed by schema, so threads
// never contend with each other, only with a second worker on the SAME
// schema, which is an assumption violation and fails loudly (never queues).
//
// Enforcement, per schema:
//   - beginMigration() holds a session advisory lock (liveness) and sets
//     state='migrating' with a token; only events presenting the token run.
//   - An untokened event/export/import claims the same advisory lock for its
//     transaction (pg_try_advisory_xact_lock, auto-released on commit or
//     rollback), so it can never interleave with a migration worker.
//   - The control row is taken FOR UPDATE NOWAIT inside every operation's
//     transaction as the final guard.
//
// Deadlock elimination rests on four rules:
//   1. Every operation that touches registry rows or tenant tables passes
//      through the schema's gate (assertOperable) FIRST — the gate serializes
//      workers per schema, so registry-row and table-lock order within a
//      schema can never form a cycle between two of our operations.
//   2. Gate acquisitions are non-blocking (try-locks, NOWAIT), so waiting on
//      a gate cannot participate in a cycle.
//   3. The only multi-schema operation (cloneSchema) acquires its two gates
//      in canonical (sorted) order, so the control-row creation INSERTs can
//      never interleave into a cycle either.
//   4. Locks the package cannot see (an application transaction holding a
//      tenant table against our ALTER) are bounded by lock_timeout — the
//      event fails cleanly and retryably instead of waiting forever while
//      holding the gate. Postgres's deadlock detector remains the backstop
//      for cycles involving foreign transactions.
// A crashed worker's session dies, its advisory lock releases, and the stale
// 'migrating' state is reclaimable via beginMigration()/forceUnlock().

const LOCK_NS = 421001; // classid for this package's advisory locks

async function ensureControlRow(db, schema) {
  await db.query(
    `INSERT INTO identity_registry.control (schema_name) VALUES ($1)
     ON CONFLICT (schema_name) DO NOTHING`,
    [schema],
  );
}

async function lockControlRow(client, schema) {
  await ensureControlRow(client, schema);
  try {
    const { rows } = await client.query(
      `SELECT state, lock_token FROM identity_registry.control
       WHERE schema_name = $1 FOR UPDATE NOWAIT`,
      [schema],
    );
    return rows[0];
  } catch (err) {
    if (err.code === "55P03") {
      throw new Error(
        `Schema ${schema} has a concurrent operation in flight — ` +
          `the one-worker-per-schema assumption was violated`,
      );
    }
    throw err;
  }
}

async function assertOperable(client, schema, lockToken) {
  const { state, lock_token } = await lockControlRow(client, schema);
  if (state === "migrating") {
    if (lockToken && lockToken === lock_token) return;
    throw new Error(
      `Schema ${schema} is migrating — only the worker holding the batch lock token may operate on it`,
    );
  }
  // Idle: claim the schema's worker lock for this transaction so a single
  // ad-hoc operation serializes against beginMigration() in other sessions.
  const { rows } = await client.query(
    `SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS ok`,
    [LOCK_NS, schema],
  );
  if (!rows[0].ok) {
    throw new Error(
      `Schema ${schema} is owned by another worker session — ` +
        `events are one worker per schema`,
    );
  }
}

export async function beginMigration(pool, { schema, owner = "unknown" }) {
  const client = await pool.connect();
  let acquired = false;
  try {
    const { rows } = await client.query(
      `SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok`,
      [LOCK_NS, schema],
    );
    if (!rows[0].ok)
      throw new Error(
        `Schema ${schema} migration lock is held by a live session`,
      );
    acquired = true;

    const token = randomUUID();
    await client.query("BEGIN");
    await client.query(lockTimeoutSql());
    const { state } = await lockControlRow(client, schema);
    // We hold the advisory lock, so any previous 'migrating' holder is dead:
    // its events were atomic, the schema is consistent, and takeover is safe.
    const stale = state !== "idle" ? state : null;
    await client.query(
      `UPDATE identity_registry.control
       SET state = 'migrating', lock_token = $2, locked_by = $3, locked_at = now()
       WHERE schema_name = $1`,
      [schema, token, owner],
    );
    await client.query("COMMIT");

    return {
      schema,
      token,
      stale,
      end: async () => {
        await client.query(
          `UPDATE identity_registry.control
           SET state = 'idle', lock_token = NULL, locked_by = NULL, locked_at = NULL
           WHERE schema_name = $1`,
          [schema],
        );
        await client.query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [
          LOCK_NS,
          schema,
        ]);
        client.release();
      },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (acquired) {
      await client
        .query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [LOCK_NS, schema])
        .catch(() => {});
    }
    client.release();
    throw err;
  }
}

// Reset a stale 'migrating' state. Returns false (and does nothing) if the
// holder is still alive — the advisory lock is the liveness check.
export async function forceUnlock(pool, { schema }) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok`,
      [LOCK_NS, schema],
    );
    if (!rows[0].ok) return false;
    await client.query(
      `UPDATE identity_registry.control
       SET state = 'idle', lock_token = NULL, locked_by = NULL, locked_at = NULL
       WHERE schema_name = $1`,
      [schema],
    );
    await client.query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [
      LOCK_NS,
      schema,
    ]);
    return true;
  } finally {
    client.release();
  }
}

// --- catalog lookups -------------------------------------------------------

async function tableOid(db, schema, table) {
  const { rows } = await db.query(
    `SELECT c.oid::text AS oid
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
    [schema, table],
  );
  return rows[0]?.oid ?? null;
}

async function columnAttnum(db, oid, column) {
  const { rows } = await db.query(
    `SELECT attnum
     FROM pg_attribute
     WHERE attrelid = $1::oid AND attname = $2 AND attnum > 0 AND NOT attisdropped`,
    [oid, column],
  );
  return rows[0]?.attnum ?? null;
}

async function liveTableRow(client, schema, table) {
  const { rows } = await client.query(
    `SELECT logical_id, table_oid::text AS table_oid
     FROM identity_registry.objects
     WHERE kind = 'table' AND schema_name = $1 AND table_name = $2 AND dropped_at IS NULL
     FOR UPDATE`,
    [schema, table],
  );
  if (rows.length !== 1) throw new Error(`No tracked table ${schema}.${table}`);
  return rows[0];
}

async function liveColumnRow(client, schema, table, column) {
  const { rows } = await client.query(
    `SELECT logical_id, table_oid::text AS table_oid, attnum
     FROM identity_registry.objects
     WHERE kind = 'column' AND schema_name = $1 AND table_name = $2
       AND column_name = $3 AND dropped_at IS NULL
     FOR UPDATE`,
    [schema, table, column],
  );
  if (rows.length !== 1)
    throw new Error(`No tracked column ${schema}.${table}.${column}`);
  return rows[0];
}

// --- core operations -------------------------------------------------------
// The mechanism layer: each op runs against a client that is already inside a
// transaction, and assumes the caller holds the schema's gate. The public
// events below add that policy (gate + transaction). Tests of identity
// semantics target this layer directly so they assert one thing at a time;
// callers with their own transaction can compose ops the same way.

export const ops = {
  async createTable(c, { schema, table, columns }) {
    const cols = columns
      .map((col) => `${ident(col.name)} ${col.type}`)
      .join(", ");
    await c.query(`CREATE TABLE ${ident(schema)}.${ident(table)} (${cols})`);
    const oid = await tableOid(c, schema, table);
    const tableId = randomUUID();
    await c.query(
      `INSERT INTO identity_registry.objects (logical_id, kind, schema_name, table_name, table_oid)
       VALUES ($1, 'table', $2, $3, $4::oid)`,
      [tableId, schema, table, oid],
    );
    const columnIds = {};
    for (const col of columns) {
      const attnum = await columnAttnum(c, oid, col.name);
      const id = randomUUID();
      columnIds[col.name] = id;
      await c.query(
        `INSERT INTO identity_registry.objects
           (logical_id, kind, schema_name, table_name, column_name, table_oid, attnum)
         VALUES ($1, 'column', $2, $3, $4, $5::oid, $6)`,
        [id, schema, table, col.name, oid, attnum],
      );
    }
    return { tableId, columnIds };
  },

  async addColumn(c, { schema, table, name, type }) {
    const reg = await liveTableRow(c, schema, table);
    await c.query(
      `ALTER TABLE ${ident(schema)}.${ident(table)} ADD COLUMN ${ident(name)} ${type}`,
    );
    const attnum = await columnAttnum(c, reg.table_oid, name);
    const logicalId = randomUUID();
    await c.query(
      `INSERT INTO identity_registry.objects
         (logical_id, kind, schema_name, table_name, column_name, table_oid, attnum)
       VALUES ($1, 'column', $2, $3, $4, $5::oid, $6)`,
      [logicalId, schema, table, name, reg.table_oid, attnum],
    );
    return { logicalId, attnum };
  },

  async renameColumn(c, { schema, table, from, to }) {
    const reg = await liveColumnRow(c, schema, table, from);
    const cat = await c.query(
      `SELECT attname FROM pg_attribute
       WHERE attrelid = $1::oid AND attnum = $2 AND NOT attisdropped`,
      [reg.table_oid, reg.attnum],
    );
    if (cat.rows[0]?.attname !== from) {
      throw new Error(
        `Catalog drift on ${schema}.${table}.${from}: catalog has ` +
          `${cat.rows[0]?.attname ?? "(missing)"} at attnum ${reg.attnum} — run verify/reconcile first`,
      );
    }
    await c.query(
      `ALTER TABLE ${ident(schema)}.${ident(table)} RENAME COLUMN ${ident(from)} TO ${ident(to)}`,
    );
    await c.query(
      `UPDATE identity_registry.objects SET column_name = $1, updated_at = now()
       WHERE logical_id = $2 AND schema_name = $3`,
      [to, reg.logical_id, schema],
    );
    return { logicalId: reg.logical_id };
  },

  async renameTable(c, { schema, from, to }) {
    const reg = await liveTableRow(c, schema, from);
    const liveOid = await tableOid(c, schema, from);
    if (liveOid !== reg.table_oid) {
      throw new Error(
        `Catalog drift on ${schema}.${from} — run verify/reconcile first`,
      );
    }
    await c.query(
      `ALTER TABLE ${ident(schema)}.${ident(from)} RENAME TO ${ident(to)}`,
    );
    await c.query(
      `UPDATE identity_registry.objects SET table_name = $1, updated_at = now()
       WHERE schema_name = $2 AND table_name = $3 AND dropped_at IS NULL`,
      [to, schema, from],
    );
    return { logicalId: reg.logical_id };
  },

  async dropColumn(c, { schema, table, name }) {
    const reg = await liveColumnRow(c, schema, table, name);
    await c.query(
      `ALTER TABLE ${ident(schema)}.${ident(table)} DROP COLUMN ${ident(name)}`,
    );
    await c.query(
      `UPDATE identity_registry.objects SET dropped_at = now(), updated_at = now()
       WHERE logical_id = $1 AND schema_name = $2`,
      [reg.logical_id, schema],
    );
    return { logicalId: reg.logical_id };
  },

  async dropTable(c, { schema, table }) {
    const reg = await liveTableRow(c, schema, table);
    await c.query(`DROP TABLE ${ident(schema)}.${ident(table)}`);
    await c.query(
      `UPDATE identity_registry.objects SET dropped_at = now(), updated_at = now()
       WHERE schema_name = $1 AND table_name = $2 AND dropped_at IS NULL`,
      [schema, table],
    );
    return { logicalId: reg.logical_id };
  },

  async reconcile(c, { schema }) {
    const report = await verify(c, schema);
    let healed = 0;
    for (const d of report.drift) {
      if (d.status !== "renamed") continue;
      if (d.kind === "table") {
        await c.query(
          `UPDATE identity_registry.objects SET table_name = $1, updated_at = now()
           WHERE schema_name = $2 AND table_name = $3 AND dropped_at IS NULL`,
          [d.actual, schema, d.expected],
        );
      } else {
        await c.query(
          `UPDATE identity_registry.objects SET column_name = $1, updated_at = now()
           WHERE logical_id = $2 AND schema_name = $3`,
          [d.actual, d.logicalId, schema],
        );
      }
      healed++;
    }
    return {
      healed,
      remaining: report.drift.filter((d) => d.status !== "renamed"),
    };
  },

  async cloneSchema(c, { from, to }) {
    await c.query(`CREATE SCHEMA ${ident(to)}`);
    const { rows: tables } = await c.query(
      `SELECT logical_id, table_name FROM identity_registry.objects
       WHERE schema_name = $1 AND kind = 'table' AND dropped_at IS NULL
       ORDER BY table_name`,
      [from],
    );
    for (const t of tables) {
      await c.query(
        `CREATE TABLE ${ident(to)}.${ident(t.table_name)}
         (LIKE ${ident(from)}.${ident(t.table_name)} INCLUDING ALL)`,
      );
      const oid = await tableOid(c, to, t.table_name);
      await c.query(
        `INSERT INTO identity_registry.objects (logical_id, kind, schema_name, table_name, table_oid)
         VALUES ($1, 'table', $2, $3, $4::oid)`,
        [t.logical_id, to, t.table_name, oid],
      );
      const { rows: cols } = await c.query(
        `SELECT logical_id, column_name FROM identity_registry.objects
         WHERE schema_name = $1 AND table_name = $2 AND kind = 'column' AND dropped_at IS NULL
         ORDER BY attnum`,
        [from, t.table_name],
      );
      for (const col of cols) {
        const attnum = await columnAttnum(c, oid, col.column_name);
        await c.query(
          `INSERT INTO identity_registry.objects
             (logical_id, kind, schema_name, table_name, column_name, table_oid, attnum)
           VALUES ($1, 'column', $2, $3, $4, $5::oid, $6)`,
          [col.logical_id, to, t.table_name, col.column_name, oid, attnum],
        );
      }
    }
    return { tables: tables.length };
  },
};

// --- migration events ------------------------------------------------------
// The policy layer: one transaction per event (DDL and registry commit or
// roll back together), entered through the schema’s gate. A crashed/failed
// event leaves no partial state and can simply be retried — the property
// triggers cannot give you.

export async function createTable(pool, { schema, table, columns, lockToken }) {
  return withTx(pool, async (c) => {
    await assertOperable(c, schema, lockToken);
    return ops.createTable(c, { schema, table, columns });
  });
}

export async function addColumn(
  pool,
  { schema, table, name, type, lockToken },
) {
  return withTx(pool, async (c) => {
    await assertOperable(c, schema, lockToken);
    return ops.addColumn(c, { schema, table, name, type });
  });
}

export async function renameColumn(
  pool,
  { schema, table, from, to, lockToken },
) {
  return withTx(pool, async (c) => {
    await assertOperable(c, schema, lockToken);
    return ops.renameColumn(c, { schema, table, from, to });
  });
}

export async function renameTable(pool, { schema, from, to, lockToken }) {
  return withTx(pool, async (c) => {
    await assertOperable(c, schema, lockToken);
    return ops.renameTable(c, { schema, from, to });
  });
}

export async function dropColumn(pool, { schema, table, name, lockToken }) {
  return withTx(pool, async (c) => {
    await assertOperable(c, schema, lockToken);
    return ops.dropColumn(c, { schema, table, name });
  });
}

export async function dropTable(pool, { schema, table, lockToken }) {
  return withTx(pool, async (c) => {
    await assertOperable(c, schema, lockToken);
    return ops.dropTable(c, { schema, table });
  });
}

// --- event worker ----------------------------------------------------------
// Apply a batch of requested changes sequentially. Each event is atomic, so a
// failure mid-batch stops cleanly: events before it are committed, the failed
// one left no trace, and the batch can be resumed from the failed index.

const handlers = {
  create_table: createTable,
  add_column: addColumn,
  rename_column: renameColumn,
  rename_table: renameTable,
  drop_column: dropColumn,
  drop_table: dropTable,
};

export async function applyEvents(pool, events, opts = {}) {
  const results = [];
  for (const [i, event] of events.entries()) {
    const handler = handlers[event.op];
    if (!handler) throw new Error(`Unknown event op: ${event.op}`);
    try {
      results.push(
        await handler(pool, {
          ...event,
          lockToken: opts.lockToken ?? event.lockToken,
        }),
      );
    } catch (err) {
      err.message = `Event ${i} (${event.op}) failed: ${err.message}`;
      err.failedIndex = i;
      throw err;
    }
  }
  return results;
}

// --- verification ----------------------------------------------------------
// Compare the registry against the system catalogs *by identity* (oid/attnum,
// which survive renames), not by name. Detects:
//   renamed   — object exists under its tracked identity but with another name
//   missing   — tracked identity no longer exists in the catalog
//   untracked — catalog object in this schema with no registry row

export async function verify(db, schema) {
  const drift = [];
  const { rows: regRows } = await db.query(
    `SELECT logical_id, kind, schema_name, table_name, column_name,
            table_oid::text AS table_oid, attnum
     FROM identity_registry.objects
     WHERE schema_name = $1 AND dropped_at IS NULL
     ORDER BY kind DESC, table_name, attnum`,
    [schema],
  );
  const tables = regRows.filter((r) => r.kind === "table");
  const columns = regRows.filter((r) => r.kind === "column");

  for (const t of tables) {
    const { rows } = await db.query(
      `SELECT c.relname, n.nspname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.oid = $1::oid`,
      [t.table_oid],
    );
    if (!rows.length) {
      drift.push({
        logicalId: t.logical_id,
        kind: "table",
        status: "missing",
        expected: t.table_name,
      });
    } else if (
      rows[0].relname !== t.table_name ||
      rows[0].nspname !== t.schema_name
    ) {
      drift.push({
        logicalId: t.logical_id,
        kind: "table",
        status: "renamed",
        expected: t.table_name,
        actual: rows[0].relname,
      });
    }
  }

  for (const col of columns) {
    const { rows } = await db.query(
      `SELECT attname, attisdropped FROM pg_attribute
       WHERE attrelid = $1::oid AND attnum = $2`,
      [col.table_oid, col.attnum],
    );
    if (!rows.length || rows[0].attisdropped) {
      drift.push({
        logicalId: col.logical_id,
        kind: "column",
        status: "missing",
        expected: col.column_name,
        tableName: col.table_name,
      });
    } else if (rows[0].attname !== col.column_name) {
      drift.push({
        logicalId: col.logical_id,
        kind: "column",
        status: "renamed",
        expected: col.column_name,
        actual: rows[0].attname,
        tableName: col.table_name,
      });
    }
  }

  const trackedOids = new Set(tables.map((t) => t.table_oid));
  const { rows: liveTables } = await db.query(
    `SELECT c.oid::text AS oid, c.relname
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r'`,
    [schema],
  );
  for (const lt of liveTables) {
    if (!trackedOids.has(lt.oid)) {
      drift.push({ kind: "table", status: "untracked", actual: lt.relname });
    }
  }

  const trackedCols = new Set(columns.map((c) => `${c.table_oid}:${c.attnum}`));
  for (const t of tables) {
    const { rows: liveCols } = await db.query(
      `SELECT attnum, attname FROM pg_attribute
       WHERE attrelid = $1::oid AND attnum > 0 AND NOT attisdropped`,
      [t.table_oid],
    );
    for (const lc of liveCols) {
      if (!trackedCols.has(`${t.table_oid}:${lc.attnum}`)) {
        drift.push({
          kind: "column",
          status: "untracked",
          actual: lc.attname,
          tableName: t.table_name,
        });
      }
    }
  }

  return { ok: drift.length === 0, drift };
}

// Heal 'renamed' drift by adopting the catalog's current names (identity is
// unambiguous — the oid/attnum still match). 'missing' and 'untracked' need a
// human decision, so they are returned untouched.
export async function reconcile(pool, schema, { lockToken } = {}) {
  return withTx(pool, async (c) => {
    await assertOperable(c, schema, lockToken);
    return ops.reconcile(c, { schema });
  });
}

// --- schema cloning --------------------------------------------------------
// Clone every live tracked table into a new schema and register the clones
// under the SAME logical_ids. New oids/attnums are resolved fresh in the new
// schema — physical identity is per-database, logical identity crosses clones.

export async function cloneSchema(pool, { from, to, lockToken }) {
  return withTx(pool, async (c) => {
    // Gate BOTH schemas before touching any table, in canonical order so two
    // clones over the same pair can never interleave their control-row
    // creation into a cycle.
    for (const s of [from, to].sort()) {
      await assertOperable(c, s, lockToken);
    }
    return ops.cloneSchema(c, { from, to });
  });
}

// Resolve a logical object to its current physical location in one schema.
export async function getByLogicalId(db, logicalId, schema) {
  const { rows } = await db.query(
    `SELECT kind, schema_name, table_name, column_name,
            table_oid::text AS table_oid, attnum, dropped_at
     FROM identity_registry.objects
     WHERE logical_id = $1 AND schema_name = $2`,
    [logicalId, schema],
  );
  return rows[0] ?? null;
}

// --- export / import -------------------------------------------------------
// Move a tenant schema to another database together with its registry rows,
// so logical identity survives the move. Export is one REPEATABLE READ
// transaction (consistent snapshot, read-only); import is one transaction in
// the target (crash = full rollback, retryable). Both take the control row
// lock, and export additionally requires state 'idle' — you cannot export a
// schema mid-migration, and you cannot start a migration mid-export.
//
// The bundle captures structure as column name/type/not-null. Defaults,
// constraints, and indexes are out of scope here — for those, run pg_dump
// under the same lock protocol and use this bundle for the identity rows.

export async function exportSchema(pool, { schema }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query(lockTimeoutSql());
    await assertOperable(client, schema, null);
    const report = await verify(client, schema);
    if (!report.ok) {
      throw new Error(
        `Refusing to export ${schema}: registry drift detected ` +
          `(${report.drift.length} item(s)) — run verify/reconcile first`,
      );
    }
    const { rows: registry } = await client.query(
      `SELECT logical_id, kind, schema_name, table_name, column_name,
              table_oid::text AS table_oid, attnum, dropped_at
       FROM identity_registry.objects
       WHERE schema_name = $1
       ORDER BY kind DESC, table_name, attnum NULLS FIRST, column_name`,
      [schema],
    );
    const tables = [];
    for (const t of registry.filter(
      (r) => r.kind === "table" && !r.dropped_at,
    )) {
      const { rows: cols } = await client.query(
        `SELECT attname AS name, format_type(atttypid, atttypmod) AS type, attnotnull AS not_null
         FROM pg_attribute
         WHERE attrelid = $1::oid AND attnum > 0 AND NOT attisdropped
         ORDER BY attnum`,
        [t.table_oid],
      );
      const { rows: data } = await client.query(
        `SELECT * FROM ${ident(schema)}.${ident(t.table_name)} ORDER BY 1`,
      );
      tables.push({
        name: t.table_name,
        columns: cols.map((c) => ({
          name: c.name,
          type: c.type,
          notNull: c.not_null,
        })),
        rows: data,
      });
    }
    await client.query("COMMIT");
    return {
      version: 1,
      schema,
      registry: registry.map((r) => ({
        ...r,
        dropped_at: r.dropped_at ? r.dropped_at.toISOString() : null,
      })),
      tables,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Pure structural inspection of a bundle — run before any restore touches the
// database. Every live registry row must have its physical counterpart in the
// bundle and vice versa, so a truncated or hand-edited dump is refused.
export function verifyBundle(bundle) {
  const problems = [];
  if (bundle?.version !== 1)
    problems.push(`unsupported bundle version: ${bundle?.version}`);
  const registry = bundle?.registry ?? [];
  const tables = bundle?.tables ?? [];
  const live = registry.filter((r) => !r.dropped_at);
  const tableByName = new Map(tables.map((t) => [t.name, t]));

  const seen = new Set();
  for (const r of registry) {
    if (seen.has(r.logical_id))
      problems.push(`duplicate logical_id ${r.logical_id}`);
    seen.add(r.logical_id);
  }
  for (const r of live) {
    const t = tableByName.get(r.table_name);
    if (!t) {
      problems.push(
        `registry references table "${r.table_name}" missing from bundle`,
      );
      continue;
    }
    if (
      r.kind === "column" &&
      !(t.columns ?? []).some((c) => c.name === r.column_name)
    ) {
      problems.push(
        `registry references column "${r.table_name}.${r.column_name}" missing from bundle`,
      );
    }
  }
  const liveTables = new Set(
    live.filter((r) => r.kind === "table").map((r) => r.table_name),
  );
  const liveCols = new Set(
    live
      .filter((r) => r.kind === "column")
      .map((r) => `${r.table_name}.${r.column_name}`),
  );
  for (const t of tables) {
    if (!liveTables.has(t.name))
      problems.push(`table "${t.name}" has no registry row`);
    for (const c of t.columns ?? []) {
      if (!liveCols.has(`${t.name}.${c.name}`)) {
        problems.push(`column "${t.name}.${c.name}" has no registry row`);
      }
    }
    for (const row of t.rows ?? []) {
      for (const key of Object.keys(row)) {
        if (!(t.columns ?? []).some((c) => c.name === key)) {
          problems.push(
            `row data key "${key}" in "${t.name}" matches no column`,
          );
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

export async function importSchema(pool, { bundle, as }) {
  const target = as ?? bundle?.schema;
  const check = verifyBundle(bundle);
  if (!check.ok) {
    throw new Error(
      `Refusing to import: bundle failed verification:\n- ${check.problems.join("\n- ")}`,
    );
  }
  await bootstrap(pool);
  return withTx(pool, async (c) => {
    await assertOperable(c, target, null);
    const { rows: existing } = await c.query(
      `SELECT 1 FROM pg_namespace WHERE nspname = $1`,
      [target],
    );
    if (existing.length)
      throw new Error(`Refusing to import: schema ${target} already exists`);

    await c.query(`CREATE SCHEMA ${ident(target)}`);
    let columns = 0;
    for (const t of bundle.tables) {
      const colDefs = t.columns
        .map(
          (col) =>
            `${ident(col.name)} ${col.type}${col.notNull ? " NOT NULL" : ""}`,
        )
        .join(", ");
      await c.query(
        `CREATE TABLE ${ident(target)}.${ident(t.name)} (${colDefs})`,
      );
      const oid = await tableOid(c, target, t.name);

      const tReg = bundle.registry.find(
        (r) => r.kind === "table" && r.table_name === t.name && !r.dropped_at,
      );
      await c.query(
        `INSERT INTO identity_registry.objects (logical_id, kind, schema_name, table_name, table_oid)
         VALUES ($1, 'table', $2, $3, $4::oid)`,
        [tReg.logical_id, target, t.name, oid],
      );
      for (const col of t.columns) {
        const reg = bundle.registry.find(
          (r) =>
            r.kind === "column" &&
            r.table_name === t.name &&
            r.column_name === col.name &&
            !r.dropped_at,
        );
        const attnum = await columnAttnum(c, oid, col.name);
        await c.query(
          `INSERT INTO identity_registry.objects
             (logical_id, kind, schema_name, table_name, column_name, table_oid, attnum)
           VALUES ($1, 'column', $2, $3, $4, $5::oid, $6)`,
          [reg.logical_id, target, t.name, col.name, oid, attnum],
        );
        columns++;
      }
      for (const row of t.rows) {
        const keys = Object.keys(row);
        if (!keys.length) continue;
        await c.query(
          `INSERT INTO ${ident(target)}.${ident(t.name)}
             (${keys.map(ident).join(", ")})
           VALUES (${keys.map((_, i) => "$" + (i + 1)).join(", ")})`,
          keys.map((k) => row[k]),
        );
      }
    }
    // Tombstoned registry rows are anchored to source-database oids/attnums
    // that mean nothing here — history does not re-anchor (same reason
    // pg_dump compacts attnums).
    const skippedTombstones = bundle.registry.filter(
      (r) => r.dropped_at,
    ).length;

    const report = await verify(c, target);
    if (!report.ok) throw new Error(`Import verification failed for ${target}`);
    return {
      schema: target,
      tables: bundle.tables.length,
      columns,
      skippedTombstones,
    };
  });
}

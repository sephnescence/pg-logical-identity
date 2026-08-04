# pg-identity

Deterministic logical identity for Postgres tables and columns — stable across
renames within a database, and shared across cloned schemas.

## The problem

Postgres `information_schema` identifies objects only by name, so a rename
looks like a drop + create. The system catalogs do better — `pg_class.oid`
identifies a table and `(attrelid, attnum)` identifies a column through any
rename — but those anchors are physical: they change on dump/restore and are
different in every schema clone, and `pg_dump` even compacts `attnum`s.

This package layers a **logical identity** (a UUID per table/column, stored in
`identity_registry.objects`) on top of the physical catalog anchors:

- **logical_id** — your durable identity; the same UUID identifies "that
  column" in every clone of a schema.
- **table_oid / attnum** — the live catalog anchors, used by `verify()` to
  detect out-of-band renames *by identity instead of by name*, and by
  `reconcile()` to heal them.

## Why not event triggers

Every schema change here is an **event**: one transaction containing both the
DDL and the registry update. If anything fails, both roll back — there is no
partial state, and the event can simply be retried. `applyEvents()` runs a
batch sequentially and reports exactly which event failed, so a worker can
inspect/assert on requested changes before applying and resume after a crash.

## Usage

```bash
pnpm install
pnpm db:up        # postgres:16 on localhost:54329
pnpm test         # or: pnpm test:full (db:up + test)
pnpm db:down
```

```js
import { bootstrap, createTable, renameColumn, verify, reconcile,
         cloneSchema, getByLogicalId, applyEvents } from './src/registry.js';

await bootstrap(pool);
const ids = await createTable(pool, {
  schema: 'test_tenant', table: 'test_table',
  columns: [{ name: 'test_column', type: 'text' }],
});

// rename freely — the logical id never changes
await renameColumn(pool, { schema: 'test_tenant', table: 'test_table',
                           from: 'test_column', to: 'better_name' });

// clone a tenant — same logical ids, fresh oids/attnums
await cloneSchema(pool, { from: 'test_tenant', to: 'other_tenant' });
await getByLogicalId(pool, ids.columnIds.test_column, 'other_tenant');

// detect and heal out-of-band renames (matched by oid/attnum, not name)
const report = await verify(pool, 'test_tenant');   // ok / renamed / missing / untracked
await reconcile(pool, 'test_tenant');               // adopts catalog names for 'renamed'
```

## Events

`applyEvents(pool, events)` dispatches on `op`:
`create_table`, `add_column`, `rename_column`, `rename_table`,
`drop_column`, `drop_table`. Each event is atomic; a failed batch throws with
`failedIndex` so the worker can resume from that event after fixing the cause.

## Layering: ops (mechanism) vs events (policy)

Each change exists at two layers:

- **`ops.*`** — core operations (`ops.renameColumn(client, args)`, …) that run
  against a client already inside a transaction and assume the caller holds
  the schema's gate. This is the mechanism: what the change does to the
  catalog and the registry. Callers with their own transaction can compose
  ops directly (the ambient-transaction case).
- **Public events** (`renameColumn(pool, args)`, …) — the policy wrapper:
  one transaction per event, entered through the schema's gate.

Tests follow the same split so each asserts one thing: the semantic files
(rename, attnum, tombstones, clone identity) drive `ops` through a fixture
helper and never touch the lock machinery; the `lock-*` files test the gate
itself; and the integration-shaped files (`failed-event-atomic`,
`apply-events-batch`, export/import) exercise the full public path. A gate
bug fails the lock tests, not the whole suite — the E2E equivalent of a login
helper, where only the login tests go through the login UI.

## Operation lock

Concurrency model: **one worker per schema at any moment**. A migration
worker may spawn a thread per schema — the locks are keyed by schema, so
threads never contend with each other, only with a second worker on the
*same* schema, which is treated as an assumption violation and fails loudly
(nothing ever queues or blocks). Enforcement, per schema, via
`identity_registry.control` (one row per schema):

1. **Migration lock** — a multi-transaction batch calls `beginMigration()`,
   which holds a session advisory lock (liveness) and sets
   `state = 'migrating'` with a token. Only events presenting the token run;
   ad-hoc events, export, and import are refused while migrating.
2. **Ad-hoc worker lock** — an untokened event/export/import claims the same
   advisory lock for the duration of its transaction
   (`pg_try_advisory_xact_lock`, auto-released on commit or rollback), so it
   can never interleave with a migration worker in another session.
3. **Control row** — taken `FOR UPDATE NOWAIT` inside every operation's
   transaction as the final guard.

If the worker crashes, its session dies and the advisory lock releases — the
stale state is then reclaimable by the next `beginMigration()` (reported via
`stale`) or an operator's `forceUnlock()`, which refuses if the holder is
still alive.

### Deadlock elimination

Four rules make deadlocks between this package's operations impossible and
bound every remaining wait:

1. **Single gate first.** Every operation that touches registry rows or
   tenant tables — events, `reconcile`, `cloneSchema`, export, import —
   passes through the schema's gate before taking any other lock. The gate
   serializes workers per schema, so registry-row and table-lock order
   within a schema can never form a cycle between two operations.
2. **Non-blocking gates.** All gate acquisitions are try-locks / `NOWAIT`,
   so waiting on a gate cannot participate in a cycle.
3. **Canonical multi-schema order.** `cloneSchema`, the only two-schema
   operation, acquires its gates in sorted order, so concurrent clones over
   the same pair cannot interleave control-row creation into a cycle.
4. **Bounded foreign waits.** Locks the package cannot see (an application
   transaction holding a tenant table against an `ALTER`) are bounded by
   `lock_timeout` (`config.lockTimeout`, default `5s`) — the event fails
   cleanly and retryably instead of waiting forever while holding the gate.
   Postgres's deadlock detector remains the backstop for cycles involving
   foreign transactions.

```js
const mig = await beginMigration(pool, { schema: 'test_tenant', owner: 'worker-1' });
await applyEvents(pool, events, { lockToken: mig.token });
await mig.end();
```

## Export / import across databases

`exportSchema()` runs in one `REPEATABLE READ` transaction: it refuses if the
schema is migrating or drifted, then bundles the registry rows together with
table structure and data. `verifyBundle()` inspects a bundle structurally
(every live registry row must match a physical object in the bundle and vice
versa), and `importSchema()` refuses inconsistent bundles before touching the
target, restores in one atomic transaction, and re-anchors logical ids to
fresh oids/attnums. Tombstoned history stays behind — its physical anchors
belong to the source database.

```js
const bundle = await exportSchema(sourcePool, { schema: 'test_tenant' });
await importSchema(targetPool, { bundle });          // separate database
```

The bundle captures column name/type/not-null and row data. Defaults,
constraints, and indexes are out of scope — for full-fidelity moves, run
pg_dump under the same lock protocol and use the bundle for identity rows.

## Test layout

One test case per file under `test/`, named after the invariant it pins down,
and the files run **in parallel** across Jest's workers. Each file
instantiates a `Fixture` (from `test/helpers/fixture.js`) with its own
`import.meta.url`, runs `setup()` / `teardown()` in its
`beforeAll`/`afterAll` hooks, and builds its own scenario from the seed
helpers (`seedTenant`, `seedExportScenario`, `createTargetDb`) — no test
depends on state left behind by another.

Parallelism works because every file gets schema/database names derived from
its filename, so files never touch each other's objects; the registry itself
is shared, exactly as in production (many tenant schemas, one registry), and
`setup()` clears only that file's rows from it.

Isolation is namespacing + reset rather than a PHPUnit-style wrapping
transaction, for structural reasons: the subject under test manages its own
transactions (events `BEGIN`/`COMMIT` internally, and Postgres has no nested
transactions), the lock tests need multiple real sessions (advisory locks
are session-scoped and invisible inside one wrapped transaction), and
`CREATE DATABASE` cannot run inside any transaction.

## Invariants the test suite pins down

- `oid` survives table renames; `attnum` survives column renames.
- Dropped columns leave a catalog tombstone; `attnum`s are never reused.
- A failed event (e.g. rename collision) leaves neither DDL nor registry
  changes behind, and the corrected event succeeds on retry.
- Out-of-band renames are detected as `renamed` (identity match, name
  mismatch) and healed; out-of-band drops/creates are reported as
  `missing`/`untracked` for a human to resolve.
- Clones share `logical_id`s but not `oid`s/`attnum`s; renames in one clone
  do not affect another.
- Registry rows for dropped objects are tombstoned (`dropped_at`), never
  deleted, so history and clone lineage remain queryable.
- Export is refused mid-migration and on drift; import is refused for
  tampered bundles and existing target schemas, and leaves nothing behind
  when refused.
- A crashed migration lock is reclaimable (advisory-lock liveness check);
  a live one is not.

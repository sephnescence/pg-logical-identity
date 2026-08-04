# Creating and applying migrations

Two pnpm commands wrap `src/migrate.js`:

| Command | What it does |
| --- | --- |
| `pnpm migration:new <name> [--dir <folder>]` | Scaffold `NNNN_<name>.sql` + journal entry in drizzle-kit's folder format (default `./drizzle`) |
| `pnpm migration:apply <folder> <schema>` | Apply a drizzle-format folder to one tenant schema and print the resulting registry |

The apply command connects via `DATABASE_URL`, defaulting to the
docker-compose instance (`pnpm db:up`).

The scaffolder writes the *on-disk layout* the loader consumes — it doesn't
diff a schema for you. In a real app, `drizzle-kit generate` produces the
SQL; here (the runner has no ORM schema of its own) you write the SQL by
hand into the scaffolded file.

Only the drizzle format is supported. Prisma support was removed: `prisma
migrate dev` emits `DROP` + `ADD` for renames, which tombstones the old
identity and mints a new one — faithfully what that SQL says, but fatal to
identity preservation unless every generated migration is hand-edited.
drizzle-kit asks "renamed or new?" at generate time and emits real
`RENAME`s, so it's the only authoring path here.

## Where do the logical ids come from?

A migration is plain SQL and the runner never parses it. When
`applyMigrations()` runs a migration, it executes the SQL verbatim with
`search_path` set to the tenant schema, then — inside the same transaction —
`ops.syncFromCatalog()` compares the registry to the Postgres catalog and
derives the bookkeeping from what the DDL actually did:

- object in catalog, not in registry → **registered**
- tracked `oid`/`attnum` now has a different name → **healed** (same
  `logical_id`, new name — this is how a `RENAME` preserves identity)
- tracked identity gone from the catalog → **tombstoned** (`dropped_at` set,
  row kept)

At registration, the id comes from one of two places:

1. **Declared** — the migration pinned it via a catalog comment (next
   section): the declared uuid is used verbatim.
2. **Minted** — no declaration: a fresh `randomUUID()` is generated at apply
   time, differing per apply and per tenant schema.

## Declaring logical ids

Declare an object's `logical_id` in the migration that **creates** it, using
`COMMENT ON`:

```sql
CREATE TABLE "card" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"name" text NOT NULL
);
--> statement-breakpoint
COMMENT ON TABLE "card" IS 'logical_id=86b4485c-391c-4615-8fe5-49ab9b2603e7';
--> statement-breakpoint
COMMENT ON COLUMN "card"."name" IS 'logical_id=82c9838d-df66-4b25-a03b-64b81305c35e';
```

This keeps the architecture honest: the DDL declares identity *into the
catalog*, and `syncFromCatalog()` reads it back via
`obj_description`/`col_description` — the runner still derives everything
from the catalog and never parses SQL. The marker just has to appear
somewhere in the comment, so prose around it is fine
(`'Display label. logical_id=<uuid>'`).

Why this matters:

- **Cross-tenant stability.** One folder applied to N tenant schemas
  registers the *same* declared id in each (the registry PK is
  `(logical_id, schema_name)`, exactly as with clones). Downstream tooling —
  e.g. a package that code-gens admin-page configuration per column — can
  key display type, labels, etc. on a `logical_id` that is valid in every
  tenant and across every environment.
- **Renames still just work.** The declaration happens once, at birth; from
  then on the `oid`/`attnum` anchors carry the identity through renames, so
  you never re-declare (and a later `COMMENT ON` an already-registered
  object has no registry effect).
- **It survives dump/restore.** `pg_dump` includes comments, so the baked
  testing image (below) and any restored database still carry the
  declarations, readable by any tool with a connection.
- **Snapshot stability.** Declared objects keep the same ids every time the
  testing image is regenerated — no diff churn.

Rules: declare in the migration that creates the object (a declaration added
later is ignored — registration already happened); reusing a uuid already
registered in the schema (including by a tombstone) fails the migration with
the collision spelled out. Undeclared objects fall back to minted ids.
`pnpm migration:new` scaffolds example `COMMENT ON` lines with fresh uuids.

## End to end

Scaffold two migrations (the first call creates the folder and
`meta/_journal.json`):

```console
$ pnpm migration:new create_users
Created drizzle/0000_create_users.sql
Journaled as idx 0 in drizzle/meta/_journal.json
$ pnpm migration:new rename_full_name
Created drizzle/0001_rename_full_name.sql
Journaled as idx 1 in drizzle/meta/_journal.json
```

Write unqualified DDL into them (no `schema.` prefixes — `search_path`
supplies the tenant schema, which is what lets one folder serve every
tenant):

```sql
-- drizzle/0000_create_users.sql
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY NOT NULL,
	"full_name" text
);
--> statement-breakpoint
COMMENT ON COLUMN "users"."full_name" IS 'logical_id=c38ea664-67e4-4591-9fc6-4df0af3e8044';
```

```sql
-- drizzle/0001_rename_full_name.sql
ALTER TABLE "users" RENAME COLUMN "full_name" TO "display_name";
```

Apply to a tenant schema (`pnpm db:up` first if the docker instance isn't
running):

```console
$ pnpm migration:apply ./drizzle demo_tenant
Applying 2 migration(s) to schema "demo_tenant"

- 0000_create_users: registered 1 table(s) / 2 column(s), healed 0, tombstoned 0
- 0001_rename_full_name: registered 0 table(s) / 0 column(s), healed 1, tombstoned 0

Registry for "demo_tenant":
┌─────────┬──────────┬──────────────────────┬────────────────────────────────────────┬────────┬────────────┐
│ (index) │ kind     │ object               │ logical_id                             │ attnum │ tombstoned │
├─────────┼──────────┼──────────────────────┼────────────────────────────────────────┼────────┼────────────┤
│ 0       │ 'table'  │ 'users'              │ 'df8e9406-277e-40a7-8c10-8bb22c82c599' │ ''     │ ''         │
│ 1       │ 'column' │ 'users.id'           │ '292470a1-7d16-4ee6-9411-8662c72d02ab' │ 1      │ ''         │
│ 2       │ 'column' │ 'users.display_name' │ 'c38ea664-67e4-4591-9fc6-4df0af3e8044' │ 2      │ ''         │
└─────────┴──────────┴──────────────────────┴────────────────────────────────────────┴────────┴────────────┘
verify: clean
```

Read that output against the two migrations: `users` and `users.id` carry
minted ids (no declaration), while `display_name` carries the **declared**
id from `0000` — declared when the column was born as `full_name`, and
carried through the `RENAME` by its `attnum` (`healed 1`, nothing minted).
That is the entire point of the package, visible in one run.

Re-running is a no-op — applied state is tracked per `(schema, name)` in
`identity_registry.migrations`:

```console
$ pnpm migration:apply ./drizzle demo_tenant
- 0000_create_users: already applied, skipped
- 0001_rename_full_name: already applied, skipped
```

Applying the same folder to a second schema starts that tenant's applied
state from scratch — every tenant gets the full sequence, and every declared
id repeats identically in the new tenant.

## How the test fixtures map to this

`test/fixtures/drizzle` and `test/fixtures/drizzle-declared` are
hand-written folders in exactly this layout (the scaffolder produces the
same shape — point `--dir` at a fixtures folder to extend them):

- `migrate-drizzle-folder.test.js` — undeclared path: `0000` creates
  `users(id, full_name, email)` → expects `registered: { tables: 1,
  columns: 3 }`; `0001` renames `full_name → display_name` and adds
  `created_at` → expects `healed: 1`.
- `migrate-declared-ids.test.js` — declared path: `widget` pins ids for the
  table and two columns (one embedded in prose), leaves one column
  undeclared, then renames a declared column and adds another declared one.
  Asserts the declared uuids verbatim, the rename carrying the id, and a
  second tenant schema registering the same declared ids.

If you add a fixture migration, update those expected counts to match what
your DDL registers/heals/tombstones.

## The baked testing image

`./drizzle` is a real (non-fixture) migration folder — currently one
migration creating the `card` table with declared logical ids — and
`db/seed.sql` holds committed, human-readable seed rows. `pnpm db:snapshot`
builds them into `db/init/testdb.sql`:

1. creates a scratch database (so test leftovers never leak into the dump),
2. bootstraps the registry and applies `./drizzle` to tenant schema `tcg`,
3. runs `db/seed.sql` with `search_path` set to that schema,
4. `pg_dump`s the result — schema, rows, catalog comments (including the
   `logical_id=` declarations), and the `identity_registry` bookkeeping
   (logical_ids, applied-migration markers) — into `db/init/testdb.sql`,
   then drops the scratch database.

docker-compose mounts `db/init/` at `/docker-entrypoint-initdb.d`, so a
fresh container boot (`pnpm db:reset`, or `db:down` + `db:up`) restores the
snapshot instead of starting empty. Because the applied-migration markers
are baked in, `migration:apply` on a restored database skips the baked
migrations and applies only new ones.

Two identity subtleties, both handled by the snapshot script:

- **oids don't survive dump/restore** (physical identity is per-database —
  the same reason `importSchema()` re-anchors). The script appends
  re-anchor `UPDATE`s to the dump that re-resolve `table_oid`/`attnum` by
  name at restore time, when the dump's names are consistent by
  construction. A restored database verifies clean.
- **Minted ids churn; declared ids don't.** Undeclared objects get fresh
  `randomUUID()`s each time the snapshot is regenerated (expected diff
  churn in `db/init/testdb.sql`); declared objects keep their ids across
  regenerations, restores, and environments.

After changing `./drizzle` or `db/seed.sql`: `pnpm db:snapshot && pnpm db:reset`.

## Failure and locking behaviour (same as events)

Each migration is one atomic transaction: DDL + registry sync +
applied-marker commit or roll back together. A failure mid-batch throws with
`err.failedIndex`; already-applied migrations are skipped on retry, so you
resume by just running the batch again. To coordinate with other workers,
take the schema's migration lock and pass its token:

```js
const mig = await beginMigration(pool, { schema, owner: "deploy-worker" });
await applyMigrations(pool, { schema, migrations, lockToken: mig.token });
await mig.end();
```

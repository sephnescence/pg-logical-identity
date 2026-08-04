# Creating and applying migrations

Four pnpm commands wrap `src/migrate.js`, named most-significant-first
(tool, then subject, then verb):

| Command | What it does |
| --- | --- |
| `pnpm drizzle:migration:new <name> [--dir <folder>]` | Scaffold `NNNN_<name>.sql` + journal entry in drizzle-kit's folder format (default `./drizzle`) |
| `pnpm drizzle:migration:apply <folder> <schema>` | Apply a drizzle-format folder to one tenant schema and print the resulting registry |
| `pnpm prisma:migration:new <name> [--dir <folder>]` | Scaffold `<timestamp>_<name>/migration.sql` in prisma's folder format (default `./prisma/migrations`) |
| `pnpm prisma:migration:apply <folder> <schema>` | Apply a prisma-format folder to one tenant schema and print the resulting registry |

The apply commands connect via `DATABASE_URL`, defaulting to the
docker-compose instance (`pnpm db:up`).

The scaffolders write the *on-disk layout* the loaders consume — they don't
diff a schema for you. In a real app, `drizzle-kit generate` or
`prisma migrate dev --create-only` produces the SQL; here (the runner has no
ORM schema of its own) you write the SQL by hand into the scaffolded file.

## Where do the logical ids come from?

**They are not in the migration files, and never will be.** A migration is
plain SQL; it says nothing about identity. When `applyMigrations()` runs a
migration, it executes the SQL verbatim with `search_path` set to the tenant
schema, then — inside the same transaction — `ops.syncFromCatalog()` compares
the registry to the Postgres catalog and derives the bookkeeping from what
the DDL actually did:

- object in catalog, not in registry → **registered** (a fresh `logical_id`
  UUID is minted right then, anchored to the catalog's `oid`/`attnum`)
- tracked `oid`/`attnum` now has a different name → **healed** (same
  `logical_id`, new name — this is how a `RENAME` preserves identity)
- tracked identity gone from the catalog → **tombstoned** (`dropped_at` set,
  row kept)

So the test expectations like `registered: { tables: 1, columns: 3 }` in
`test/migrate-drizzle-folder.test.js` are not asserting ids written by the
fixture SQL — they are asserting *counts of ids minted at apply time*. The
ids themselves are `randomUUID()` and differ per apply (and per tenant
schema; clones are what share ids, via `cloneSchema`).

## End to end: drizzle format

Scaffold two migrations (the first call creates the folder and
`meta/_journal.json`):

```console
$ pnpm drizzle:migration:new create_users
Created drizzle/0000_create_users.sql
Journaled as idx 0 in drizzle/meta/_journal.json
$ pnpm drizzle:migration:new rename_full_name
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
```

```sql
-- drizzle/0001_rename_full_name.sql
ALTER TABLE "users" RENAME COLUMN "full_name" TO "display_name";
```

Apply to a tenant schema (`pnpm db:up` first if the docker instance isn't
running):

```console
$ pnpm drizzle:migration:apply ./drizzle demo_tenant
Applying 2 migration(s) to schema "demo_tenant"

- 0000_create_users: registered 1 table(s) / 2 column(s), healed 0, tombstoned 0
- 0001_rename_full_name: registered 0 table(s) / 0 column(s), healed 1, tombstoned 0

Registry for "demo_tenant":
┌─────────┬──────────┬──────────────────────┬────────────────────────────────────────┬────────┬────────────┐
│ (index) │ kind     │ object               │ logical_id                             │ attnum │ tombstoned │
├─────────┼──────────┼──────────────────────┼────────────────────────────────────────┼────────┼────────────┤
│ 0       │ 'table'  │ 'users'              │ 'df8e9406-277e-40a7-8c10-8bb22c82c599' │ ''     │ ''         │
│ 1       │ 'column' │ 'users.id'           │ '292470a1-7d16-4ee6-9411-8662c72d02ab' │ 1      │ ''         │
│ 2       │ 'column' │ 'users.display_name' │ 'a766b413-5371-416b-92ee-c7a9259cfcb3' │ 2      │ ''         │
└─────────┴──────────┴──────────────────────┴────────────────────────────────────────┴────────┴────────────┘
verify: clean
```

Read that output against the two migrations: `0000` minted three ids
(1 table + 2 columns). `0001` minted **nothing** — `display_name` still
carries the id minted when the column was born as `full_name`, because the
`RENAME` kept its `attnum` and sync matched it by identity (`healed 1`).
That is the entire point of the package, visible in one run.

Re-running is a no-op — applied state is tracked per `(schema, name)` in
`identity_registry.migrations`:

```console
$ pnpm drizzle:migration:apply ./drizzle demo_tenant
- 0000_create_users: already applied, skipped
- 0001_rename_full_name: already applied, skipped
```

Applying the same folder to a second schema starts that tenant's applied
state from scratch — every tenant gets the full sequence.

## End to end: prisma format

Same flow, different folder shape — one directory per migration, ordered by
the timestamp prefix:

```console
$ pnpm prisma:migration:new init
Created prisma/migrations/20260804075053_init/migration.sql
$ pnpm prisma:migration:new add_body
Created prisma/migrations/20260804075054_add_body/migration.sql
```

```sql
-- prisma/migrations/20260804075053_init/migration.sql
CREATE TABLE "posts" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);
```

```sql
-- prisma/migrations/20260804075054_add_body/migration.sql
ALTER TABLE "posts" ADD COLUMN "body" TEXT;
```

```console
$ pnpm prisma:migration:apply ./prisma/migrations demo_tenant
Applying 2 migration(s) to schema "demo_tenant"

- 20260804075053_init: registered 1 table(s) / 2 column(s), healed 0, tombstoned 0
- 20260804075054_add_body: registered 0 table(s) / 1 column(s), healed 0, tombstoned 0
...
verify: clean
```

**Prisma rename caveat:** `prisma migrate dev` emits `DROP COLUMN` +
`ADD COLUMN` for a rename. Run through this package, that tombstones the old
identity and mints a new `logical_id` — which is faithfully what that SQL
says, but usually not what you meant. Hand-edit the generated
`migration.sql` into a real `ALTER TABLE ... RENAME COLUMN` to preserve
identity. drizzle-kit asks "renamed or new?" at generate time and emits real
`RENAME`s, which is why it's the recommended authoring tool.

## How the test fixtures map to this

`test/fixtures/drizzle` and `test/fixtures/prisma` are hand-written folders
in exactly these layouts (the scaffolders produce the same shape — point
`--dir` at a fixtures folder to extend them). The tests assert the sync
summaries and final column lists, not specific ids:

- `migrate-drizzle-folder.test.js` — `0000` creates `users(id, full_name,
  email)` → expects `registered: { tables: 1, columns: 3 }`; `0001` renames
  `full_name → display_name` and adds `created_at` → expects `healed: 1`
  (and the add shows up in `registered.columns`).
- `migrate-prisma-folder.test.js` — init creates `posts(id, title)` →
  `registered: { tables: 1, columns: 2 }`; add_body →
  `registered.columns: 1`.

If you add a fixture migration, update those expected counts to match what
your DDL registers/heals/tombstones.

## Failure and locking behavior (same as events)

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

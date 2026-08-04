import fs from "node:fs";
import path from "node:path";
import { assertOperable, ident, ops, withTx } from "./registry.js";

// ---------------------------------------------------------------------------
// ORM migration integration (drizzle-kit)
//
// drizzle-kit generates plain SQL migration files, and this package never
// needs to parse them. Each migration runs verbatim inside one gated
// transaction with search_path pointed at the tenant schema, and the registry
// bookkeeping is derived FROM THE CATALOG afterwards (ops.syncFromCatalog),
// still inside that transaction:
//
//   - CREATE TABLE / ADD COLUMN  -> untracked in the catalog -> registered
//   - RENAME TABLE/COLUMN        -> same oid/attnum, new name -> identity healed
//   - DROP TABLE/COLUMN          -> identity missing          -> tombstoned
//   - indexes, constraints, defaults, backfills -> no catalog-identity effect,
//     run through untouched
//
// The oid/attnum anchors do the heavy lifting: a real RENAME preserves them,
// so identity survives without the runner understanding the SQL. drizzle-kit
// prompts "renamed or new?" during generate and emits real RENAMEs, which is
// why it is the authoring tool here (prisma emits DROP + ADD for renames,
// destroying identity unless hand-edited — support for it was removed).
//
// A migration may pin an object's logical_id by declaring it in the object's
// catalog comment in the migration that creates it:
//
//   COMMENT ON TABLE "card" IS 'logical_id=<uuid>';
//   COMMENT ON COLUMN "card"."name" IS 'logical_id=<uuid>';
//
// syncFromCatalog reads the comment back when registering (still catalog-
// derived, never parsed from SQL) and uses the declared uuid instead of
// minting one. One folder applied to many tenant schemas then registers the
// SAME id in each — the anchor downstream tooling (admin-page codegen etc.)
// keys per-object configuration on. Objects without a declaration keep the
// minted-at-apply-time behaviour.
//
// Because the SQL is unqualified and the schema comes from search_path, one
// generated migration folder applies to every tenant schema — applied state
// is tracked per (schema, migration name) in identity_registry.migrations.
// ---------------------------------------------------------------------------

// drizzle-kit folder: meta/_journal.json listing entries, one <tag>.sql each.
export function loadDrizzleMigrations(folder) {
  const journal = JSON.parse(
    fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"),
  );
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => ({
      name: e.tag,
      sql: fs.readFileSync(path.join(folder, `${e.tag}.sql`), "utf8"),
    }));
}

// Apply pending migrations to one tenant schema. Same shape as applyEvents:
// each migration is atomic (DDL + registry sync + applied-marker commit or
// roll back together), a failure stops the batch with failedIndex, and the
// batch resumes cleanly on retry because applied migrations are skipped.
export async function applyMigrations(pool, { schema, migrations, lockToken }) {
  const results = [];
  for (const [i, m] of migrations.entries()) {
    try {
      results.push(
        await withTx(pool, async (c) => {
          await assertOperable(c, schema, lockToken);
          const { rows: done } = await c.query(
            `SELECT 1 FROM identity_registry.migrations
             WHERE schema_name = $1 AND name = $2`,
            [schema, m.name],
          );
          if (done.length) return { name: m.name, skipped: true };

          await c.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`);
          await c.query(`SET LOCAL search_path TO ${ident(schema)}`);
          await c.query(m.sql);
          const sync = await ops.syncFromCatalog(c, { schema });
          await c.query(
            `INSERT INTO identity_registry.migrations (schema_name, name)
             VALUES ($1, $2)`,
            [schema, m.name],
          );
          return { name: m.name, skipped: false, sync };
        }),
      );
    } catch (err) {
      err.message = `Migration ${i} (${m.name}) failed: ${err.message}`;
      err.failedIndex = i;
      throw err;
    }
  }
  return results;
}

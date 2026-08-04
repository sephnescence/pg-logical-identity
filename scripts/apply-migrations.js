import pg from "pg";
import { bootstrap, verify } from "../src/registry.js";
import { applyMigrations, loadDrizzleMigrations } from "../src/migrate.js";

// Apply a drizzle-format migrations folder to one tenant schema, then show
// what the registry now knows — including the logical_ids, which are either
// declared via COMMENT ON in the SQL or minted by ops.syncFromCatalog() at
// apply time.
//
//   pnpm migration:apply <folder> <schema>
//
// Connection comes from DATABASE_URL, defaulting to the docker-compose
// instance (pnpm db:up).

const [folder, schema] = process.argv.slice(2);
if (!folder || !schema) {
  console.error("usage: pnpm migration:apply <folder> <schema>");
  process.exit(1);
}

const url =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:54329/postgres";
const pool = new pg.Pool({ connectionString: url, max: 2 });

try {
  await bootstrap(pool);
  const migrations = loadDrizzleMigrations(folder);
  console.log(`Applying ${migrations.length} migration(s) to schema "${schema}"\n`);

  const results = await applyMigrations(pool, { schema, migrations });
  for (const r of results) {
    if (r.skipped) {
      console.log(`- ${r.name}: already applied, skipped`);
    } else {
      const { registered, healed, tombstoned } = r.sync;
      console.log(
        `- ${r.name}: registered ${registered.tables} table(s) / ` +
          `${registered.columns} column(s), healed ${healed}, tombstoned ${tombstoned}`,
      );
    }
  }

  const { rows } = await pool.query(
    `SELECT kind, table_name, column_name, logical_id, attnum,
            dropped_at IS NOT NULL AS tombstoned
     FROM identity_registry.objects
     WHERE schema_name = $1
     ORDER BY table_name, kind DESC, attnum NULLS FIRST`,
    [schema],
  );
  console.log(`\nRegistry for "${schema}":`);
  console.table(
    rows.map((r) => ({
      kind: r.kind,
      object: r.column_name ? `${r.table_name}.${r.column_name}` : r.table_name,
      logical_id: r.logical_id,
      attnum: r.attnum ?? "",
      tombstoned: r.tombstoned ? "yes" : "",
    })),
  );

  const report = await verify(pool, schema);
  console.log(report.ok ? "verify: clean" : `verify: DRIFT ${JSON.stringify(report.drift)}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

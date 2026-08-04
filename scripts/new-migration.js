import fs from "node:fs";
import path from "node:path";

// Scaffold an empty SQL migration in the on-disk format the loaders in
// src/migrate.js consume. This does not replace `drizzle-kit generate` or
// `prisma migrate dev` — in a real app those diff your schema and write the
// SQL for you. It exists so this package (which has no ORM schema, only the
// runner) can author migrations in the exact same folder layout by hand.
//
//   pnpm drizzle:migration:new <name> [--dir <folder>]   default: ./drizzle
//   pnpm prisma:migration:new  <name> [--dir <folder>]   default: ./prisma/migrations

const [format, ...rest] = process.argv.slice(2);
let dir = null;
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--dir") dir = rest[++i];
  else if (rest[i].startsWith("--dir=")) dir = rest[i].slice("--dir=".length);
  else positional.push(rest[i]);
}

const rawName = positional[0];
if (!["drizzle", "prisma"].includes(format) || !rawName) {
  console.error(
    "usage: pnpm <drizzle|prisma>:migration:new <name> [--dir <folder>]",
  );
  process.exit(1);
}
const name = rawName
  .toLowerCase()
  .replaceAll(/[^a-z0-9]+/g, "_")
  .replaceAll(/^_+|_+$/g, "");
if (!name) {
  console.error(`Migration name "${rawName}" reduces to nothing usable`);
  process.exit(1);
}

// Never schema-qualify tables in migration SQL: applyMigrations() sets
// search_path to the tenant schema, which is what lets one folder apply to
// every tenant. Logical ids are NOT declared here — ops.syncFromCatalog()
// mints/heals/tombstones them from the catalog when the migration is applied.
const template = `-- Unqualified DDL only (search_path supplies the tenant schema).
-- Use real RENAMEs to preserve logical identity; DROP + ADD mints a new one.
`;

if (format === "drizzle") {
  const folder = dir ?? "drizzle";
  const metaDir = path.join(folder, "meta");
  fs.mkdirSync(metaDir, { recursive: true });
  const journalPath = path.join(metaDir, "_journal.json");
  const journal = fs.existsSync(journalPath)
    ? JSON.parse(fs.readFileSync(journalPath, "utf8"))
    : { version: "7", dialect: "postgresql", entries: [] };
  const idx = journal.entries.length
    ? Math.max(...journal.entries.map((e) => e.idx)) + 1
    : 0;
  const tag = `${String(idx).padStart(4, "0")}_${name}`;
  const sqlPath = path.join(folder, `${tag}.sql`);
  if (fs.existsSync(sqlPath)) {
    console.error(`Refusing to overwrite existing ${sqlPath}`);
    process.exit(1);
  }
  journal.entries.push({
    idx,
    version: "7",
    when: Date.now(),
    tag,
    breakpoints: true,
  });
  fs.writeFileSync(sqlPath, template);
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n");
  console.log(`Created ${sqlPath}`);
  console.log(`Journaled as idx ${idx} in ${journalPath}`);
} else {
  const folder = dir ?? path.join("prisma", "migrations");
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[-:T]/g, "")
    .slice(0, 14);
  const migrationDir = path.join(folder, `${stamp}_${name}`);
  if (fs.existsSync(migrationDir)) {
    console.error(`Refusing to overwrite existing ${migrationDir}`);
    process.exit(1);
  }
  fs.mkdirSync(migrationDir, { recursive: true });
  const sqlPath = path.join(migrationDir, "migration.sql");
  fs.writeFileSync(sqlPath, template);
  console.log(`Created ${sqlPath}`);
  console.log(
    "Note: prisma emits DROP + ADD for renames — hand-write RENAME statements to preserve identity.",
  );
}

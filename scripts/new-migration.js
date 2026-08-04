import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Scaffold an empty SQL migration in the drizzle-kit on-disk format that
// src/migrate.js consumes. This does not replace `drizzle-kit generate` — in
// a real app that diffs your schema and writes the SQL for you. It exists so
// this package (which has no ORM schema, only the runner) can author
// migrations in the exact same folder layout by hand.
//
//   pnpm migration:new <name> [--dir <folder>]   default: ./drizzle

const rest = process.argv.slice(2);
let dir = null;
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--dir") dir = rest[++i];
  else if (rest[i].startsWith("--dir=")) dir = rest[i].slice("--dir=".length);
  else positional.push(rest[i]);
}

const rawName = positional[0];
if (!rawName) {
  console.error("usage: pnpm migration:new <name> [--dir <folder>]");
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
// every tenant. To pin logical ids (instead of minting random ones at apply
// time), declare them via COMMENT ON in the migration that creates the
// object — syncFromCatalog() reads them back from the catalog.
const template = `-- Unqualified DDL only (search_path supplies the tenant schema).
-- Use real RENAMEs to preserve logical identity; DROP + ADD mints a new one.
-- Declare stable logical ids in the migration that creates an object, e.g.:
--   COMMENT ON TABLE "thing" IS 'logical_id=${randomUUID()}';
--   COMMENT ON COLUMN "thing"."name" IS 'logical_id=${randomUUID()}';
`;

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

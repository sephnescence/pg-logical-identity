-- Seed rows for the baked testing image. Unqualified INSERTs — the snapshot
-- script (scripts/snapshot-db.js) sets search_path to the tenant schema
-- before running this file, same as migrations.
INSERT INTO "card" ("name", "collector_number", "set_identifier") VALUES
  ('Lightning Bolt', '161', 'lea'),
  ('Counterspell', '54', 'lea'),
  ('Serra Angel', '39', 'lea'),
  ('Llanowar Elves', '314', 'm19'),
  ('Shivan Dragon', '180', 'm20');

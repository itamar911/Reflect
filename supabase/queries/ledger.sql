-- Read supabase_migrations.schema_migrations — the only applied-record we have.
--
-- Run in the Supabase SQL editor. Read-only.
--
-- It holds three rows: create_notebook_pages, create_setups_and_link_trades,
-- add_setup_structured_fields. Those are exactly the three tables that no file
-- in supabase/migrations/ creates. They went through Supabase's migration tool,
-- were recorded properly, and never reached the repo.
--
-- The other twenty-six files in supabase/migrations/ have no row here at all,
-- because they were pasted into the SQL editor by hand, which records nothing.
--
-- So the split is the reverse of what we assumed: the three tables the repo
-- cannot build are the only ones with a real record, and the twenty-six files
-- the repo does contain have no evidence of ever having been applied.
--
-- Query 2 is the one that matters: it holds the ACTUAL SOURCE TEXT of those
-- three migrations. That is better than anything reconstructed from the catalog
-- — a deparse tells you what the database ended up with, this tells you what
-- was asked for, including comments, ordering and any statement that failed
-- silently and left no trace in the catalog to deparse.


-- ---------------------------------------------------------------------------
-- 1. What shape is this table? The CLI has changed it between versions.
-- ---------------------------------------------------------------------------
-- Older builds have only `version`. Newer ones add `statements text[]` and
-- `name`. Query 2 assumes the newer shape; if `statements` is not listed here,
-- the source text was never stored and query 2 will error — say so rather than
-- working around it, because then the catalog is all we have after all.

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'supabase_migrations'
  AND table_name = 'schema_migrations'
ORDER BY ordinal_position;


-- ---------------------------------------------------------------------------
-- 2. The three migrations, one statement per row.
-- ---------------------------------------------------------------------------
-- One row per statement so nothing is truncated, in original order. Paste the
-- whole output back — it becomes the backfill migration verbatim, rather than
-- something reassembled from column types and constraint definitions.

SELECT
  m.version,
  m.name,
  s.ord AS statement_no,
  s.statement
FROM supabase_migrations.schema_migrations m
CROSS JOIN LATERAL unnest(m.statements) WITH ORDINALITY AS s(statement, ord)
ORDER BY m.version, s.ord;


-- ---------------------------------------------------------------------------
-- 3. The ledger as a plain list, to compare against the repo.
-- ---------------------------------------------------------------------------
-- Expect three rows. Everything in supabase/migrations/ should eventually
-- appear here too; today none of it does.

SELECT version, name
FROM supabase_migrations.schema_migrations
ORDER BY version;


-- ---------------------------------------------------------------------------
-- 4. Does anything else live in that schema?
-- ---------------------------------------------------------------------------
-- The CLI also uses supabase_migrations for seed tracking in some versions.
-- Worth knowing what is there before treating the schema as understood.

SELECT c.relname AS table_name, c.relkind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'supabase_migrations'
ORDER BY c.relname;

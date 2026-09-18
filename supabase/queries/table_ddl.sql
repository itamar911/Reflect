-- Generate CREATE TABLE DDL for the three tables no migration creates.
--
-- Run in the Supabase SQL editor. Read-only: nothing here changes anything.
--
-- notebook_pages, rule_violations and setups are read and written by the app
-- but exist only because someone typed them into the dashboard. `setups` is
-- only ever ALTERed, by 019. Until they are backfilled, supabase/migrations/
-- cannot rebuild this database and the drift sweep reports them forever —
-- which is how a sweep stops being read.
--
-- These queries emit DDL text rather than a description of it, so the backfill
-- migration is assembled from what the database actually says rather than from
-- anyone's transcription. Paste all five outputs back.
--
-- Output is one line per row wherever it could be long, because the results
-- pane truncates long cells.


-- ---------------------------------------------------------------------------
-- 1. Columns — the body of each CREATE TABLE.
-- ---------------------------------------------------------------------------
-- format_type gives the type exactly as Postgres would print it, including
-- length and precision. Defaults come through as their real expressions
-- (gen_random_uuid(), now(), '{}'::text[] and so on), which is the part most
-- easily got wrong by hand.

SELECT
  c.relname AS table_name,
  a.attnum  AS ord,
  '  ' || quote_ident(a.attname)
       || ' ' || format_type(a.atttypid, a.atttypmod)
       || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '')
       || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
       || ',' AS column_def
FROM pg_class c
JOIN pg_namespace n  ON n.oid = c.relnamespace
JOIN pg_attribute a  ON a.attrelid = c.oid
LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE n.nspname = 'public'
  AND c.relname IN ('notebook_pages', 'rule_violations', 'setups')
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY c.relname, a.attnum;


-- ---------------------------------------------------------------------------
-- 2. Constraints — primary keys, foreign keys, unique, check.
-- ---------------------------------------------------------------------------
-- pg_get_constraintdef prints the whole clause including ON DELETE CASCADE,
-- which matters here: src/lib/account/userData.ts says all three cascade from
-- the user, and account deletion depends on that being true.

SELECT
  rel.relname AS table_name,
  con.contype AS kind,
  'ALTER TABLE public.' || rel.relname
    || ' ADD CONSTRAINT ' || quote_ident(con.conname)
    || ' ' || pg_get_constraintdef(con.oid) || ';' AS constraint_ddl
FROM pg_constraint con
JOIN pg_class rel     ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public'
  AND rel.relname IN ('notebook_pages', 'rule_violations', 'setups')
ORDER BY rel.relname, con.contype, con.conname;


-- ---------------------------------------------------------------------------
-- 3. Indexes — excluding the ones that back a constraint from query 2.
-- ---------------------------------------------------------------------------

SELECT
  i.tablename,
  i.indexdef || ';' AS index_ddl
FROM pg_indexes i
WHERE i.schemaname = 'public'
  AND i.tablename IN ('notebook_pages', 'rule_violations', 'setups')
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    JOIN pg_class ic ON ic.oid = con.conindid
    WHERE ic.relname = i.indexname
  )
ORDER BY i.tablename, i.indexname;


-- ---------------------------------------------------------------------------
-- 4. RLS state and policies.
-- ---------------------------------------------------------------------------
-- RLS is on for all three because the ensure_rls event trigger turned it on at
-- CREATE TABLE time — nobody wrote it. The backfill has to state it explicitly,
-- because a rebuild should not depend on that trigger already existing.
--
-- Run this AFTER 023, so the emitted policies already say TO authenticated.

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('notebook_pages', 'rule_violations', 'setups');

SELECT
  tablename,
  'CREATE POLICY ' || quote_ident(policyname)
    || ' ON public.' || quote_ident(tablename)
    || ' FOR ' || cmd
    || ' TO ' || array_to_string(roles, ', ')
    || COALESCE(' USING (' || qual || ')', '')
    || COALESCE(' WITH CHECK (' || with_check || ')', '')
    || ';' AS policy_ddl
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('notebook_pages', 'rule_violations', 'setups')
ORDER BY tablename, policyname;


-- ---------------------------------------------------------------------------
-- 5. Triggers on these three tables.
-- ---------------------------------------------------------------------------
-- Expect this to be empty or to show only an updated_at trigger. Anything else
-- is a fourth piece of hidden behaviour and needs reading before the backfill
-- is written.

SELECT c.relname AS table_name, t.tgname, pg_get_triggerdef(t.oid) || ';' AS trigger_ddl
FROM pg_trigger t
JOIN pg_class c     ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND n.nspname = 'public'
  AND c.relname IN ('notebook_pages', 'rule_violations', 'setups')
ORDER BY c.relname, t.tgname;


-- ---------------------------------------------------------------------------
-- What the app expects, for cross-checking the output above.
-- ---------------------------------------------------------------------------
-- If a column the app writes is missing from query 1, something is wrong with
-- the query rather than with the app — these are all in use today.
--
--   notebook_pages   id, user_id, title, content, page_type, tags,
--                    created_at, updated_at
--                    (insert in NotebookClient.tsx:79; ordered by updated_at)
--
--   rule_violations  id, user_id, rule_source, custom_rule_id, rule_key,
--                    rule_name, outcome, trade_plan_id, created_at
--                    (insert in src/lib/rules/logRuleViolation.ts:28)
--
--   setups           id, user_id, name, symbol, image_url, image_path,
--                    created_at, updated_at, + the columns SetupsClient.tsx
--                    inserts at :697
--                    (image_path added by 019, so that one IS in a migration)
--
-- All three are expected to be ON DELETE CASCADE from the user: see the
-- expectations table in src/lib/account/userData.ts:79.

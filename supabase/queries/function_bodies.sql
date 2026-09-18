-- Full bodies of the five SECURITY DEFINER functions, plus what calls them.
--
-- Run in the Supabase SQL editor. Read-only: nothing here changes anything.
--
-- Every body query returns ONE LINE PER ROW rather than one big text cell,
-- because the results pane truncates long values. Copy the whole column.
--
-- Run A first — rls_auto_enable is the one that decides whether anything else
-- in this file matters.


-- ---------------------------------------------------------------------------
-- A. rls_auto_enable — what it is wired to.
-- ---------------------------------------------------------------------------
-- An event trigger fires on DDL, so this runs when a migration runs, not when
-- a row is written. `evtevent` tells you when (ddl_command_end, sql_drop,
-- table_rewrite) and `evttags` tells you on which statements (CREATE TABLE and
-- so on). If this returns a row, every migration we have ever run has been
-- running alongside it.
--
-- If it returns NO rows, the function exists but is not wired to anything, and
-- it is inert — that changes what to do with it.

SELECT
  e.evtname      AS event_trigger_name,
  e.evtevent     AS fires_on,
  e.evtenabled   AS enabled_flag,
  e.evttags      AS only_for_these_commands,
  p.proname      AS function_name,
  pg_get_userbyid(e.evtowner) AS owner
FROM pg_event_trigger e
JOIN pg_proc p ON p.oid = e.evtfoid
ORDER BY e.evtname;


-- ---------------------------------------------------------------------------
-- B. rls_auto_enable — the body, one line per row.
-- ---------------------------------------------------------------------------

SELECT ord AS line_no, line
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL regexp_split_to_table(pg_get_functiondef(p.oid), E'\n')
  WITH ORDINALITY AS t(line, ord)
WHERE p.proname = 'rls_auto_enable'
ORDER BY ord;


-- ---------------------------------------------------------------------------
-- C. get_user_tier and the three enforce_* functions — bodies, one line per row.
-- ---------------------------------------------------------------------------
-- Ordered so the four arrive in one result set, grouped by function.
--
-- Read the enforce_* bodies for two things: whether the limit numbers are
-- hardcoded or read from a table, and whether the function does anything
-- BESIDES refusing the insert. If one also stamps a column or writes an audit
-- row, dropping it removes behaviour we still want, and 022 has to edit that
-- function instead of dropping it.

SELECT
  p.proname AS function_name,
  ord       AS line_no,
  line
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL regexp_split_to_table(pg_get_functiondef(p.oid), E'\n')
  WITH ORDINALITY AS t(line, ord)
WHERE n.nspname = 'public'
  AND p.proname IN (
    'get_user_tier', 'enforce_trade_limit', 'enforce_rules_limit', 'enforce_strategies_limit'
  )
ORDER BY p.proname, ord;


-- ---------------------------------------------------------------------------
-- D. What calls get_user_tier.
-- ---------------------------------------------------------------------------
-- Four places a function can be reached from, plus a fifth that is not a
-- "call" at all. Run all five parts; anything non-empty is a caller that has
-- to be dealt with before get_user_tier can be dropped.

-- D1. Other functions.
SELECT n.nspname AS schema, p.proname AS calling_function
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prokind = 'f'
  AND p.proname <> 'get_user_tier'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND pg_get_functiondef(p.oid) ILIKE '%get_user_tier%'
ORDER BY 1, 2;

-- D2. RLS policy expressions.
SELECT schemaname, tablename, policyname, cmd
FROM pg_policies
WHERE COALESCE(qual, '') ILIKE '%get_user_tier%'
   OR COALESCE(with_check, '') ILIKE '%get_user_tier%'
ORDER BY 1, 2, 3;

-- D3. Column defaults and generated columns.
SELECT c.relname AS table_name, a.attname AS column_name,
       pg_get_expr(d.adbin, d.adrelid) AS default_expr
FROM pg_attrdef d
JOIN pg_class c     ON c.oid = d.adrelid
JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND pg_get_expr(d.adbin, d.adrelid) ILIKE '%get_user_tier%'
ORDER BY 1, 2;

-- D4. CHECK constraints.
SELECT rel.relname AS table_name, con.conname AS constraint_name,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel     ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public'
  AND pg_get_constraintdef(con.oid) ILIKE '%get_user_tier%'
ORDER BY 1, 2;

-- D5. Not a caller — an exposure. A function in `public` that anon or
-- authenticated may EXECUTE is callable over HTTP as
-- /rest/v1/rpc/get_user_tier, whether or not anything in our code calls it.
-- That matters independently of whether we drop it.
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name IN (
    'get_user_tier', 'enforce_trade_limit', 'enforce_rules_limit',
    'enforce_strategies_limit', 'rls_auto_enable'
  )
ORDER BY routine_name, grantee;


-- ---------------------------------------------------------------------------
-- E. Confirming the five "probably Supabase's own" triggers.
-- ---------------------------------------------------------------------------
-- An object installed by an extension has a pg_depend row of type 'e' pointing
-- at that extension. Anything this returns with an extension name is managed
-- for us and must be left alone.
--
-- Note that not everything Supabase manages is extension-owned: the storage
-- and realtime schemas are maintained by Supabase's own services. Treat
-- ANYTHING outside `public` in auth, storage, realtime, graphql, vault,
-- extensions, supabase_functions, cron or net as theirs regardless of what
-- this returns, and never drop it.

SELECT
  n.nspname   AS schema,
  c.relname   AS on_table,
  t.tgname    AS trigger_name,
  e.extname   AS owned_by_extension
FROM pg_trigger t
JOIN pg_class c        ON c.oid = t.tgrelid
JOIN pg_namespace n    ON n.oid = c.relnamespace
LEFT JOIN pg_depend d  ON d.objid = t.oid AND d.deptype = 'e'
LEFT JOIN pg_extension e ON e.oid = d.refobjid
WHERE NOT t.tgisinternal
  AND t.tgname IN (
    'tr_check_filters', 'enforce_bucket_name_length_trigger',
    'protect_buckets_delete', 'protect_objects_delete', 'update_objects_updated_at'
  )
ORDER BY n.nspname, c.relname, t.tgname;

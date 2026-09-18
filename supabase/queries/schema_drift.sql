-- Where the live database and supabase/migrations disagree, in both directions.
--
-- Run in the Supabase SQL editor. Read-only: nothing here changes anything.
--
-- Why this file exists: enforce_trade_limit, enforce_rules_limit and
-- enforce_strategies_limit were created by hand in the dashboard and the repo
-- never knew about them, so flipping src/lib/plans/config.ts to one plan
-- unlocked nothing -- the database went on rejecting the 6th trade of the week.
-- The storage policies the week before were the same pattern. Objects created
-- in the dashboard are invisible to every grep, every review and every
-- deploy, so the only way to find them is to ask the catalog.
--
-- Drift runs in both directions, and this file checks both:
--
--   Queries 1-5  things the DATABASE has that the repo never created.
--   Queries 6-9  things the REPO declares that the database does not have.
--
-- The second direction is not hypothetical. 002 creates
-- personal_strategies_updated_at and alert_settings_updated_at; both tables
-- exist, both triggers do not. Everything else in 002 landed. A migration file
-- sitting in this directory is not evidence that it ran, or that all of it ran
-- — the SQL editor will happily run twenty statements, fail on the
-- twenty-first, and leave you with a file that looks applied.
--
-- Queries 1-5 subtract what the repo DOES create; queries 6-9 check each thing
-- the repo declares against the catalog. Both directions depend on the lists
-- below being in step with the migrations — add a function, trigger, table or
-- policy in a migration and add its name here in the same change, or the next
-- run reports your own object as drift and the sweep starts crying wolf.
-- (The baseline generator, when it lands, replaces both lists with something
-- derived from the migration files so they cannot rot.)


-- ---------------------------------------------------------------------------
-- 1. The three limit triggers, in full.
-- ---------------------------------------------------------------------------
-- Returns the function body AND the trigger that fires it -- both are needed to
-- drop them cleanly, since a trigger and its function are separate objects with
-- separate names.
--
-- Since 022 ran this should return ZERO ROWS, and it is kept as the regression
-- check: anything here means the plan limits are back, which can only happen by
-- someone recreating them in the dashboard.
--
-- Note it matches on function name OR trigger name. When it was first run it
-- returned nothing, because the guess at the names was wrong in both: the
-- triggers are trg_enforce_*, the functions enforce_*. Query 2 is what found
-- them. A name-based query returning nothing is not evidence of absence.

SELECT
  t.tgname                                  AS trigger_name,
  c.relname                                 AS on_table,
  n.nspname                                 AS schema,
  t.tgenabled                               AS enabled_flag,
  pg_get_triggerdef(t.oid)                  AS trigger_def,
  p.proname                                 AS function_name,
  pg_get_functiondef(p.oid)                 AS function_body
FROM pg_trigger t
JOIN pg_class c     ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p      ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND (
    p.proname IN ('enforce_trade_limit', 'enforce_rules_limit', 'enforce_strategies_limit')
    OR t.tgname IN ('enforce_trade_limit', 'enforce_rules_limit', 'enforce_strategies_limit')
  )
ORDER BY c.relname, t.tgname;


-- ---------------------------------------------------------------------------
-- 2. Every trigger the repo did not create.
-- ---------------------------------------------------------------------------
-- Repo triggers, from supabase/schema.sql and the migrations:
--   on_auth_user_created, on_profile_created, profiles_updated_at,
--   preset_rules_updated_at, personal_strategies_updated_at,
--   alert_settings_updated_at, tradovate_connections_updated_at

SELECT
  n.nspname   AS schema,
  c.relname   AS on_table,
  t.tgname    AS trigger_name,
  p.proname   AS function_name,
  pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c     ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p      ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND t.tgname NOT IN (
    'on_auth_user_created', 'on_profile_created', 'profiles_updated_at',
    'preset_rules_updated_at', 'personal_strategies_updated_at',
    'alert_settings_updated_at', 'tradovate_connections_updated_at'
  )
ORDER BY n.nspname, c.relname, t.tgname;


-- ---------------------------------------------------------------------------
-- 3. Every function in public the repo did not create.
-- ---------------------------------------------------------------------------
-- Repo functions: handle_new_user, handle_new_profile, update_updated_at
--
-- Includes the body, because a function with no trigger on it may still be
-- called from a policy, a default, another function, or a PostgREST RPC.

SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef AS is_security_definer,
  pg_get_functiondef(p.oid) AS body
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND p.proname NOT IN ('handle_new_user', 'handle_new_profile', 'update_updated_at')
ORDER BY p.proname;


-- ---------------------------------------------------------------------------
-- 4. Every RLS policy the repo did not create.
-- ---------------------------------------------------------------------------
-- Covers storage.objects too -- that is where last week's surprise lived.

SELECT
  schemaname, tablename, policyname, cmd, roles,
  qual        AS using_expr,
  with_check  AS with_check_expr
FROM pg_policies
WHERE policyname NOT IN (
  'Users can view own profile', 'Users can update own profile', 'Users can insert own profile',
  'Users can manage own preset rules', 'Users can manage own custom rules',
  'Users can manage own trade plans', 'Users can manage own insights',
  'Users can manage own streaks', 'Users can manage own alert settings',
  'Users can manage own strategies', 'Users can manage own weekly summaries',
  'personal_strategies_select', 'personal_strategies_insert',
  'personal_strategies_update', 'personal_strategies_delete',
  'tradovate_connections_select_own', 'setup_images_select'
)
ORDER BY schemaname, tablename, policyname;


-- ---------------------------------------------------------------------------
-- 5. CHECK constraints and views.
-- ---------------------------------------------------------------------------
-- A hand-added CHECK enforces a rule as invisibly as a trigger does, and is the
-- likeliest remaining place for a plan limit to be hiding. Not name-filtered:
-- there are few enough to read, and the ones the repo created are recognisable
-- (the subscription_tier tier list, the rule action/condition enums).

SELECT
  rel.relname      AS table_name,
  con.conname      AS constraint_name,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel     ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public'
  AND con.contype = 'c'
ORDER BY rel.relname, con.conname;

SELECT schemaname, viewname, definition
FROM pg_views
WHERE schemaname = 'public'
ORDER BY viewname;


-- ===========================================================================
-- THE OTHER DIRECTION — what the repo declares that the database lacks
-- ===========================================================================
-- Each of these lists what the migrations create and LEFT JOINs the catalog.
-- Any row that comes back is something this repo believes exists and which
-- does not. Zero rows is the pass condition for all four.


-- ---------------------------------------------------------------------------
-- 6. Triggers the repo creates that are missing.
-- ---------------------------------------------------------------------------
-- The three trg_enforce_* triggers are deliberately absent from this list:
-- 022 dropped them, and the repo no longer claims them.

WITH expected(schema_name, table_name, trigger_name, defined_in) AS (
  VALUES
    ('auth',   'users',                 'on_auth_user_created',            'schema.sql'),
    ('public', 'profiles',              'on_profile_created',              'schema.sql'),
    ('public', 'profiles',              'profiles_updated_at',             'schema.sql'),
    ('public', 'preset_rules',          'preset_rules_updated_at',         'schema.sql'),
    ('public', 'personal_strategies',   'personal_strategies_updated_at',  '002'),
    ('public', 'alert_settings',        'alert_settings_updated_at',       '002'),
    ('public', 'tradovate_connections', 'tradovate_connections_updated_at','017')
)
SELECT e.defined_in, e.schema_name, e.table_name, e.trigger_name, 'MISSING' AS status
FROM expected e
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_trigger t
  JOIN pg_class c     ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal
    AND n.nspname = e.schema_name
    AND c.relname = e.table_name
    AND t.tgname  = e.trigger_name
)
ORDER BY e.defined_in, e.table_name, e.trigger_name;


-- ---------------------------------------------------------------------------
-- 7. Functions the repo creates that are missing.
-- ---------------------------------------------------------------------------
-- update_updated_at() is the one to watch: every *_updated_at trigger depends
-- on it, so if it is absent then every CREATE TRIGGER referencing it fails,
-- which is the likeliest explanation for query 6 finding anything.

WITH expected(function_name, defined_in) AS (
  VALUES
    ('handle_new_user',    'schema.sql'),
    ('handle_new_profile', 'schema.sql'),
    ('update_updated_at',  'schema.sql')
)
SELECT e.defined_in, e.function_name, 'MISSING' AS status
FROM expected e
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = e.function_name
)
ORDER BY e.function_name;


-- ---------------------------------------------------------------------------
-- 8. Tables the repo creates that are missing.
-- ---------------------------------------------------------------------------
-- notebook_pages, rule_violations and setups are NOT here on purpose: no
-- migration creates them, so their absence would not be a contradiction. They
-- are the opposite problem, and queries 1-5 are where that shows up.

WITH expected(table_name, defined_in) AS (
  VALUES
    ('profiles',              'schema.sql'),
    ('preset_rules',          'schema.sql'),
    ('custom_rules',          'schema.sql / 015'),
    ('trade_plans',           'schema.sql'),
    ('ai_insights',           '001'),
    ('streaks',               '001'),
    ('weekly_summaries',      '001'),
    ('personal_strategies',   '002'),
    ('alert_settings',        '002'),
    ('tradovate_connections', '017')
)
SELECT e.defined_in, e.table_name, 'MISSING' AS status
FROM expected e
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = e.table_name AND c.relkind = 'r'
)
ORDER BY e.table_name;


-- ---------------------------------------------------------------------------
-- 9. Policies the repo creates that are missing.
-- ---------------------------------------------------------------------------
-- A missing policy on a table with RLS enabled means that table is readable by
-- nobody, which tends to announce itself. A missing policy on a table whose RLS
-- somehow got turned off means the opposite, and does not announce itself at
-- all — so pair a finding here with query 10.

WITH expected(table_name, policy_name) AS (
  VALUES
    ('profiles',              'Users can view own profile'),
    ('profiles',              'Users can update own profile'),
    ('profiles',              'Users can insert own profile'),
    ('preset_rules',          'Users can manage own preset rules'),
    ('custom_rules',          'Users can manage own custom rules'),
    ('trade_plans',           'Users can manage own trade plans'),
    ('ai_insights',           'Users can manage own insights'),
    ('streaks',               'Users can manage own streaks'),
    ('weekly_summaries',      'Users can manage own weekly summaries'),
    ('alert_settings',        'Users can manage own alert settings'),
    -- NOT expected: 'Users can manage own strategies'. 002 creates it and 004
    -- drops it, replacing it with the four per-operation policies below. A
    -- policy the migrations create and then remove must not be in this list, or
    -- the sweep reports a false MISSING forever.
    ('personal_strategies',   'personal_strategies_select'),
    ('personal_strategies',   'personal_strategies_insert'),
    ('personal_strategies',   'personal_strategies_update'),
    ('personal_strategies',   'personal_strategies_delete'),
    ('tradovate_connections', 'tradovate_connections_select_own')
)
SELECT e.table_name, e.policy_name, 'MISSING' AS status
FROM expected e
WHERE NOT EXISTS (
  SELECT 1 FROM pg_policies pp
  WHERE pp.schemaname = 'public'
    AND pp.tablename  = e.table_name
    AND pp.policyname = e.policy_name
)
ORDER BY e.table_name, e.policy_name;


-- ---------------------------------------------------------------------------
-- 10. RLS off on any table in public.
-- ---------------------------------------------------------------------------
-- Not a repo-versus-database comparison — a flat invariant. Every table in
-- public should have RLS on, either because a migration said so or because the
-- ensure_rls event trigger turned it on at CREATE TABLE time. A row here means
-- one table is served to anyone with the anon key regardless of what policies
-- it carries, because policies on a table with RLS off do nothing at all.
--
-- ── Why ensure_rls does not make this query redundant ──
--
-- ensure_rls fires on ddl_command_end for CREATE TABLE, CREATE TABLE AS and
-- SELECT INTO. That leaves four ways a table ends up here anyway:
--
--   1. It predates the event trigger. Anything created before someone typed
--      ensure_rls into the dashboard was never covered, and depended on a
--      migration saying ENABLE ROW LEVEL SECURITY explicitly.
--   2. Someone ran ALTER TABLE ... DISABLE ROW LEVEL SECURITY. ensure_rls
--      fires on CREATE, never on ALTER, so it will not undo that — not at the
--      time and not ever. This query is the only thing that would notice, which
--      is the argument for running it on a schedule rather than once.
--   3. The event trigger was absent, disabled, or erroring at the moment a
--      table was created. It logs failures with RAISE LOG, which nobody reads.
--   4. A restore or a copy brought tables in by a path that did not fire it.
--
-- So ensure_rls is a safety net for the common case, not a guarantee, and this
-- query is what actually checks the invariant. Run it even when not looking for
-- drift — it is the highest-value line in this file.
--
-- relkind covers ordinary tables ('r') and partitioned tables ('p'). A
-- partitioned parent with RLS off is the same exposure as any other table, and
-- filtering to 'r' alone would miss it.

SELECT n.nspname AS schema, c.relname AS table_name, c.relkind, 'RLS IS OFF' AS status
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND NOT c.relrowsecurity
ORDER BY c.relname;


-- ---------------------------------------------------------------------------
-- 11. RLS on, but the policies do not constrain anything.
-- ---------------------------------------------------------------------------
-- Query 10 only catches RLS being off. RLS being ON is not the same as the
-- table being protected, and both failure modes look identical in the
-- dashboard:
--
--   no policies at all   -> deny-all for non-owners. Safe, and broken: the
--                           feature that reads the table silently returns
--                           nothing for every user.
--   a policy USING(true) -> every row to every role the policy names. If that
--                           role list includes anon or public, the table is
--                           open, and RLS being enabled says nothing about it.
--
-- Neither shows up anywhere else in this file.

SELECT
  c.relname AS table_name,
  COUNT(pp.policyname) AS policy_count,
  COUNT(*) FILTER (
    WHERE pp.qual IN ('true', '(true)') OR pp.with_check IN ('true', '(true)')
  ) AS unconditional_policies,
  CASE
    WHEN COUNT(pp.policyname) = 0 THEN 'RLS ON, NO POLICIES — denies everyone'
    ELSE 'RLS ON, has an unconditional policy — check the roles column'
  END AS status
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policies pp ON pp.schemaname = n.nspname AND pp.tablename = c.relname
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND c.relrowsecurity
GROUP BY c.relname
HAVING COUNT(pp.policyname) = 0
    OR COUNT(*) FILTER (
         WHERE pp.qual IN ('true', '(true)') OR pp.with_check IN ('true', '(true)')
       ) > 0
ORDER BY c.relname;


-- ---------------------------------------------------------------------------
-- 12. Views and materialised views — the way round RLS entirely.
-- ---------------------------------------------------------------------------
-- A view does not have RLS of its own. By default it runs with the privileges
-- of the view's OWNER, so a view owned by postgres over a table with RLS
-- returns rows the caller could not have selected directly. ensure_rls does
-- nothing about this: CREATE VIEW is not one of its tags, and there would be
-- nothing for it to enable if it were.
--
-- A materialised view is worse — it is a stored copy of the data, refreshed on
-- demand, with no RLS anywhere in the picture.
--
-- There are none today (query 5 returns nothing). This exists so that the day
-- someone adds one, it is noticed. A view over an RLS-protected table should
-- either be declared WITH (security_invoker = true) — Postgres 15+, so the
-- caller's own permissions and policies apply — or not exist.

SELECT
  c.relname AS name,
  CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialised view' END AS kind,
  pg_get_userbyid(c.relowner) AS owner,
  COALESCE(
    (SELECT option_value FROM pg_options_to_table(c.reloptions)
     WHERE option_name = 'security_invoker'),
    'not set'
  ) AS security_invoker
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('v', 'm')
ORDER BY c.relkind, c.relname;

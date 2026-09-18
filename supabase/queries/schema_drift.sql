-- What is in the live database that supabase/migrations never created.
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
-- Each query below subtracts what the repo DOES create, so anything that comes
-- back is drift by definition. Keep the arrays in step with the migrations: if
-- you add a function or trigger in a migration file, add its name here too, or
-- the next run will report it as drift.
--
-- Run all five. Query 1 is the one needed right now; 2-5 are the sweep.


-- ---------------------------------------------------------------------------
-- 1. The three limit triggers, in full.
-- ---------------------------------------------------------------------------
-- Returns the function body AND the trigger that fires it -- both are needed to
-- drop them cleanly, since a trigger and its function are separate objects with
-- separate names. Paste the whole result back.

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

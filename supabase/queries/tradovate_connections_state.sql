-- What tradovate_connections actually looks like in production.
--
-- READ ONLY. Four SELECTs, no DDL, no DML. Safe to run at any time.
--
-- Run this BEFORE applying 030_tradovate_connections_oauth_environment.sql, and
-- again afterwards to confirm nothing moved.
--
-- Why it exists: 017_tradovate_connections.sql describes a table with specific
-- policies and column-level grants, but supabase/migrations/ does not describe
-- the live database — objects get created by hand in the dashboard and leave no
-- trace in the repo. 030 amends 017's table without re-establishing its grants
-- or its policy, so if either is missing in production, 030 will not restore
-- it. Read the output before assuming otherwise.
--
-- Each query is numbered, and the comment above it says what a healthy result
-- looks like.


-- ---------------------------------------------------------------------------
-- 1. Columns
--
-- Expected before 030: id, user_id, access_token_encrypted,
-- refresh_token_encrypted, expires_at, tradovate_user_id, status, created_at,
-- updated_at.
--
-- Expected after 030, additionally: environment (NOT NULL), refresh_expires_at,
-- token_type, api_hosts.
-- ---------------------------------------------------------------------------

SELECT
  ordinal_position,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'tradovate_connections'
ORDER BY ordinal_position;


-- ---------------------------------------------------------------------------
-- 2. RLS: is it on, and what policies exist
--
-- Expected: rowsecurity = true.
--
-- Expected policies: exactly ONE row —
--   policyname  tradovate_connections_select_own
--   cmd         SELECT
--   roles       {authenticated}
--   qual        (auth.uid() = user_id)
--   with_check  NULL
--
-- Anything else is a finding. In particular:
--   - roles containing {public} means the policy is NOT scoped to
--     authenticated and anon is being evaluated against it.
--   - any INSERT/UPDATE/DELETE policy means a client can write to this table,
--     which it must never be able to do.
--   - zero rows with rowsecurity = true means the table is readable by nobody
--     through PostgREST, which is safe but means 017's policy is missing.
-- ---------------------------------------------------------------------------

SELECT
  c.relname          AS table_name,
  c.relrowsecurity   AS rls_enabled,
  c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'tradovate_connections';

SELECT
  policyname,
  cmd,
  permissive,
  roles,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'tradovate_connections'
ORDER BY policyname;


-- ---------------------------------------------------------------------------
-- 3. Column-level grants for anon and authenticated
--
-- THE IMPORTANT ONE. Expected: no row anywhere in this result whose
-- column_name is access_token_encrypted or refresh_token_encrypted.
--
-- Expected for authenticated, before 030: SELECT on id, user_id, status,
-- tradovate_user_id, expires_at, created_at, updated_at.
--
-- Expected after 030, additionally: SELECT on environment, refresh_expires_at,
-- token_type. Note api_hosts is deliberately absent.
--
-- Expected for anon: no rows at all.
--
-- A row granting anything other than SELECT, or any row naming a token column,
-- means the browser can read something it must not. Fix that before running
-- anything else.
-- ---------------------------------------------------------------------------

SELECT
  grantee,
  privilege_type,
  column_name
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name = 'tradovate_connections'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY grantee, privilege_type, column_name;


-- ---------------------------------------------------------------------------
-- 4. Table-level grants
--
-- A table-level grant would override the careful column-level one above:
-- GRANT SELECT ON the whole table makes every column readable, token columns
-- included, regardless of which columns were named in a column-level grant.
--
-- Expected: no rows for anon or authenticated. Rows for postgres,
-- service_role, or the supabase_* internal roles are normal.
-- ---------------------------------------------------------------------------

SELECT
  grantee,
  privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'tradovate_connections'
ORDER BY grantee, privilege_type;


-- ---------------------------------------------------------------------------
-- 5. Constraints and triggers
--
-- Expected before 030: a PRIMARY KEY on id, a UNIQUE on user_id, a FOREIGN KEY
-- on user_id to auth.users with ON DELETE CASCADE, and the status CHECK.
-- Trigger: tradovate_connections_updated_at BEFORE UPDATE.
--
-- Expected after 030, additionally: tradovate_connections_environment_check,
-- tradovate_connections_access_token_is_ciphertext, and
-- tradovate_connections_refresh_token_is_ciphertext.
-- ---------------------------------------------------------------------------

SELECT
  con.conname    AS constraint_name,
  con.contype    AS constraint_type,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'tradovate_connections'
ORDER BY con.contype, con.conname;

SELECT
  tgname AS trigger_name,
  pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'tradovate_connections'
  AND NOT t.tgisinternal
ORDER BY tgname;


-- ---------------------------------------------------------------------------
-- 6. Row count only
--
-- No token material, no user ids — just whether anything is stored and what
-- state it is in. A non-zero count before the Phase 2 test would be surprising,
-- since the OAuth flow has never successfully completed.
-- ---------------------------------------------------------------------------

SELECT
  status,
  count(*) AS rows
FROM tradovate_connections
GROUP BY status
ORDER BY status;

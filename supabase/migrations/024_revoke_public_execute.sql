-- 024 — stop granting EXECUTE on functions to PUBLIC and anon
--
-- RUN THIS AFTER 022. 022 deletes four of the five affected functions by
-- removing the functions themselves; this removes the cause, and the one that
-- 022 leaves behind.
--
-- ── This is a class of problem, not an instance ──
--
-- Postgres grants EXECUTE to PUBLIC on every function at CREATE time. That is
-- the documented default, not a setting anyone chose and not something the
-- dashboard did. Supabase then grants USAGE on schema public to anon and
-- authenticated so PostgREST can work. Put together, every function ever
-- created in this schema has been callable by anyone with the anon key, over
-- HTTP, at /rest/v1/rpc/<name> — including SECURITY DEFINER functions, which
-- run as their owner and therefore bypass RLS.
--
-- get_user_tier was the live instance: SECURITY DEFINER, reading profiles,
-- answering "what tier is this user" to anyone holding a user UUID with no
-- authentication at all. 022 drops it. But the next function anyone writes
-- inherits exactly the same grant unless the default is changed, which is what
-- the ALTER DEFAULT PRIVILEGES below is for.
--
-- ── Is revoking safe on rls_auto_enable? ──
--
-- Yes, and this is the important question in this file, because that function
-- is load-bearing: it is what the `ensure_rls` event trigger runs, and it is
-- the reason tables created by hand in the dashboard are not wide open.
--
-- Revoking EXECUTE does not stop it. An event trigger is fired by the server
-- as part of executing DDL, not by a role calling the function, and that path
-- does not check EXECUTE privilege — the same way a row-level trigger keeps
-- firing for users who cannot call its function directly. The privilege only
-- governs direct invocation.
--
-- Direct invocation is also not how anyone would have exploited it: a function
-- declared RETURNS event_trigger errors out if called normally, because it can
-- only run in event-trigger context. So the practical exposure here was low.
-- The grant is still wrong, revoking costs nothing, and "low" is not a reason
-- to leave a SECURITY DEFINER function that runs dynamic ALTER TABLE callable
-- by an unauthenticated role.
--
-- Verification step 3 below proves the event trigger still works afterwards.
-- If it somehow does not, the rollback is one line and is given there.
--
-- ── Why a blanket revoke is safe here ──
--
-- The application calls no RPCs at all: `grep -rn "\.rpc(" src/ scripts/`
-- returns nothing. Every database access goes through PostgREST table
-- endpoints, which this file does not touch. So nothing in Reflect can break
-- from losing function EXECUTE, and anything that needs it later should be
-- granted explicitly to `authenticated`, one function at a time, in its own
-- migration.
--
-- Scoped to `public` only. auth, storage, realtime, graphql, vault,
-- extensions, supabase_functions, cron and net are Supabase's and are left
-- exactly alone — revoking in those would break the platform.

-- 1. Every function that exists in public today.
--
-- Written as a loop rather than a list because the point is to leave nothing
-- behind, including functions neither of us has seen yet. Same reason the
-- drift sweep exists at all.
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind IN ('f', 'p')   -- functions and procedures, not aggregates
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn.sig);
    RAISE LOG 'revoked EXECUTE on %', fn.sig;
  END LOOP;
END
$$;

-- 2. Every function created in public from now on.
--
-- ALTER DEFAULT PRIVILEGES applies per creating role, so it has to name the
-- roles that actually create functions here. `postgres` is what the dashboard
-- SQL editor runs as and owns ensure_rls; supabase_admin is included because
-- it is the other role that has created objects in this database.
--
-- This changes the default for FUTURE functions only. Statement 1 is what
-- handles the ones that already exist.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;


-- ── Verification ──

-- 1. No function in public is executable by PUBLIC, anon or authenticated.
--    Expect zero rows.
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated')
ORDER BY routine_name, grantee;

-- 2. The default is changed for new functions. Expect a row per role above
--    with defaclacl showing the revoke.
SELECT pg_get_userbyid(defaclrole) AS for_role, defaclobjtype, defaclacl
FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public'
  AND d.defaclobjtype = 'f';

-- 3. THE IMPORTANT ONE — ensure_rls still fires after the revoke.
--    Run all four statements. The third must report rowsecurity = true.
--
--      CREATE TABLE public._rls_canary (id int);
--      SELECT relname, relrowsecurity AS rowsecurity
--      FROM pg_class WHERE relname = '_rls_canary';
--      DROP TABLE public._rls_canary;
--
--    If rowsecurity comes back false, the revoke did affect the event trigger
--    after all. Roll back with:
--
--      GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO PUBLIC;
--
--    and tell me — that would contradict how event triggers are documented to
--    work and is worth understanding rather than working around.


-- ── Not fixed here ──
--
-- Table and column privileges are untouched. anon and authenticated keep their
-- SELECT/INSERT/UPDATE/DELETE grants on public tables, because that is how
-- PostgREST serves the app, and RLS is what constrains them. This file is only
-- about functions.

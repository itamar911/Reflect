-- 024 — revoke EXECUTE on the functions in `public` from PUBLIC and anon
--
-- RUN THIS AFTER 022, AND BEFORE 026. Ordering note at the foot; it matters.
--
-- ── What happened to the first version of this file ──
--
-- It also tried to change the default for future functions, with
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres       IN SCHEMA public ...
--   ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public ...
--
-- The second statement cannot work on managed Supabase: ALTER DEFAULT
-- PRIVILEGES requires membership in the role it names, and the SQL editor's
-- `postgres` is not a member of supabase_admin. The editor wraps the file in a
-- transaction, so that one failure rolled back the revokes as well, and the
-- file did nothing at all.
--
-- The whole attempt is gone rather than trimmed to the postgres half. See the
-- note at the foot for why, and for where the guarantee actually lives now.
--
-- ── What this file is for ──
--
-- Postgres grants EXECUTE to PUBLIC on every function at CREATE time. That is
-- the documented default, not a setting anyone chose. Supabase then grants
-- USAGE on schema public to anon and authenticated so PostgREST can work.
-- Together, every function ever created here has carried an EXECUTE grant that
-- nobody asked for.
--
-- Four functions remain in public after 022:
--
--   handle_new_user()     SECURITY DEFINER, RETURNS trigger
--   handle_new_profile()  SECURITY DEFINER, RETURNS trigger
--   update_updated_at()   SECURITY DEFINER, RETURNS trigger
--   rls_auto_enable()     SECURITY DEFINER, RETURNS event_trigger
--
-- None of them is reachable over PostgREST today, and it is worth being precise
-- about why: a function declared RETURNS trigger or RETURNS event_trigger
-- cannot be invoked as an ordinary call — Postgres refuses it, because such a
-- function can only run in trigger context. The protection is the return type,
-- not the grant.
--
-- get_user_tier was the counter-example and the reason this file exists. It was
-- SECURITY DEFINER too, but it RETURNED TEXT, so nothing stopped it: it
-- answered "what tier is this user" to anyone holding a user UUID, over HTTP,
-- with no authentication, bypassing RLS. 022 dropped it.
--
-- So this file removes four grants that nothing currently exploits. That is
-- deliberate but it is not the point — see the foot of the file.

-- ── Can revoking EXECUTE stop a trigger firing? No. ──
--
-- Worth stating for each of these rather than by analogy, because one of them
-- is in the signup path and being wrong about it is expensive.
--
-- EXECUTE on a trigger function is checked when the TRIGGER IS CREATED — the
-- role running CREATE TRIGGER needs it. It is not checked when the trigger
-- FIRES: the trigger is an attribute of the table, and the executor invokes the
-- function directly as part of the statement. The same is true of event
-- triggers, which the server fires while executing DDL. So:
--
--   handle_new_user    fires on INSERT INTO auth.users, driven by GoTrue as
--                      supabase_auth_admin. That role does not need EXECUTE
--                      for the trigger to fire, and does not have it after
--                      this file runs. This is the highest-stakes one here:
--                      if the reasoning above is wrong, signup breaks. Test it
--                      (verification 3) immediately, not later.
--   handle_new_profile fires on INSERT INTO profiles, which is itself done by
--                      handle_new_user. Same mechanism, one level down.
--   update_updated_at  fires on UPDATE of five tables, driven by ordinary
--                      authenticated requests. Same mechanism.
--   rls_auto_enable    fired by the server at ddl_command_end. Same mechanism.
--
-- Owners keep their privileges regardless: REVOKE ... FROM PUBLIC does not
-- touch what `postgres` can do with functions it owns, so the role that runs
-- migrations can still CREATE TRIGGER against them.
--
-- Rollback for any one of them is a single GRANT, given in verification 4.

REVOKE ALL ON FUNCTION public.handle_new_user()    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.handle_new_profile() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_updated_at()  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rls_auto_enable()    FROM PUBLIC, anon;

-- Named explicitly rather than looped. There are four, the list is the point —
-- if a fifth appears, the standing assertion should be what tells you, not a
-- loop in a migration that ran once months ago and reported nothing.


-- ── Verification ──

-- 1. No function in public is executable by PUBLIC, anon or authenticated.
--    Expect zero rows.
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated')
ORDER BY routine_name, grantee;

-- 2. ensure_rls still fires. Run all three; the second must report true.
--
--      CREATE TABLE public._rls_canary (id int);
--      SELECT relname, relrowsecurity AS rowsecurity
--      FROM pg_class WHERE relname = '_rls_canary';
--      DROP TABLE public._rls_canary;

-- 3. SIGNUP STILL WORKS. Do this one, and do it now rather than at the end of
--    the session. Create a throwaway account through the app, then:
--
--      SELECT id, email, created_at FROM profiles ORDER BY created_at DESC LIMIT 1;
--
--    A row for the new account means handle_new_user fired and
--    handle_new_profile behind it. No row means the reasoning above is wrong
--    for a trigger fired by supabase_auth_admin, and you should roll back
--    immediately with verification 4 and tell me — that would be worth
--    understanding rather than working around.
--
--    Delete the throwaway account afterwards through the app's own deletion
--    flow, which exercises the cascade and is a useful thing to have checked.

-- 4. Rollback, per function, if any of the above fails:
--
--      GRANT EXECUTE ON FUNCTION public.handle_new_user()    TO PUBLIC;
--      GRANT EXECUTE ON FUNCTION public.handle_new_profile() TO PUBLIC;
--      GRANT EXECUTE ON FUNCTION public.update_updated_at()  TO PUBLIC;
--      GRANT EXECUTE ON FUNCTION public.rls_auto_enable()    TO PUBLIC;


-- ── Run 024 before 026, and here is why ──
--
-- 026 runs CREATE OR REPLACE TRIGGER ... EXECUTE FUNCTION update_updated_at().
-- CREATE TRIGGER checks EXECUTE on the function at creation time, and this file
-- has just revoked it from PUBLIC. That is fine when the SQL editor runs as
-- `postgres`, which owns the function and therefore keeps the privilege
-- implicitly — but it would fail for any other role. If migrations are ever run
-- by something that is not the owner, this ordering becomes a real constraint
-- rather than a note.


-- ── What this file does NOT do, and where the guarantee lives instead ──
--
-- It does not stop the next function inheriting the same grant. The default is
-- Postgres's, and on managed Supabase it can only be changed per creating role,
-- for roles you are a member of — which in practice means `postgres` and no
-- others. Even done for `postgres`, it would be invisible state living in
-- pg_default_acl that nothing in this repo describes, which is the category of
-- thing this whole exercise exists to stop relying on.
--
-- So the guarantee is a standing assertion, not a migration: query 13 of
-- supabase/queries/schema_drift.sql fails on any function in public carrying
-- EXECUTE for PUBLIC, anon or authenticated. Query 14 does the same for any
-- policy granted TO public. Both run every time the sweep runs, which is how
-- they catch the function written next month rather than the four written
-- before today.
--
-- Read that way, the four REVOKEs above are the cheap part: they remove grants
-- nothing needs, and they make the assertion pass from a clean start. The
-- assertion is what actually protects anything.

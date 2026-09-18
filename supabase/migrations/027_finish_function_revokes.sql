-- 027 — finish what 024 started: revoke EXECUTE from `authenticated` too,
--       and put the owner's own EXECUTE back explicitly
--
-- RUN THIS BEFORE 026. See "Why this must precede 026" at the foot — it is not
-- a preference, 026 can fail without it.
--
-- ── Why there is a 027 at all ──
--
-- 024 revoked FROM PUBLIC, anon. Query 13 of queries/schema_drift.sql asserts
-- on PUBLIC, anon AND authenticated. Those two disagree, which is my error, not
-- a deliberate narrowing: after 024 the assertion still returns four rows, so
-- the baseline is not zero and the argument for the whole exercise — that the
-- first row to appear means something — does not yet hold.
--
-- An assertion that starts out failing on four known-benign rows acquires an
-- exception list, and an assertion with an exception list is one nobody reads.
-- Getting to a true zero is the point.
--
-- ── Does `authenticated` need EXECUTE? No, for the same reason ──
--
-- Same argument as 024 made for PUBLIC and anon, and it does not weaken for a
-- signed-in role. EXECUTE on a trigger function is checked when the TRIGGER IS
-- CREATED, not when it fires; at fire time the trigger is an attribute of the
-- table and the executor invokes the function as part of the statement, with no
-- privilege check on that path. Event triggers are fired by the server during
-- DDL, likewise.
--
--   update_updated_at   fires on UPDATE of five tables, from ordinary
--                       authenticated requests. This is the one where a
--                       signed-in role is actually in the picture, and it still
--                       does not need the grant — the UPDATE fires the trigger,
--                       the caller never calls the function.
--   handle_new_user     fires as supabase_auth_admin. Confirmed working after
--                       024 by creating an account and seeing the profiles row.
--   handle_new_profile  fires behind handle_new_user.
--   rls_auto_enable     fired by the server at ddl_command_end.
--
-- `authenticated` is also the grantee that matters most for reachability: it is
-- the role every signed-in browser session runs as, so a function it may
-- EXECUTE is callable over HTTP by any user with an account. These four return
-- trigger or event_trigger and so cannot be invoked as ordinary calls at all —
-- but that is a property of what they happen to return, not a rule. Leaving the
-- grant in place because today's functions are inert is how the next one, which
-- returns text, inherits it unnoticed. That was get_user_tier exactly.
--
-- ── The owner grant ──
--
-- After 024, `postgres` and `service_role` also stopped appearing in
-- information_schema.routine_privileges for these functions.
--
-- For service_role that is fine: its key is server-side only, it bypasses RLS
-- anyway, and it needs no function EXECUTE for anything Reflect does.
--
-- For the owner it is worth being careful, because a function owner's
-- privileges are NOT implicit in the way I said in 024's footer. They are
-- recorded in the ACL like anyone else's, an owner can revoke their own, and
-- `postgres` on managed Supabase is not a superuser that bypasses the check. If
-- the owner genuinely lacks EXECUTE then CREATE TRIGGER — which does check it,
-- at creation time — fails. Nothing is unrecoverable, because an owner can
-- always grant back to themselves, which is what the loop below does.
--
-- It grants to whoever actually owns each function rather than to a hardcoded
-- `postgres`, so it stays correct if ownership differs from what we assume. It
-- is a no-op where the privilege is already there.
--
-- This does not weaken query 13: that asserts on PUBLIC, anon and authenticated
-- only, and deliberately not on the owner.

DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig, pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'handle_new_user', 'handle_new_profile', 'update_updated_at', 'rls_auto_enable'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn.sig, fn.owner);
    RAISE LOG 'revoked authenticated, restored owner % on %', fn.owner, fn.sig;
  END LOOP;
END
$$;


-- ── Verification ──

-- 1. Query 13's baseline is now zero. Expect zero rows.
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated')
ORDER BY routine_name, grantee;

-- 2. The authoritative view of what each ACL actually holds.
--
--    Read this rather than information_schema, which only shows rows whose
--    grantor or grantee is a role the CURRENT user is a member of — so it can
--    hide entries rather than prove their absence. proacl is the stored ACL
--    itself. Expect one entry per function, of the form <owner>=X/<owner>.
--    A NULL proacl means "defaults", which for a function includes EXECUTE to
--    PUBLIC — so NULL here would mean 024 and this file did not take.
SELECT
  p.proname,
  pg_get_userbyid(p.proowner) AS owner,
  p.proacl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY p.proname;

-- 3. Signup still works, again. 024's revoke has already been proved against
--    handle_new_user; this one adds `authenticated`, which is not in that path,
--    but the check is thirty seconds and the failure mode is signup.

-- 4. Rollback, if anything above fails:
--
--      GRANT EXECUTE ON FUNCTION public.handle_new_user()    TO authenticated;
--      GRANT EXECUTE ON FUNCTION public.handle_new_profile() TO authenticated;
--      GRANT EXECUTE ON FUNCTION public.update_updated_at()  TO authenticated;
--      GRANT EXECUTE ON FUNCTION public.rls_auto_enable()    TO authenticated;


-- ── Why this must precede 026 ──
--
-- 026 runs CREATE OR REPLACE TRIGGER ... EXECUTE FUNCTION update_updated_at().
-- CREATE TRIGGER checks EXECUTE on the function at creation time. After 024,
-- the owner's entry was no longer visible, so that check may now fail — 026
-- would error with "permission denied for function update_updated_at" and, in
-- the editor's single transaction, do nothing.
--
-- The GRANT loop above removes that risk. Run 027, then 026.
--
-- If you have already run 026 successfully, then the owner did retain EXECUTE
-- and only the information_schema view was hiding it. Run 027 anyway: the
-- revoke of `authenticated` is still needed, and the grant is a no-op.

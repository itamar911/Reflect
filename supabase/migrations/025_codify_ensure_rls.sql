-- 025 — put `ensure_rls` in the repo
--
-- The `ensure_rls` event trigger enables row level security on every table
-- created in `public`. It is the only reason notebook_pages, rule_violations
-- and setups are not wide open: nobody wrote ENABLE ROW LEVEL SECURITY for any
-- of them, the trigger did it at CREATE TABLE time.
--
-- It exists because somebody typed it into the dashboard once. It is owned by
-- `postgres`, not `supabase_admin`, so it is ours to maintain — nobody else is
-- watching it — and nothing in this repo would recreate it. A fresh project
-- built from these files comes up without it, and then the first table anyone
-- creates has RLS off, every policy on that table is inert, and PostgREST
-- serves it to anyone holding the anon key.
--
-- That is the failure this file exists to prevent. It is easy to cause and
-- almost impossible to notice, because the damage lands on a table that does
-- not exist yet.
--
-- ── What this file is for ──
--
-- Against production: a no-op, or as close as makes no difference. The function
-- is replaced with text identical to what is already there, and the event
-- trigger is only created if it is missing. Run it anyway — that is what proves
-- the file reproduces what is live.
--
-- Against a fresh project: this is the thing that installs the safety net.
--
-- ── The body below is the live one, not a reconstruction ──
--
-- Taken from pg_get_functiondef and left byte-faithful. That matters more here
-- than it did in 022: there, a paraphrase would have been a slightly inaccurate
-- comment on something already deleted. Here it is CREATE OR REPLACE against a
-- live function that turns RLS on, so a reconstruction that is subtly wrong
-- does not sit in a comment — it becomes the behaviour.
--
-- Two things that had to survive, and did:
--
--   SECURITY DEFINER              the trigger ALTERs tables it does not own,
--                                 so without this it fails on the first table
--                                 created by any other role.
--   SET search_path TO 'pg_catalog'
--                                 stricter than pinning it to public, and the
--                                 right choice: nothing inside the function
--                                 can resolve out of a schema anyone else can
--                                 write to. pg_event_trigger_ddl_commands()
--                                 lives in pg_catalog, and the dynamic ALTER
--                                 is built from cmd.object_identity, which is
--                                 already qualified — so nothing needs public
--                                 on the path.
--
-- Three details in the body worth knowing, none of them changed here:
--
--   * The row filter carries three guards against system schemas AFTER the
--     IN ('public') that already excludes them. Redundant, and kept, because
--     this is what is live and the point of the file is to reproduce it.
--   * object_type covers 'partitioned table' as well as 'table', so a
--     partitioned parent is covered too.
--   * The inner EXCEPTION WHEN OTHERS swallows a failure to enable RLS and
--     only RAISE LOGs it. So a table CAN be created with RLS off and nothing
--     will say so at the time. That is not a flaw to fix here — changing it
--     would change behaviour — but it is the concrete reason query 10 of
--     queries/schema_drift.sql has to exist and has to be run on a schedule.

-- ═══════════════════════════════════════════════════════════════════════════
-- Verbatim, from pg_get_functiondef. Byte-faithful: not reformatted, conditions
-- not reordered, so a future diff against pg_get_functiondef comes back clean.
-- The only character not from that output is the terminating semicolon, which
-- is on its own line below so every line of the definition stays exactly as the
-- catalog prints it. pg_get_functiondef does not emit it and the file will not
-- run without it.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
    IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
    ELSE
      RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
    END IF;
  END LOOP;
END;
$function$
;


-- The event trigger itself.
--
-- CREATE EVENT TRIGGER has no IF NOT EXISTS, and DROP-then-CREATE would leave a
-- window — however brief — in which a CREATE TABLE could complete with no RLS.
-- Creating it only when absent avoids that, and makes the file safe to run
-- against production, where it already exists.
--
-- Requires a role that may create event triggers. The Supabase SQL editor runs
-- as `postgres`, which can; this will fail from anywhere that cannot, which is
-- the correct outcome rather than something to work around.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'ensure_rls') THEN
    CREATE EVENT TRIGGER ensure_rls
      ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      EXECUTE FUNCTION public.rls_auto_enable();
    RAISE LOG 'created event trigger ensure_rls';
  ELSE
    RAISE LOG 'event trigger ensure_rls already present, left alone';
  END IF;
END
$$;

-- Not callable over PostgREST. CREATE OR REPLACE keeps whatever grants the
-- function already had, but a fresh CREATE grants EXECUTE to PUBLIC by default
-- — so on a new project these lines are what stop a SECURITY DEFINER function
-- that runs dynamic ALTER TABLE from being reachable with a publishable key.
--
-- They matter more than they would have before. 024's attempt to change the
-- default for future functions was dropped: ALTER DEFAULT PRIVILEGES only works
-- per creating role, for roles you are a member of, and the SQL editor's
-- postgres is not a member of supabase_admin. So nothing stops a new function
-- inheriting the grant, and every CREATE has to revoke for itself. The three
-- grantees here match what query 13 of queries/schema_drift.sql asserts on.
--
-- Revoking does not stop the event trigger firing: an event trigger is invoked
-- by the server while executing DDL, not by a role calling the function, and
-- that path checks no EXECUTE privilege. Verification step 3 proves it.
--
-- The owner keeps EXECUTE explicitly, for the reason 027 spells out: an owner's
-- privileges are not implicit, and CREATE EVENT TRIGGER checks EXECUTE on the
-- function at creation time.
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  owner_role text;
BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO owner_role
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable';

  EXECUTE format('GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO %I', owner_role);
END
$$;


-- ── Verification ──

-- 1. The event trigger exists and is wired to the right function and events.
--    Expect: ensure_rls | ddl_command_end | O | {"CREATE TABLE","CREATE TABLE AS","SELECT INTO"} | rls_auto_enable
SELECT e.evtname, e.evtevent, e.evtenabled, e.evttags, p.proname,
       pg_get_userbyid(e.evtowner) AS owner
FROM pg_event_trigger e
JOIN pg_proc p ON p.oid = e.evtfoid
WHERE e.evtname = 'ensure_rls';

-- 2. The function is still SECURITY DEFINER with the same pinned search_path.
--    Expect: security_definer = true, proconfig = {search_path=pg_catalog},
--    and proacl holding only the owner. Anything else means this file changed
--    something it was meant to reproduce.
SELECT p.proname, p.prosecdef AS security_definer, p.proconfig, p.proacl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable';

-- 2b. The definition still matches what was committed. Run this BEFORE and
--     AFTER, and compare: identical output means CREATE OR REPLACE was the
--     no-op it is supposed to be against production. The committed block is
--     byte-faithful, so the only expected difference anywhere is the
--     terminating semicolon, which this does not print.
SELECT md5(pg_get_functiondef(p.oid)) AS definition_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable';

-- 3. It actually fires. Run all four statements; the third must report true.
--
--      CREATE TABLE public._rls_canary (id int);
--      SELECT relname, relrowsecurity AS rowsecurity
--      FROM pg_class WHERE relname = '_rls_canary';
--      DROP TABLE public._rls_canary;
--
--    This is the same canary as 024's, and it is worth running again here:
--    024 proved the revoke did not break it, this proves the CREATE OR REPLACE
--    did not either.


-- ── The rule this leaves behind ──
--
-- Do not rely on ensure_rls in a migration. It is a safety net for tables made
-- outside this repo, not a substitute for saying what you mean: every
-- CREATE TABLE in a migration should be followed by its own
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY and its policies, so the file
-- describes the security of the table it creates. See supabase/README.md.

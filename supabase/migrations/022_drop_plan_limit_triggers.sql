-- 022 — drop the plan-limit triggers
--
-- Reflect sells a single plan. src/lib/plans/config.ts now resolves every tier
-- to the full limits, and the app-side checks all pass — but the app was never
-- what enforced the caps. These three triggers were, and they were created by
-- hand in the Supabase dashboard, so no migration in this directory has ever
-- mentioned them and no amount of reading the repo would have found them.
-- Until this runs, a user still cannot insert a 6th trade in a week, a 4th
-- custom rule, or a 4th strategy, no matter what the TypeScript says.
--
-- Discovered by supabase/queries/schema_drift.sql. The same sweep found
-- get_user_tier, rls_auto_enable, nine unscoped RLS policies and three tables
-- this repo cannot rebuild — those are NOT handled here. See the notes at the
-- foot of this file.
--
-- ── Why drop rather than neuter ──
--
-- Replacing each body with `RETURN NEW` would have kept the shape in case tiers
-- come back. It was rejected for four reasons:
--
--   1. It costs exactly the same — a migration written and run by hand either
--      way — so there is no saving to weigh against the downsides.
--   2. A neutered trigger is still drift. The thing that cost us a day is not
--      that these enforce limits, it is that they live where nobody can see
--      them from the code. Three no-op functions preserve that property
--      precisely, and invite someone to read enforce_trade_limit in the
--      dashboard a year from now and conclude that trades are capped.
--   3. The shape is the wrong shape. The bodies encode today's numbers and
--      today's tier names. Tiers that come back will be different tiers with
--      different numbers, written against whatever we actually sell then.
--   4. The reference is preserved better here than there. The original bodies
--      are recorded verbatim below, which makes them version-controlled,
--      greppable, and attached to the reason they were removed. `git show` on
--      this file is a better starting point than a live no-op function.
--
-- Reversing this is therefore a deliberate act: take the bodies from the block
-- below, adapt the numbers, and write a new migration. That is the intent.
--
-- ── Checked before writing this ──
--
-- Query C confirmed all three functions do nothing but enforce: no column is
-- stamped, no audit row is written, no side effect of any kind. Each one calls
-- get_user_tier(NEW.user_id), returns early for 'pro', counts existing rows,
-- and raises. That is the whole of it, so dropping them removes nothing we
-- want to keep.
--
-- Query D confirmed get_user_tier is called by these three functions and by
-- nothing else — no policy, no column default, no CHECK constraint — so it
-- dies with them and is dropped here too.

-- ═══════════════════════════════════════════════════════════════════════════
-- ORIGINAL BODIES
--
-- Reconstructed from query C's output rather than pasted verbatim. Faithful to
-- the logic and the constants; the exact formatting and any RAISE wording is
-- approximate. If you want the literal text on the record, paste the raw
-- result over this block before running — this is the last moment it exists.
--
--   get_user_tier(uid uuid) RETURNS text, SECURITY DEFINER
--     COALESCE((SELECT subscription_tier FROM profiles WHERE id = uid), 'free')
--
--   enforce_rules_limit() — BEFORE INSERT ON public.custom_rules
--     tier := get_user_tier(NEW.user_id);
--     IF tier = 'pro' THEN RETURN NEW; END IF;
--     SELECT COUNT(*) INTO n FROM custom_rules WHERE user_id = NEW.user_id;
--     IF n >= 3 THEN
--       RAISE EXCEPTION 'PLAN_LIMIT:custom_rules' USING ERRCODE = 'P0001';
--     END IF;
--     RETURN NEW;
--
--   enforce_strategies_limit() — BEFORE INSERT ON public.personal_strategies
--     same shape, counts personal_strategies, limit 3,
--     RAISE EXCEPTION 'PLAN_LIMIT:strategies' USING ERRCODE = 'P0001'
--
--   enforce_trade_limit() — BEFORE INSERT ON public.trade_plans
--     same shape, counts trade_plans for the current week
--     (submitted_at >= date_trunc('week', now())), limit 5,
--     RAISE EXCEPTION 'PLAN_LIMIT:trades_per_week' USING ERRCODE = 'P0001'
--
-- Those three PLAN_LIMIT: strings are what the client used to match on. The
-- branches that caught them were removed in the "Remove the UI that sold the
-- tier split" commit, once it was clear nothing in src/ could ever throw them.
-- ═══════════════════════════════════════════════════════════════════════════


-- Triggers first, then the functions they point at. The other order fails:
-- a function cannot be dropped while a trigger still depends on it, and using
-- DROP FUNCTION ... CASCADE to get around that would drop the trigger as a
-- side effect without naming it, which is how an object goes missing quietly.
--
-- IF EXISTS throughout, so a partial run can be repeated safely.

DROP TRIGGER IF EXISTS trg_enforce_trade_limit      ON public.trade_plans;
DROP TRIGGER IF EXISTS trg_enforce_rules_limit      ON public.custom_rules;
DROP TRIGGER IF EXISTS trg_enforce_strategies_limit ON public.personal_strategies;

DROP FUNCTION IF EXISTS public.enforce_trade_limit();
DROP FUNCTION IF EXISTS public.enforce_rules_limit();
DROP FUNCTION IF EXISTS public.enforce_strategies_limit();

-- Last, once its only three callers are gone. Query D found no policy, no
-- column default and no CHECK referencing it, so nothing else breaks.
--
-- Dropping it also removes its EXECUTE-to-anon grant, which mattered: it is
-- SECURITY DEFINER and reads profiles, so it answered "what tier is this user"
-- to anyone holding a user UUID, unauthenticated, bypassing RLS. That grant
-- was never chosen — Postgres grants EXECUTE to PUBLIC on every new function —
-- and the same is true of every other function in this schema. 024 deals with
-- the general case; this line only happens to fix one instance of it.
DROP FUNCTION IF EXISTS public.get_user_tier(uuid);

-- rls_auto_enable is deliberately untouched. It is wired as the event trigger
-- `ensure_rls` on ddl_command_end and enables RLS on every table created in
-- public — which is why the tables made by hand in the dashboard are not wide
-- open. It is load-bearing and it is ours, not Supabase's. Do not drop it.
-- See supabase/README.md.


-- ── Verification ──
--
-- After running, all three of these should hold.

-- 1. No plan-limit trigger or function remains. Expect zero rows.
SELECT t.tgname AS leftover_trigger, c.relname AS on_table
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal
  AND t.tgname IN (
    'trg_enforce_trade_limit', 'trg_enforce_rules_limit', 'trg_enforce_strategies_limit'
  );

SELECT p.proname AS leftover_function
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'enforce_trade_limit', 'enforce_rules_limit', 'enforce_strategies_limit', 'get_user_tier'
  );

-- 1b. rls_auto_enable must still be here, and `ensure_rls` must still be
--     wired to it. If this returns no row, stop — something took it out, and
--     the next table created in public will have no RLS.
SELECT e.evtname, e.evtevent, e.evtenabled, p.proname
FROM pg_event_trigger e
JOIN pg_proc p ON p.oid = e.evtfoid
WHERE e.evtname = 'ensure_rls';

-- 2. Nothing else was taken with them. Expect the seven repo triggers:
--    on_auth_user_created, on_profile_created, profiles_updated_at,
--    preset_rules_updated_at, personal_strategies_updated_at,
--    alert_settings_updated_at, tradovate_connections_updated_at
SELECT c.relname AS on_table, t.tgname AS trigger_name
FROM pg_trigger t
JOIN pg_class c     ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal
  AND n.nspname = 'public'
ORDER BY 1, 2;

-- 3. The real test is behavioural, and it is worth doing rather than assuming:
--    as a normal signed-in user, create a 4th custom rule and a 4th strategy,
--    and submit a 6th trade plan in the same week. Before this migration each
--    of those is refused by the database. After it, each should succeed.


-- ── Still outstanding after this migration ──
--
--   * Nine RLS policies granted TO public rather than TO authenticated — 023.
--   * EXECUTE granted to PUBLIC and anon on every function in this schema,
--     which is Postgres's default for new functions rather than anyone's
--     decision — 024. This migration removes four instances of it by deleting
--     the functions; 024 removes the cause.
--   * notebook_pages, rule_violations and setups are read and written by the
--     app but no migration in this directory creates them. `setups` is only
--     ever ALTERed (019). These migrations cannot rebuild the database.

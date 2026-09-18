-- 022 — drop the plan-limit triggers
--
-- DO NOT RUN THIS UNTIL THE BODIES ARE PASTED IN BELOW. See "Before running".
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
-- ── Before running ──
--
-- The ORIGINAL BODIES block below is empty. Fill it from query C of
-- supabase/queries/function_bodies.sql before running this file, because
-- dropping the functions is the moment that text stops being recoverable.
--
-- Read those bodies first for one thing in particular: whether any of the
-- three does something BESIDES refusing the insert. If one also stamps a
-- column, writes an audit row, or validates something unrelated to plans, then
-- dropping it removes behaviour we still want and that function needs editing
-- rather than dropping. Nothing below assumes that; check before trusting it.

-- ═══════════════════════════════════════════════════════════════════════════
-- ORIGINAL BODIES — paste query C's output here before running.
--
--   enforce_trade_limit       (trg_enforce_trade_limit      ON public.trade_plans)
--   enforce_rules_limit       (trg_enforce_rules_limit      ON public.custom_rules)
--   enforce_strategies_limit  (trg_enforce_strategies_limit ON public.personal_strategies)
--
-- [ paste here ]
--
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

-- get_user_tier is deliberately NOT dropped here.
--
-- It is almost certainly what the three functions above called to decide which
-- cap to apply, which would make it dead the moment they are gone. But "almost
-- certainly" is how the last two surprises started. Query D of
-- function_bodies.sql lists every function, policy, column default and CHECK
-- that references it, plus who may EXECUTE it over PostgREST. If D comes back
-- empty on all five parts, dropping it is a one-line migration; if it does
-- not, it is load-bearing and stays. Either way that is its own decision, not
-- a side effect of this one.
--
-- rls_auto_enable is likewise untouched. If it is wired as an event trigger it
-- is infrastructure that has been silently shaping every migration we have
-- ever run, and it must be understood before anything is done to it.


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
  AND p.proname IN ('enforce_trade_limit', 'enforce_rules_limit', 'enforce_strategies_limit');

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
--   * Nine RLS policies granted TO public rather than TO authenticated —
--     handled deliberately in 023, not here.
--   * notebook_pages, rule_violations and setups are read and written by the
--     app but no migration in this directory creates them. `setups` is only
--     ever ALTERed (019). These migrations cannot rebuild the database.
--   * get_user_tier and rls_auto_enable, per the notes above.

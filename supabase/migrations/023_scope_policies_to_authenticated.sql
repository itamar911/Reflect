-- 023 — scope the hand-made RLS policies to `authenticated`
--
-- Nine policies in `public` are granted TO public rather than TO authenticated.
-- All nine were created by hand in the dashboard; none appears in any migration
-- in this directory. Found by supabase/queries/schema_drift.sql.
--
-- Deliberately a migration of its own rather than part of 022. 022 is a pricing
-- change; this is the same class of problem as the setup-images policy closed
-- in 018, and it should be reviewed and reverted on its own terms.
--
-- ── What is and is not wrong here ──
--
-- This is defence in depth, not an open door. `public` in Postgres means every
-- role, including `anon` — but each of these nine carries `auth.uid() = user_id`,
-- and for an anonymous request auth.uid() is NULL, so the comparison evaluates
-- to NULL, which is not TRUE, so no row qualifies. An anonymous caller gets an
-- empty result, not somebody else's data.
--
-- So nothing is leaking today. What is missing is the second barrier. With
-- TO public, the expression is the only thing standing between anon and the
-- table: any future policy added to one of these tables with a weaker
-- expression, any refactor that makes auth.uid() return something unexpected,
-- any `USING (true)` written in a hurry, and there is nothing behind it. With
-- TO authenticated, the role check fails first and the expression never has to
-- be right. 018 is the precedent — that policy's expression WAS the hole.
--
-- ── Why ALTER rather than DROP and recreate ──
--
-- ALTER POLICY ... TO changes only the role list and leaves USING and
-- WITH CHECK exactly as they are. Recreating them would mean retyping
-- expressions this file would then have to be trusted to have copied
-- correctly, and a window between the DROP and the CREATE in which the table
-- has no policy at all.
--
-- ── What this does not affect ──
--
--   * service_role — it bypasses RLS entirely, so the nightly cron, the
--     account-deletion route, the Tradovate helpers and logAiUsage are all
--     unaffected by any policy change.
--   * Demo mode — src/lib/demo/demoDb.ts is a fixture-backed stand-in for the
--     PostgREST query builder and never opens a connection, so /demo/* cannot
--     be broken by a policy at all.
--   * The two storage.objects policies found alongside these nine
--     (setup_images_insert, setup_images_delete) are already TO authenticated
--     and are left alone.
--
-- Rollback: swap `authenticated` for `public` in each statement below. No data
-- is touched and no expression is rewritten, so it is exact and immediate.

-- Tables the repo does create. These four also carry a repo-created policy that
-- appears to grant the same access (see the note at the foot) — scoping them
-- here is still correct, and independent of whether the duplicate is removed.
ALTER POLICY "insights_user_policy"           ON public.ai_insights      TO authenticated;
ALTER POLICY "Users manage own rules"         ON public.custom_rules     TO authenticated;
ALTER POLICY "streaks_user_policy"            ON public.streaks          TO authenticated;
ALTER POLICY "Users can manage their own"     ON public.weekly_summaries TO authenticated;

-- Tables the repo does NOT create. On these, the policy below is the only one
-- there is, so it is the whole of the access control for that table.
ALTER POLICY "notebook_pages_owner"           ON public.notebook_pages   TO authenticated;
ALTER POLICY "setups_owner"                   ON public.setups           TO authenticated;
ALTER POLICY "Users insert own violations"    ON public.rule_violations  TO authenticated;
ALTER POLICY "Users read own violations"      ON public.rule_violations  TO authenticated;
ALTER POLICY "Users update own violations"    ON public.rule_violations  TO authenticated;


-- ── Verification ──

-- 1. Every policy in public is now scoped. Expect zero rows.
SELECT schemaname, tablename, policyname, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND 'public' = ANY (roles);

-- 2. The expressions are untouched — compare against what schema_drift.sql
--    query 4 printed before this ran. Every qual should still be the same
--    auth.uid() = user_id it was.
SELECT tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname IN (
    'insights_user_policy', 'Users manage own rules', 'streaks_user_policy',
    'Users can manage their own', 'notebook_pages_owner', 'setups_owner',
    'Users insert own violations', 'Users read own violations',
    'Users update own violations'
  )
ORDER BY tablename, policyname;

-- 3. Behavioural: signed in, the app should work exactly as before —
--    dashboard, rules, strategies, setups, notebook, and a trade submit that
--    writes a rule_violations row. Nothing should change for a logged-in user.
--    That is the point: this removes reachability for a role that was already
--    getting zero rows.


-- ── Follow-up, not done here ──
--
-- Four of the nine duplicate a policy the repo already creates:
--
--   ai_insights       insights_user_policy       vs  "Users can manage own insights"
--   custom_rules      "Users manage own rules"   vs  "Users can manage own custom rules"
--   streaks           streaks_user_policy        vs  "Users can manage own streaks"
--   weekly_summaries  "Users can manage their own" vs "Users can manage own weekly summaries"
--
-- Multiple permissive policies are OR-ed, so a redundant pair grants no more
-- than either alone — but it does mean two places to get right, and one of
-- them is invisible to this repo. Dropping the hand-made copy is the tidier
-- end state, and is left out of this file because dropping a policy is not
-- reversible by editing one word, and because it should be done only after
-- confirming the two really are equivalent:
--
--   SELECT tablename, policyname, cmd, roles, qual, with_check
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND tablename IN ('ai_insights', 'custom_rules', 'streaks', 'weekly_summaries')
--   ORDER BY tablename, policyname;
--
-- If each pair matches on cmd, qual and with_check, a 024 can drop the
-- hand-made one. If they differ, the difference is itself a finding.

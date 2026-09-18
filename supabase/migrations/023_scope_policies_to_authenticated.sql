-- 023 — scope every RLS policy in `public` to `authenticated`
--
-- Deliberately a migration of its own rather than part of 022. 022 is a pricing
-- change; this is the same class of problem as the setup-images policy closed
-- in 018, and it should be reviewed and reverted on its own terms.
--
-- ── This is wider than the nine hand-made policies ──
--
-- The drift sweep found nine policies granted TO public that no migration
-- created. But the sweep filtered OUT the policies the repo does create, so it
-- never showed their roles — and almost none of them name a role either.
-- `CREATE POLICY ... FOR ALL USING (...)` with no TO clause defaults to PUBLIC,
-- which is how every policy in schema.sql and in migrations 001, 002, 004 and
-- 015 was written. Only 017 and 018 say TO authenticated.
--
-- So the split between "ours" and "hand-made" is irrelevant to this problem:
-- roughly two dozen policies are TO public and the cause is the same default in
-- both cases. This file fixes all of them.
--
-- ── What is and is not wrong here ──
--
-- This is defence in depth, not an open door. `public` in Postgres means every
-- role, including `anon` — but these policies carry `auth.uid() = user_id`
-- (or `= id` on profiles), and for an anonymous request auth.uid() is NULL, so
-- the comparison evaluates to NULL, which is not TRUE, so no row qualifies. An
-- anonymous caller gets an empty result, not somebody else's data.
--
-- Nothing is leaking today. What is missing is the second barrier. With
-- TO public the expression is the only thing standing between anon and the
-- table: any future policy with a weaker expression, any refactor that changes
-- what auth.uid() returns, any `USING (true)` written in a hurry, and there is
-- nothing behind it. With TO authenticated the role check fails first and the
-- expression never has to be right. 018 is the precedent — there the
-- expression itself WAS the hole.
--
-- ── Why a loop rather than a list of ALTER statements ──
--
-- A list would have to be kept in step with every policy that exists, and the
-- reason this migration exists is that we were wrong about which policies
-- exist. The loop fixes whatever is actually there, including policies neither
-- of us has seen.
--
-- It also makes this correct on a fresh project: run in order, 023 comes after
-- schema.sql and every earlier migration, so it catches their policies too. A
-- rebuild ends up scoped without those files needing to be rewritten.
--
-- ALTER POLICY changes only the role list. USING and WITH CHECK are untouched,
-- so no expression is retyped and there is no window where a table has no
-- policy on it.
--
-- ── Checked before writing this ──
--
--   * service_role bypasses RLS entirely, so the nightly cron, account
--     deletion, the Tradovate helpers and logAiUsage are unaffected.
--   * Demo mode cannot break: src/lib/demo/demoDb.ts is a fixture-backed
--     stand-in for the query builder and never opens a connection.
--   * Signup cannot break. The only thing that writes `profiles` is the
--     handle_new_user trigger, which is SECURITY DEFINER and owned by the
--     table owner, so it is not subject to these policies at all. Nothing in
--     src/ inserts a profile row — `grep -rn "from('profiles')" src/` has no
--     insert or upsert — so no anonymous caller relies on the profiles INSERT
--     policy during the window before a session exists.
--
-- Rollback: the same loop with `public` in place of `authenticated`. No data is
-- touched and no expression is rewritten, so it is exact and immediate.

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND 'public' = ANY (roles)
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON %I.%I TO authenticated',
      pol.policyname, pol.schemaname, pol.tablename
    );
    RAISE LOG 'scoped policy % on %.% to authenticated',
      pol.policyname, pol.schemaname, pol.tablename;
  END LOOP;
END
$$;

-- storage.objects is left alone. setup_images_select (018), setup_images_insert
-- and setup_images_delete are already TO authenticated, and the rest of that
-- schema is Supabase's.


-- ── Verification ──

-- 1. No policy in public is granted to PUBLIC. Expect zero rows.
SELECT schemaname, tablename, policyname, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND 'public' = ANY (roles);

-- 2. Every policy is still there, with its expression intact. Compare the qual
--    column against what schema_drift.sql query 4 printed before this ran —
--    every one should still be the same auth.uid() comparison it was, and only
--    `roles` should have changed.
SELECT tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- 3. Behavioural: signed in, the app should work exactly as before —
--    dashboard, rules, strategies, setups, notebook, and a trade submit that
--    writes a rule_violations row. Nothing should change for a logged-in user.
--    That is the point: this removes reachability for a role that was already
--    getting zero rows.


-- ── The rule this leaves behind ──
--
-- Every CREATE POLICY from now on must name its role explicitly:
--
--   CREATE POLICY foo ON public.bar FOR ALL TO authenticated USING (...);
--
-- Omitting TO does not mean "no roles", it means PUBLIC. That is the entire
-- cause of this migration.


-- ── Follow-up, not done here ──
--
-- Four hand-made policies duplicate one the repo creates:
--
--   ai_insights       insights_user_policy         vs  "Users can manage own insights"
--   custom_rules      "Users manage own rules"     vs  "Users can manage own custom rules"
--   streaks           streaks_user_policy          vs  "Users can manage own streaks"
--   weekly_summaries  "Users can manage their own" vs  "Users can manage own weekly summaries"
--
-- Multiple permissive policies are OR-ed, so a redundant pair grants no more
-- than either alone — but it is two places to get right, one of them invisible
-- to this repo. Dropping the hand-made copy is the tidier end state and is left
-- out of this file because dropping a policy is not reversible by editing one
-- word. Run supabase/queries/policy_compare.sql first: it prints a verdict per
-- pair and the two expressions side by side.

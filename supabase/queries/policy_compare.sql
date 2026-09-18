-- Are the four duplicated policies actually identical?
--
-- Run in the Supabase SQL editor, AFTER 023. Read-only.
--
-- Four hand-made policies sit alongside one the repo creates, on the same table
-- and apparently granting the same access. Permissive policies are OR-ed, so a
-- redundant pair grants no more than either alone — but it is two places to get
-- right, one of them invisible to this repo, so the duplicate should go.
--
-- It should only go once we know the two really are the same. Two policies that
-- look identical and are not is a worse state than two that obviously differ,
-- because the drop would silently remove access somebody depends on.
--
-- ── Why comparing the text is meaningful here ──
--
-- pg_policies.qual and .with_check are not the source text anyone typed — they
-- are Postgres deparsing the stored parse tree. Two policies written
-- differently but meaning the same thing come out byte-identical; two that
-- differ in any way that matters come out different. So an exact string
-- comparison on these columns is a real equivalence check, not a formatting
-- one. Expect fully-qualified output like `(auth.uid() = user_id)`.

WITH pairs(tbl, hand_made, from_repo) AS (
  VALUES
    ('ai_insights',      'insights_user_policy',         'Users can manage own insights'),
    ('custom_rules',     'Users manage own rules',       'Users can manage own custom rules'),
    ('streaks',          'streaks_user_policy',          'Users can manage own streaks'),
    ('weekly_summaries', 'Users can manage their own',   'Users can manage own weekly summaries')
)
SELECT
  p.tbl AS table_name,

  CASE
    WHEN h.policyname IS NULL THEN 'HAND-MADE POLICY NOT FOUND'
    WHEN r.policyname IS NULL THEN 'REPO POLICY NOT FOUND'
    WHEN h.cmd        IS DISTINCT FROM r.cmd        THEN 'DIFFERS: cmd'
    WHEN h.permissive IS DISTINCT FROM r.permissive THEN 'DIFFERS: permissive/restrictive'
    WHEN h.roles::text IS DISTINCT FROM r.roles::text THEN 'DIFFERS: roles'
    WHEN h.qual       IS DISTINCT FROM r.qual       THEN 'DIFFERS: USING'
    WHEN h.with_check IS DISTINCT FROM r.with_check THEN 'DIFFERS: WITH CHECK'
    ELSE 'IDENTICAL — safe to drop the hand-made one'
  END AS verdict,

  p.hand_made, p.from_repo,
  h.cmd        AS hand_cmd,        r.cmd        AS repo_cmd,
  h.permissive AS hand_permissive, r.permissive AS repo_permissive,
  h.roles      AS hand_roles,      r.roles      AS repo_roles,
  h.qual       AS hand_using,      r.qual       AS repo_using,
  h.with_check AS hand_check,      r.with_check AS repo_check
FROM pairs p
LEFT JOIN pg_policies h
  ON h.schemaname = 'public' AND h.tablename = p.tbl AND h.policyname = p.hand_made
LEFT JOIN pg_policies r
  ON r.schemaname = 'public' AND r.tablename = p.tbl AND r.policyname = p.from_repo
ORDER BY p.tbl;


-- ── Reading the result ──
--
-- IDENTICAL on all four            -> a 026 dropping the four hand-made copies
--                                     is safe and purely a tidy-up.
--
-- DIFFERS: USING or WITH CHECK     -> do NOT drop. The two expressions are in
--                                     the columns above, side by side. One of
--                                     them is granting access the other does
--                                     not, and which one is correct is a real
--                                     question, not a cleanup.
--
-- DIFFERS: cmd                     -> one covers ALL and the other a single
--                                     command. Dropping the broader one
--                                     removes access.
--
-- DIFFERS: permissive              -> a RESTRICTIVE policy ANDs rather than
--                                     ORs. Dropping it would LOOSEN access,
--                                     which is the opposite of a tidy-up and
--                                     needs its own think.
--
-- DIFFERS: roles                   -> only possible if 023 has not run yet, or
--                                     did not cover one of them. Re-run 023.
--
-- NOT FOUND on either side         -> the name in this file is wrong. Get the
--                                     real one from schema_drift.sql query 4.
--
-- Anything other than four IDENTICALs: paste the row back rather than acting
-- on it. The expressions are in the output, so the difference can be read
-- directly.


-- ===========================================================================
-- WHEN THE VERDICT IS "REPO POLICY NOT FOUND"
-- ===========================================================================
-- All four pairs came back that way: the repo's policy does not exist on any of
-- the four tables. There is one policy per table and it is the hand-made one.
-- So there are no duplicates and nothing to drop.
--
-- What the repo settles on its own, without asking the database:
--
--   * The four are declared in THREE different files — schema.sql (custom_rules
--     and weekly_summaries), 001 (insights and streaks) and 015 (custom_rules
--     again, after its DROP TABLE ... CASCADE). One failed migration cannot
--     explain all four.
--
--   * A pre-existing hand-made policy could NOT have made the repo's
--     CREATE POLICY fail. Postgres rejects a duplicate policy name only on the
--     SAME table; policies with different names coexist, and a table may carry
--     as many as you like. insights_user_policy existing would not have blocked
--     "Users can manage own insights" from being created beside it. That
--     mechanism is ruled out rather than unlikely.
--
--   * For custom_rules, 015 drops the table CASCADE — which takes its policies
--     with it — recreates it, enables RLS, then creates the policy. The table
--     exists with 015's structured columns (condition_type, threshold_value,
--     action_type), which the app depends on, so 015's CREATE TABLE certainly
--     ran. Either 015 stopped somewhere between that and its last statement, or
--     the policy it created was removed afterwards.
--
-- What is left is: the repo's policies were created and later replaced, or they
-- were never created and someone added their own when RLS locked the table.
-- Postgres records neither event. The queries below are the closest thing to
-- evidence that exists.


-- ---------------------------------------------------------------------------
-- F1. Chronology by OID.
-- ---------------------------------------------------------------------------
-- OIDs come from a cluster-wide counter, so on a database this size relative
-- order is reliable: a higher OID was created later. Interleaving tables and
-- policies reconstructs roughly what happened when.
--
-- How to read it:
--
--   Hand-made policies clustered AFTER every table, and after the repo
--   policies that did survive (profiles, preset_rules, trade_plans) ->
--   the schema was built first and these were added later, which means the
--   repo's four were created and then replaced.
--
--   Each hand-made policy sitting immediately after its own table, interleaved
--   with the rest of the schema -> it was created at the same time as the
--   table, meaning the repo's policy statement never ran at all and someone
--   wrote one by hand there and then.
--
--   The four hand-made policies clustered together but far apart in OID from
--   each other -> four separate occasions, which fits the two different naming
--   styles (insights_user_policy / streaks_user_policy vs "Users manage own
--   rules" / "Users can manage their own").

SELECT 'policy' AS kind, pol.oid AS oid, c.relname AS on_table, pol.polname AS name
FROM pg_policy pol
JOIN pg_class c     ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
UNION ALL
SELECT 'table', c.oid, c.relname, c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY oid;


-- ---------------------------------------------------------------------------
-- F2. Is there a migration ledger anyone forgot about?
-- ---------------------------------------------------------------------------
-- The Supabase CLI records applied migrations in
-- supabase_migrations.schema_migrations. Everything here has been run by hand,
-- so this should not exist — but if it does, it is a dated list of what was
-- applied and it settles the question outright rather than by inference.

SELECT n.nspname AS schema, c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'supabase_migrations';

-- If the above returns a row:
--   SELECT * FROM supabase_migrations.schema_migrations ORDER BY version;


-- ---------------------------------------------------------------------------
-- F3. What the hand-made four actually say.
-- ---------------------------------------------------------------------------
-- Needed regardless of how they got there, because whatever they contain is now
-- the access control for those tables and it has to go into the repo. Run after
-- 023, so the roles are already normalised, and paste the output back: this
-- becomes the CREATE POLICY statements in the migration that codifies them.

SELECT
  tablename,
  'CREATE POLICY ' || quote_ident(policyname)
    || ' ON public.' || quote_ident(tablename)
    || ' FOR ' || cmd
    || ' TO ' || array_to_string(roles, ', ')
    || COALESCE(' USING (' || qual || ')', '')
    || COALESCE(' WITH CHECK (' || with_check || ')', '')
    || ';' AS policy_ddl
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('ai_insights', 'custom_rules', 'streaks', 'weekly_summaries')
ORDER BY tablename, policyname;

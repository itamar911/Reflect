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

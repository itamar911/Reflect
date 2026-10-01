-- Standing security assertions. Run in the Supabase SQL Editor.
--
-- READ-ONLY. Nothing here changes anything: no DDL, no DML, no function
-- creation. Paste the whole file and read the results, or run one block.
--
--
-- WHY THESE ARE ASSERTIONS AND NOT A SNAPSHOT COMPARISON
-- -----------------------------------------------------
--
-- The setup-images hole was a policy written without TO and without a folder
-- restriction, sitting directly beside a correctly hardened one in the SAME
-- migration file, correctly recorded in the ledger, correctly applied. There
-- was no drift. A schema snapshot, a migration CLI and a baseline reset would
-- all have reported everything fine, because nothing had moved — the thing that
-- was written down was itself wrong.
--
-- So nothing below compares production to a baseline. Each query encodes a
-- judgement about what is WRONG and returns rows when production matches it.
-- EVERY QUERY'S HEALTHY RESULT IS ZERO ROWS.
--
--
-- WHY THE CATALOG AND NOT information_schema
-- ------------------------------------------
--
-- information_schema filters by the privileges of the calling role. A query
-- whose healthy answer is "no rows" can come back empty because the row was
-- filtered out, not because it was absent — the two are indistinguishable, and
-- the one that means "you are safe" is the one you will assume. We hit exactly
-- that ambiguity on 22 Sep. pg_class, pg_policy, pg_proc and aclexplode do no
-- such filtering, so empty means empty.
--
--
-- SCOPE
-- -----
--
-- Invariants only. Nothing here lists the tables, buckets or functions that are
-- expected to exist, so a new table, bucket or function never makes a query
-- fire on its own and there is no list to keep in step with the migrations.
-- Every rule below is meant to hold for this application forever.
--
-- Schemas: public and storage. storage holds objects and buckets and is as much
-- a part of the attack surface as public — the hole that started this was in
-- storage.objects.
--
--
-- RELATIONSHIP TO THE CRON
-- ------------------------
--
-- src/app/api/cron/security-assertions/route.ts runs the same rules once a day
-- and emails on any finding. This file is the readable twin: it is what to run
-- when you want to look right now, and it is what makes the logic reviewable
-- without reading TypeScript.
--
-- The route can run queries 8 and 9 today, through the Storage API. It CANNOT
-- run 1-7: PostgREST exposes only the `public` schema, so there is no way for
-- the service-role key to reach pg_catalog over HTTP. Closing that gap needs a
-- SECURITY DEFINER function in `public` that returns (rule text, object text)
-- and is callable by the service role — creating it is DDL and deliberately out
-- of scope here. Until it exists the route reports the catalog checks as
-- UNAVAILABLE rather than as clean, and this file is the only way to run 1-7.
--
--
-- WHAT THE RESULTS MAY AND MAY NOT BE PASTED INTO
-- -----------------------------------------------
--
-- Each query returns the object's name and the rule it broke, and deliberately
-- not the policy expression, the privilege list, or any bucket column beyond
-- the name. A list of where the weaknesses are is a map; a list of exactly how
-- each one is shaped is an exploitation guide. Widen a SELECT locally while you
-- are triaging if you need the detail — just do not mail the result.


-- ===========================================================================
-- 1. A table with RLS disabled.
--
-- EXPECTED: zero rows.
--
-- The `ensure_rls` event trigger turns RLS on for every table created in
-- public, so a row here means either the trigger was dropped, or the table was
-- created in storage where the trigger does not reach, or RLS was switched off
-- by hand afterwards.
-- ===========================================================================
SELECT
  n.nspname                      AS schema_name,
  c.relname                      AS object_name,
  'rls.disabled'                 AS rule_broken
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'storage')
  AND c.relkind IN ('r', 'p')          -- ordinary and partitioned tables
  AND NOT c.relrowsecurity
ORDER BY 1, 2;


-- ===========================================================================
-- 2. A table with RLS enabled and zero policies.
--
-- EXPECTED: zero rows.
--
-- RLS with no policy denies everything, which reads as "safe" and is usually a
-- half-finished migration: the ALTER TABLE landed and the CREATE POLICY did
-- not. It is listed as a weakness rather than a win because the next person to
-- notice the table is broken will fix it by adding a permissive policy in a
-- hurry.
-- ===========================================================================
SELECT
  n.nspname                      AS schema_name,
  c.relname                      AS object_name,
  'rls.no_policies'              AS rule_broken
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'storage')
  AND c.relkind IN ('r', 'p')
  AND c.relrowsecurity
  AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
ORDER BY 1, 2;


-- ===========================================================================
-- 3. A policy whose roles include public or anon.
--
-- EXPECTED: zero rows.
--
-- A policy written without a TO clause applies to PUBLIC, which is every role.
-- pg_policy.polroles holds OID 0 for PUBLIC, and that is what this matches —
-- the omission is invisible in the CREATE POLICY text, which is precisely how
-- the setup-images policy passed review sitting next to a correct one.
--
-- anon is matched separately: writing TO anon is explicit rather than an
-- omission, but the result is a policy an unauthenticated caller can use.
-- ===========================================================================
SELECT
  n.nspname                      AS schema_name,
  c.relname || '.' || p.polname  AS object_name,
  CASE
    WHEN 0 = ANY (p.polroles) THEN 'policy.role_public'
    ELSE 'policy.role_anon'
  END                            AS rule_broken
FROM pg_policy p
JOIN pg_class c     ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'storage')
  AND (
    0 = ANY (p.polroles)
    OR EXISTS (
      SELECT 1 FROM pg_roles r
      WHERE r.oid = ANY (p.polroles) AND r.rolname = 'anon'
    )
  )
ORDER BY 1, 2;


-- ===========================================================================
-- 4. A policy whose USING or WITH CHECK is literally true.
--
-- EXPECTED: zero rows.
--
-- `USING (true)` is a policy that exists and filters nothing. Combined with
-- rule 3 it is the shape of the original hole. The clause is named but the
-- expression is never returned — see the header.
-- ===========================================================================
SELECT
  n.nspname                      AS schema_name,
  c.relname || '.' || p.polname  AS object_name,
  CASE
    WHEN pg_get_expr(p.polqual, p.polrelid) = 'true' THEN 'policy.using_true'
    ELSE 'policy.with_check_true'
  END                            AS rule_broken
FROM pg_policy p
JOIN pg_class c     ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'storage')
  AND (
    pg_get_expr(p.polqual, p.polrelid) = 'true'
    OR pg_get_expr(p.polwithcheck, p.polrelid) = 'true'
  )
ORDER BY 1, 2;


-- ===========================================================================
-- 5. A function with EXECUTE granted to PUBLIC.
--
-- EXPECTED: zero rows.
--
-- NOTE THE COALESCE, it is the whole point of this query. A function whose
-- proacl is NULL has never had its privileges touched, and Postgres's DEFAULT
-- for a function is EXECUTE TO PUBLIC. Reading proacl alone would return
-- nothing for exactly the functions nobody has locked down — the dangerous
-- case would be the silent one. acldefault('f', proowner) materialises that
-- implicit default so it can be matched like any other grant.
--
-- This is what 024 and 027 were cleaning up; this query is what stops it coming
-- back on the next function somebody creates in the dashboard.
-- ===========================================================================
SELECT DISTINCT
  n.nspname                      AS schema_name,
  p.oid::regprocedure::text      AS object_name,
  'function.execute_to_public'   AS rule_broken
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
WHERE n.nspname IN ('public', 'storage')
  AND a.grantee = 0                    -- OID 0 is PUBLIC
  AND a.privilege_type = 'EXECUTE'
ORDER BY 1, 2;


-- ===========================================================================
-- 6. A table-level grant of any privilege to anon or authenticated.
--
-- EXPECTED: SEE THE NOTE — this one is not zero rows today.
--
-- This is the check that catches a blanket `GRANT ALL ON t TO authenticated`
-- quietly overriding a careful column-level grant: a table-level grant covers
-- every column, including ones deliberately left out of a column grant, and it
-- is invisible next to the column grant in any listing that only reads
-- attribute ACLs.
--
-- The COALESCE matters here for the same reason as in query 5: a relacl of NULL
-- means untouched, and Supabase's default privileges grant ALL on new public
-- tables to anon and authenticated.
--
-- WHY IT WILL RETURN MANY ROWS: that default is also how the application works
-- at all. The browser talks to Postgres as `authenticated` and needs table
-- privileges on trade_plans, profiles, setups and the rest; RLS is what scopes
-- them to the user's own rows. So this query currently reports most of public.
--
-- Read it as an inventory, not an alarm: the question it answers is "which
-- tables are reachable by a client role at the table level", and the row to
-- look for is a table you believed was column-granted or server-only.
-- tradovate_connections is the one table that should NEVER appear here (017
-- revokes from both roles and grants named columns instead); if it does, a
-- blanket grant has overridden that and the token columns are readable.
--
-- Privileges are deliberately not listed — see the header.
-- ===========================================================================
SELECT DISTINCT
  n.nspname                      AS schema_name,
  c.relname                      AS object_name,
  'grant.table_to_' || r.rolname AS rule_broken
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname IN ('public', 'storage')
  AND c.relkind IN ('r', 'p', 'v', 'm')
  AND r.rolname IN ('anon', 'authenticated')
ORDER BY 1, 2, 3;


-- ===========================================================================
-- 7. A column grant on a secret-looking column, to anon or authenticated.
--
-- EXPECTED: zero rows.
--
-- Matches the column NAME, not a list of known columns, so a token column added
-- next year is covered the day it is created.
--
-- This reads pg_attribute.attacl, which holds ONLY column-level grants. A
-- secret column on a table carrying a table-level grant has a NULL attacl and
-- will not appear here — query 6 is what covers that case. The two are
-- complements and neither replaces the other.
-- ===========================================================================
SELECT DISTINCT
  n.nspname                                      AS schema_name,
  c.relname || '.' || att.attname                AS object_name,
  'grant.secret_column_to_' || r.rolname         AS rule_broken
FROM pg_attribute att
JOIN pg_class c     ON c.oid = att.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(att.attacl) a
JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname IN ('public', 'storage')
  AND att.attnum > 0
  AND NOT att.attisdropped
  AND att.attacl IS NOT NULL
  AND r.rolname IN ('anon', 'authenticated')
  AND att.attname ~* '(token|secret|key|password)'
ORDER BY 1, 2, 3;


-- ===========================================================================
-- 8. A storage bucket that is public.
--
-- EXPECTED: zero rows.
--
-- Absolute, with no exceptions. Verified on 1 Oct: the only bucket is
-- setup-images and it is private (020 made it so). A public bucket serves every
-- object in it to anyone with the URL, with no RLS and no signed-URL expiry —
-- there is no configuration of this application in which that is correct.
-- ===========================================================================
SELECT
  'storage'      AS schema_name,
  b.id           AS object_name,
  'bucket.public' AS rule_broken
FROM storage.buckets b
WHERE b.public IS TRUE
ORDER BY 2;


-- ===========================================================================
-- 9. A storage bucket with no size cap or no MIME allowlist.
--
-- EXPECTED: TWO ROWS TODAY, both for setup-images, and that is correct.
--
-- Both columns are NULL on setup-images as of 1 Oct. A bucket with neither
-- accepts a file of any type and any size from any caller the policies let
-- through — the upload path is authenticated, but "authenticated" is anyone who
-- signed up, and nothing stops one of them storing a 2 GB file, or an HTML file
-- that will be served back from the project's own origin.
--
-- Reported, not fixed. Setting either column is DML on storage.buckets and is a
-- decision about product limits, not a mechanical repair.
-- ===========================================================================
-- Two rules, not one, so a bucket missing both is two findings and a bucket
-- missing one is unambiguous about which.
SELECT
  'storage'              AS schema_name,
  b.id                   AS object_name,
  'bucket.no_size_limit' AS rule_broken
FROM storage.buckets b
WHERE b.file_size_limit IS NULL
UNION ALL
SELECT
  'storage',
  b.id,
  'bucket.no_mime_allowlist'
FROM storage.buckets b
WHERE b.allowed_mime_types IS NULL
ORDER BY 2, 3;


-- ===========================================================================
-- ALL OF THE ABOVE, AS ONE RESULT SET
--
-- EXPECTED: only the query-6 inventory rows and the two query-9 rows.
--
-- Same rules, same output columns, unioned — this is the shape the cron route
-- reports, and running it is the fastest way to see whether anything new has
-- appeared since the last look. Query 6 is included; it is the noisy one, so
-- filter it out with `WHERE rule_broken NOT LIKE 'grant.table_to_%'` when you
-- want only the rules whose healthy answer is zero rows.
-- ===========================================================================
WITH findings AS (
  SELECT n.nspname, c.relname, 'rls.disabled' AS rule_broken
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public','storage') AND c.relkind IN ('r','p') AND NOT c.relrowsecurity

  UNION ALL
  SELECT n.nspname, c.relname, 'rls.no_policies'
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public','storage') AND c.relkind IN ('r','p') AND c.relrowsecurity
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)

  UNION ALL
  SELECT n.nspname, c.relname || '.' || p.polname,
         CASE WHEN 0 = ANY (p.polroles) THEN 'policy.role_public' ELSE 'policy.role_anon' END
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public','storage')
    AND (0 = ANY (p.polroles)
         OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid = ANY (p.polroles) AND r.rolname = 'anon'))

  UNION ALL
  SELECT n.nspname, c.relname || '.' || p.polname,
         CASE WHEN pg_get_expr(p.polqual, p.polrelid) = 'true'
              THEN 'policy.using_true' ELSE 'policy.with_check_true' END
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public','storage')
    AND (pg_get_expr(p.polqual, p.polrelid) = 'true'
         OR pg_get_expr(p.polwithcheck, p.polrelid) = 'true')

  UNION ALL
  SELECT DISTINCT n.nspname, p.oid::regprocedure::text, 'function.execute_to_public'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
  WHERE n.nspname IN ('public','storage') AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'

  UNION ALL
  SELECT DISTINCT n.nspname, c.relname, 'grant.table_to_' || r.rolname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname IN ('public','storage') AND c.relkind IN ('r','p','v','m')
    AND r.rolname IN ('anon','authenticated')

  UNION ALL
  SELECT DISTINCT n.nspname, c.relname || '.' || att.attname,
         'grant.secret_column_to_' || r.rolname
  FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname IN ('public','storage') AND att.attnum > 0 AND NOT att.attisdropped
    AND att.attacl IS NOT NULL AND r.rolname IN ('anon','authenticated')
    AND att.attname ~* '(token|secret|key|password)'

  UNION ALL
  SELECT 'storage', b.id, 'bucket.public' FROM storage.buckets b WHERE b.public IS TRUE

  UNION ALL
  SELECT 'storage', b.id, 'bucket.no_size_limit'
  FROM storage.buckets b WHERE b.file_size_limit IS NULL

  UNION ALL
  SELECT 'storage', b.id, 'bucket.no_mime_allowlist'
  FROM storage.buckets b WHERE b.allowed_mime_types IS NULL
)
SELECT nspname AS schema_name, relname AS object_name, rule_broken
FROM findings
ORDER BY rule_broken, schema_name, object_name;

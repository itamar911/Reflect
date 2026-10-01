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
-- Schemas: public and storage for the rules about things we write — policies,
-- grants, RLS. storage holds objects and buckets and is as much a part of the
-- attack surface as public; the hole that started this was in storage.objects,
-- and a policy or grant there is ours to get wrong.
--
-- Rules 2 and 5 are the exception and are scoped to public ALONE. Supabase owns
-- the rest of the storage schema: on the first production run rule 2 returned
-- storage.buckets, migrations, s3_multipart_uploads and vector_indexes, and rule
-- 5 returned about twenty storage.* functions and not one of ours. None of it is
-- under our control and none of it will ever be actionable, and a rule that
-- cannot be acted on trains you to skip the whole report.
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
-- The route runs queries 8 and 9 through the Storage API, and 1-7 through
-- public.security_assertions(), created by migration 031. PostgREST exposes only
-- the `public` schema, so without that function there is no path from the
-- service-role key to pg_catalog over HTTP at all.
--
-- UNTIL 031 IS APPLIED the route reports the catalog checks as UNAVAILABLE
-- rather than as clean, and this file is the only way to run 1-7.
--
-- 031 carries the same rules as 1-7 below, minus the 6c inventory. Change a rule
-- here and change it there in the same edit, or the daily mail and the hand-run
-- stop agreeing — which is worse than either being wrong alone.
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
--
--
-- WHAT IS MAILED AND WHAT IS ONLY HERE
-- ------------------------------------
--
-- Query 6c is an INVENTORY. It answers "which tables can a client role reach at
-- the table level", which is about forty rows and is the normal, correct state —
-- the browser talks to Postgres as `authenticated` and RLS is what scopes it. It
-- lives here and is never mailed; forty rows arriving daily is how a report stops
-- being read.
--
-- 6a and 6b are the alarms carved out of it. 6a is the override case: a
-- table-level grant on a table that ALSO carries column-level grants, which is a
-- blanket GRANT quietly widening a careful column grant. 6b is a never-list.


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
--
-- It caught one on the first run: public."my database - trading", an empty table
-- with id and created_at, created by accident in the dashboard and referenced
-- nowhere in src/. Dropped 1 Oct.
--
-- PUBLIC ONLY. storage.buckets, storage.migrations, s3_multipart_uploads and
-- vector_indexes are all RLS-on-no-policy and all Supabase's to manage.
-- ===========================================================================
SELECT
  n.nspname                      AS schema_name,
  c.relname                      AS object_name,
  'rls.no_policies'              AS rule_broken
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
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
--
-- PUBLIC ONLY. The first production run returned about twenty storage.* functions
-- and none of ours: Supabase ships them EXECUTE TO PUBLIC, they are not ours to
-- revoke, and leaving them in means our own next mistake arrives on page two.
-- ===========================================================================
SELECT DISTINCT
  n.nspname                      AS schema_name,
  p.oid::regprocedure::text      AS object_name,
  'function.execute_to_public'   AS rule_broken
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
WHERE n.nspname = 'public'
  AND a.grantee = 0                    -- OID 0 is PUBLIC
  AND a.privilege_type = 'EXECUTE'
ORDER BY 1, 2;


-- ===========================================================================
-- 6a. A table-level grant on a table that ALSO has column-level grants.
--
-- EXPECTED: zero rows. MAILED.
--
-- This is the override case, carved out of the inventory in 6c because it is
-- the part that is actually an alarm.
--
-- Column-level grants are how a table says "only these columns are
-- client-readable". A table-level grant covers EVERY column, including the ones
-- deliberately left out, so a blanket `GRANT ALL ON t TO authenticated` silently
-- widens a careful column grant to everything — and the two sit in different
-- catalogs (pg_class.relacl and pg_attribute.attacl), so neither is visible in a
-- listing of the other. Somebody reviewing the column grants sees exactly what
-- they expect while the table grant makes them irrelevant.
--
-- The presence of column grants is what makes a table-level grant suspicious:
-- it means someone went to the trouble of naming columns, and something later
-- made that pointless.
--
-- The COALESCE matters for the same reason as in query 5: a relacl of NULL means
-- untouched, and Supabase's default privileges grant ALL on new public tables to
-- anon and authenticated.
-- ===========================================================================
WITH table_granted AS (
  SELECT DISTINCT c.oid, n.nspname, c.relname, r.rolname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname IN ('public', 'storage')
    AND c.relkind IN ('r', 'p', 'v', 'm')
    AND r.rolname IN ('anon', 'authenticated')
),
column_granted AS (
  SELECT DISTINCT att.attrelid AS oid
  FROM pg_attribute att
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE att.attnum > 0
    AND NOT att.attisdropped
    AND att.attacl IS NOT NULL
    AND r.rolname IN ('anon', 'authenticated')
)
SELECT DISTINCT
  tg.nspname                                      AS schema_name,
  tg.relname                                      AS object_name,
  'grant.table_overrides_column_' || tg.rolname   AS rule_broken
FROM table_granted tg
WHERE EXISTS (SELECT 1 FROM column_granted cg WHERE cg.oid = tg.oid)
ORDER BY 1, 2, 3;


-- ===========================================================================
-- 6b. A table-level grant on a table that must never have one.
--
-- EXPECTED: zero rows. MAILED.
--
-- A never-list, and the one place in this file that names an object. That is a
-- deliberate exception to the invariants-only rule: it can only ever produce a
-- false NEGATIVE for a table nobody added to it, never a false positive, and it
-- never fires because something new exists. Adding a server-only table means
-- adding a line here in the same change.
--
-- tradovate_connections holds OAuth access and refresh tokens as ciphertext. 017
-- revokes from anon and authenticated and grants named non-secret columns
-- instead; 030 adds three more named columns and withholds api_hosts. A
-- table-level grant on it makes every one of those decisions void and the token
-- columns client-readable.
--
-- 6a would normally catch this too, since the table carries column grants. 6b
-- exists for the case 6a cannot see: someone who REVOKEs the column grants and
-- GRANTs the table in one go leaves no column grant behind, and 6a goes quiet
-- at exactly the moment the table became fully readable.
-- ===========================================================================
SELECT DISTINCT
  n.nspname                          AS schema_name,
  c.relname                          AS object_name,
  'grant.table_on_never_list'        AS rule_broken
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public'
  AND c.relname IN ('tradovate_connections')      -- the never-list
  AND r.rolname IN ('anon', 'authenticated')
ORDER BY 1, 2;


-- ===========================================================================
-- 6c. INVENTORY: every table-level grant to a client role.
--
-- EXPECTED: about forty rows, and that is the correct state. NOT MAILED.
--
-- This is not an alarm and the cron never sends it. The browser talks to
-- Postgres as `authenticated` and needs table privileges on trade_plans,
-- profiles, setups and the rest; RLS is what scopes them to the user's own rows.
-- Supabase's default privileges grant ALL on new public tables to both client
-- roles, so most of public appears here by design.
--
-- It stays in this file because the question it answers — "which tables can a
-- client role reach at the table level" — is worth asking by hand when you are
-- adding a table or wondering why something is visible. Mailed daily it would be
-- forty lines of noise wrapped around the handful of lines that matter, and the
-- whole report would stop being read.
--
-- Scan it for a table you believed was column-granted or server-only. 6a and 6b
-- are the two cases of that worth waking up for.
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
-- will not appear here — queries 6a and 6b are what cover that case. They are
-- complements and neither replaces the other.
--
-- ONE EXCLUSION, by exact name: token_type. 030 grants it to authenticated on
-- purpose and it holds "bearer" — the token TYPE, not a token. It is excluded by
-- full column name rather than by weakening the pattern, so `token`,
-- `access_token` and `refresh_token` all still fire, and so does a column called
-- token_type_secret. One name, matched whole.
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
  AND att.attname <> 'token_type'
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
-- EXPECTED: the two query-9 rows, and nothing else.
--
-- Same rules, same output columns, unioned — this is the shape the cron route
-- reports, and running it is the fastest way to see whether anything new has
-- appeared since the last look.
--
-- 6c, the inventory, is NOT in here. This block is the mailable set: every rule
-- in it has zero rows as its healthy answer, so any row at all is worth reading.
-- Run 6c on its own when you want the inventory.
-- ===========================================================================
WITH findings AS (
  SELECT n.nspname, c.relname, 'rls.disabled' AS rule_broken
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public','storage') AND c.relkind IN ('r','p') AND NOT c.relrowsecurity

  UNION ALL
  SELECT n.nspname, c.relname, 'rls.no_policies'
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relrowsecurity
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
  WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'

  -- 6a: table-level grant on a table that also carries column-level grants.
  UNION ALL
  SELECT DISTINCT n.nspname, c.relname, 'grant.table_overrides_column_' || r.rolname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname IN ('public','storage') AND c.relkind IN ('r','p','v','m')
    AND r.rolname IN ('anon','authenticated')
    AND EXISTS (
      SELECT 1 FROM pg_attribute att
      CROSS JOIN LATERAL aclexplode(att.attacl) ca
      JOIN pg_roles cr ON cr.oid = ca.grantee
      WHERE att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
        AND att.attacl IS NOT NULL
        AND cr.rolname IN ('anon','authenticated')
    )

  -- 6b: the never-list.
  UNION ALL
  SELECT DISTINCT n.nspname, c.relname, 'grant.table_on_never_list'
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
  JOIN pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public' AND c.relname IN ('tradovate_connections')
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
    AND att.attname <> 'token_type'

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

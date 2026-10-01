-- public.security_assertions() — rules 1-7 of the standing security assertions,
-- reachable over PostgREST so the daily cron can run them.
--
-- NUMBERING: 030 is applied. 028 is written but not yet applied and 029 is
-- reserved for rule_violations and setup_images_delete (Linear REF-89), so 031
-- is the next number that is neither taken nor reserved.
--
-- RUN THIS BY HAND in the Supabase SQL Editor. Nothing in the repo applies
-- migrations. Run the VERIFICATION block at the bottom immediately afterwards.
--
-- PostgREST caches the schema. Supabase normally reloads it on DDL within a few
-- seconds; if the cron still reports the catalog checks as unavailable with a
-- "could not find the function" message several minutes after applying this, run
--   NOTIFY pgrst, 'reload schema';
-- and try again. That is a cache problem, not a grant problem — the VERIFICATION
-- block below is what tells you the grants are right.
--
--
-- WHY IT EXISTS
-- -------------
--
-- supabase/queries/security_assertions.sql holds nine rules. The cron route can
-- run two of them — the storage bucket checks, through the Storage API — and
-- cannot run the other seven, because PostgREST exposes only the `public` schema
-- and there is no path from the service-role key to pg_catalog over HTTP. The
-- seven are the whole point: they are the rules that would have caught the
-- setup-images policy.
--
-- This function is that path. It is the only new object, it reads nothing but
-- the catalog, and it returns the same three columns the SQL file's final union
-- already produces.
--
--
-- WHY THE HARDENING BELOW IS NOT OPTIONAL
-- ---------------------------------------
--
-- A SECURITY DEFINER function runs as its owner. One with a mutable search_path
-- is a privilege-escalation hole: the caller controls which schema an unqualified
-- name resolves to, so they choose which function or table the body actually
-- touches, and it runs as the owner. `SET search_path = ''` plus fully qualified
-- references closes that, and both halves are needed — the SET alone would break
-- an unqualified reference rather than secure it.
--
-- Note that pg_catalog is still implicitly searched even with an empty
-- search_path, so the qualification below is belt and braces. It is written out
-- anyway, because a reader should not have to know that rule to be sure.
--
-- And the grants. Postgres's DEFAULT for a new function is EXECUTE TO PUBLIC —
-- that is exactly what rule 5 inside this very function looks for. A security
-- check that trips its own rule would be a bad joke, so the REVOKE/GRANT pair at
-- the bottom is as much a part of this migration as the function.
--
--
-- ON SECURITY DEFINER SPECIFICALLY
-- --------------------------------
--
-- Worth knowing before you apply it: the catalogs this reads (pg_class,
-- pg_policy, pg_proc, pg_attribute, pg_roles) are all world-readable, and
-- aclexplode and acldefault are executable by PUBLIC. SECURITY INVOKER would
-- return identical rows today and would be the smaller privilege.
--
-- DEFINER is used anyway so the answer does not depend on what the calling role
-- can see. A check that silently narrows when the caller's privileges change is
-- the same failure mode as reading information_schema — "no rows" would start
-- meaning "none visible to you" instead of "none". That is the one property this
-- whole exercise exists to avoid, so it is worth the stricter hardening.
--
-- If you would rather have the smaller privilege, change SECURITY DEFINER to
-- SECURITY INVOKER and keep everything else; nothing else in the file depends
-- on it.
--
--
-- WHAT IT RETURNS
-- ---------------
--
-- Object names and rule ids. No policy expression, no privilege list, no column
-- value. The result goes into an email; a map of where the weaknesses are is
-- useful, a description of how each one is shaped is an exploitation guide.
--
-- The 6c inventory (`grant.table_to_*`, about forty rows describing the normal
-- state of the database) is deliberately NOT here. It stays in the .sql file.
-- The route also filters it, so returning it would still not reach the mail —
-- but it has no business crossing the wire in the first place.


CREATE OR REPLACE FUNCTION public.security_assertions()
RETURNS TABLE (schema_name text, object_name text, rule_broken text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  -- 1. A table with RLS disabled. public and storage.
  SELECT
    n.nspname::text,
    c.relname::text,
    'rls.disabled'::text
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'storage')
    AND c.relkind IN ('r', 'p')
    AND NOT c.relrowsecurity

  UNION ALL

  -- 2. RLS enabled, zero policies. PUBLIC ONLY — across storage this returns
  -- Supabase's own buckets, migrations, s3_multipart_uploads and vector_indexes,
  -- none of which is ours to fix.
  SELECT
    n.nspname::text,
    c.relname::text,
    'rls.no_policies'::text
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relrowsecurity
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid
    )

  UNION ALL

  -- 3. A policy reaching public or anon. OID 0 in polroles is PUBLIC, which is
  -- what a policy written without a TO clause gets — invisible in the CREATE
  -- POLICY text, and exactly how the setup-images policy passed review.
  SELECT
    n.nspname::text,
    (c.relname || '.' || p.polname)::text,
    CASE WHEN 0 = ANY (p.polroles)
         THEN 'policy.role_public'
         ELSE 'policy.role_anon'
    END::text
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c     ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'storage')
    AND (
      0 = ANY (p.polroles)
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles r
        WHERE r.oid = ANY (p.polroles) AND r.rolname = 'anon'
      )
    )

  UNION ALL

  -- 4. A policy whose USING or WITH CHECK is literally true. The clause is
  -- named; the expression is never returned.
  SELECT
    n.nspname::text,
    (c.relname || '.' || p.polname)::text,
    CASE WHEN pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true'
         THEN 'policy.using_true'
         ELSE 'policy.with_check_true'
    END::text
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c     ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'storage')
    AND (
      pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true'
      OR pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) = 'true'
    )

  UNION ALL

  -- 5. EXECUTE to PUBLIC. PUBLIC ONLY — storage ships about twenty functions
  -- this way and they are not ours to revoke.
  --
  -- The COALESCE is the whole point: a NULL proacl means nobody has touched the
  -- function, and Postgres's default for a function IS execute-to-public, so
  -- reading proacl alone would return nothing for exactly the functions nobody
  -- has locked down. acldefault materialises that implicit grant.
  SELECT DISTINCT
    n.nspname::text,
    (p.oid::pg_catalog.regprocedure)::text,
    'function.execute_to_public'::text
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
  ) a
  WHERE n.nspname = 'public'
    AND a.grantee = 0
    AND a.privilege_type = 'EXECUTE'

  UNION ALL

  -- 6a. A table-level grant on a table that ALSO carries column-level grants.
  --
  -- The override case. Column grants are how a table says "only these columns
  -- are client-readable"; a table-level grant covers every column including the
  -- ones deliberately left out. The two live in different catalogs, so neither
  -- shows up in a listing of the other and the column grants go on looking
  -- correct while being irrelevant.
  SELECT DISTINCT
    n.nspname::text,
    c.relname::text,
    ('grant.table_overrides_column_' || r.rolname)::text
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))
  ) a
  JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
  WHERE n.nspname IN ('public', 'storage')
    AND c.relkind IN ('r', 'p', 'v', 'm')
    AND r.rolname IN ('anon', 'authenticated')
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute att
      CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) ca
      JOIN pg_catalog.pg_roles cr ON cr.oid = ca.grantee
      WHERE att.attrelid = c.oid
        AND att.attnum > 0
        AND NOT att.attisdropped
        AND att.attacl IS NOT NULL
        AND cr.rolname IN ('anon', 'authenticated')
    )

  UNION ALL

  -- 6b. A table-level grant on a table that must never have one.
  --
  -- A never-list, and the only place in this function that names an object. It
  -- can produce a false negative for a table nobody added to it, never a false
  -- positive, and it never fires because something new exists — add a
  -- server-only table, add a line here in the same change.
  --
  -- It covers what 6a cannot see: revoking the column grants and granting the
  -- table in one go leaves no column grant behind, so 6a falls silent at exactly
  -- the moment the table became fully readable.
  SELECT DISTINCT
    n.nspname::text,
    c.relname::text,
    'grant.table_on_never_list'::text
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))
  ) a
  JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
  WHERE n.nspname = 'public'
    AND c.relname IN ('tradovate_connections')
    AND r.rolname IN ('anon', 'authenticated')

  UNION ALL

  -- 7. A column grant on a secret-looking column.
  --
  -- Matches the column NAME, so a token column added next year is covered the
  -- day it is created. ONE EXCLUSION by whole name: token_type, which 030 grants
  -- on purpose and which holds "bearer" — the token TYPE, not a token. Excluded
  -- by exact name rather than by weakening the pattern, so token, access_token
  -- and refresh_token all still fire.
  SELECT DISTINCT
    n.nspname::text,
    (c.relname || '.' || att.attname)::text,
    ('grant.secret_column_to_' || r.rolname)::text
  FROM pg_catalog.pg_attribute att
  JOIN pg_catalog.pg_class c     ON c.oid = att.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
  JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
  WHERE n.nspname IN ('public', 'storage')
    AND att.attnum > 0
    AND NOT att.attisdropped
    AND att.attacl IS NOT NULL
    AND r.rolname IN ('anon', 'authenticated')
    AND att.attname ~* '(token|secret|key|password)'
    AND att.attname <> 'token_type'
$$;


-- ---------------------------------------------------------------------------
-- Privileges.
--
-- REVOKE FIRST. CREATE OR REPLACE on an existing function leaves its ACL alone,
-- but on a first create the default applies and the default is EXECUTE TO
-- PUBLIC. Rule 5 above exists to catch precisely that, so this function must not
-- be the thing that trips it.
--
-- anon and authenticated are named explicitly rather than left to the PUBLIC
-- revoke, so that a future blanket GRANT does not silently re-open them.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.security_assertions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.security_assertions() FROM anon;
REVOKE ALL ON FUNCTION public.security_assertions() FROM authenticated;

GRANT EXECUTE ON FUNCTION public.security_assertions() TO service_role;


-- ===========================================================================
-- VERIFICATION — run this immediately after the statements above.
--
-- EXPECTED: exactly one row, with
--
--   is_security_definer    t
--   search_path_pinned     t
--   execute_to_public      f
--   execute_to_anon        f
--   execute_to_authent     f
--   execute_to_service     t
--   all_checks_pass        t
--
-- execute_granted_to will read something like "postgres, service_role". The
-- owner is always there and cannot be revoked away meaningfully — it is the role
-- that created the function. service_role is the one that had to be added.
--
-- If the function is missing entirely the query returns ZERO rows, which is the
-- one result that does not look like a pass. Check the row count first.
-- ===========================================================================
SELECT
  (p.oid::regprocedure)::text                        AS function_signature,
  p.prosecdef                                        AS is_security_definer,
  p.proconfig                                        AS settings,
  EXISTS (
    SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
    WHERE cfg LIKE 'search_path=%'
  )                                                  AS search_path_pinned,
  EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE a.privilege_type = 'EXECUTE' AND a.grantee = 0
  )                                                  AS execute_to_public,
  EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE a.privilege_type = 'EXECUTE' AND r.rolname = 'anon'
  )                                                  AS execute_to_anon,
  EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE a.privilege_type = 'EXECUTE' AND r.rolname = 'authenticated'
  )                                                  AS execute_to_authent,
  EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE a.privilege_type = 'EXECUTE' AND r.rolname = 'service_role'
  )                                                  AS execute_to_service,
  (SELECT string_agg(DISTINCT COALESCE(r.rolname, 'PUBLIC'), ', ')
     FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     LEFT JOIN pg_roles r ON r.oid = a.grantee
    WHERE a.privilege_type = 'EXECUTE')              AS execute_granted_to,
  (
    p.prosecdef
    AND EXISTS (
      SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS cfg
      WHERE cfg LIKE 'search_path=%')
    AND NOT EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE a.privilege_type = 'EXECUTE'
        AND (a.grantee = 0 OR r.rolname IN ('anon', 'authenticated')))
    AND EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      JOIN pg_roles r ON r.oid = a.grantee
      WHERE a.privilege_type = 'EXECUTE' AND r.rolname = 'service_role')
  )                                                  AS all_checks_pass
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'security_assertions';


-- ===========================================================================
-- SMOKE TEST — optional, run it once.
--
-- EXPECTED: the same rows queries 1-7 of supabase/queries/security_assertions.sql
-- return when run individually. On the state of 1 Oct that is zero rows; if the
-- bucket limits are still unset they do not appear here, because rules 8 and 9
-- live in the route, not in this function.
--
-- Zero rows here is a pass, and it is also what a broken function returns, which
-- is why the VERIFICATION block above is the one that matters.
-- ===========================================================================
SELECT * FROM public.security_assertions();

-- 028 — put notebook_pages and setups into the repo
--
-- Against production: a no-op. Everything here is IF NOT EXISTS or guarded, and
-- all of it already exists. Run it anyway — the verification at the foot is
-- what proves this file and the database agree, and IF NOT EXISTS will happily
-- hide a mismatch between what is written here and what is actually there.
--
-- Against a fresh project: this is what creates these two tables at all.
--
-- ── Provenance, and why it matters per table ──
--
-- Both tables here come from supabase_migrations.schema_migrations — the
-- statements Supabase's migration tool stored when they were originally
-- applied. That is the source text: what was ASKED FOR, including ordering and
-- anything that failed silently afterwards.
--
--   notebook_pages   ledger version 2026053119330  create_notebook_pages
--   setups           ledger version 2026053119502  create_setups_and_link_trades
--                    ledger version 202606020927   add_setup_structured_fields
--
-- `rule_violations` is NOT in this file. It has no migration file and no ledger
-- row — it exists and is written to on every rule violation
-- (src/lib/rules/logRuleViolation.ts) and nothing anywhere describes it. It can
-- only be reconstructed from the catalog via queries/table_ddl.sql, which is
-- what the database ENDED UP WITH rather than what anyone asked for. That is a
-- weaker kind of evidence and it belongs in its own file rather than being
-- mixed in here where the difference would stop being visible. See 029.
--
-- `setup_images_delete` on storage.objects is in the same position: it exists,
-- it is not in this ledger row, and no migration creates it. Also 029.
--
-- ── Three deliberate departures from the source text ──
--
-- The stored statements describe May/June 2026. Three of them describe a state
-- we have since deliberately changed, and replaying them as written would undo
-- that. Each is carried forward to today's state, with the original quoted
-- beside it:
--
--   1. The bucket was created public. 020 made it private. Created private here.
--   2. setup_images_select had no TO clause and no folder pin — it returned any
--      object in the bucket to anyone. That is REF-72. 018 replaced it. The
--      hardened version is what this file creates.
--   3. setups_owner and notebook_pages_owner were created with no TO clause,
--      which means PUBLIC. 023 scoped every policy in public to authenticated.
--      Created scoped here.
--
-- A rebuild from this directory should land on today's schema, not on
-- September's. Anything else would mean the repo faithfully reproducing a hole
-- we have already closed.


-- ═══════════════════════════════════════════════════════════════════════════
-- notebook_pages — ledger 2026053119330, verbatim except the policy's TO clause
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS notebook_pages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'דף ללא כותרת',
  content     TEXT NOT NULL DEFAULT '',
  page_type   TEXT NOT NULL DEFAULT 'journal'
                CHECK (page_type IN ('journal','insights','plan')),
  tags        TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stated explicitly rather than left to the ensure_rls event trigger. That
-- trigger is a safety net for tables created outside this repo; a migration
-- should say what it means. See supabase/README.md.
ALTER TABLE notebook_pages ENABLE ROW LEVEL SECURITY;

-- Original: CREATE POLICY "notebook_pages_owner" ON notebook_pages
--             FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
-- No TO clause means PUBLIC, which includes anon. 023 scoped it; created scoped.
DROP POLICY IF EXISTS "notebook_pages_owner" ON notebook_pages;
CREATE POLICY "notebook_pages_owner" ON notebook_pages
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_notebook_pages_user_updated
  ON notebook_pages (user_id, updated_at DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- setups — ledger 2026053119502 and 202606020927
-- ═══════════════════════════════════════════════════════════════════════════

-- Note user_id REFERENCES auth.users(id), not profiles(id) as every table in
-- schema.sql does. That is what the source says and it is what is live, so it
-- stands; recorded here because the inconsistency is otherwise invisible and
-- would look like a typo to whoever reads this next.
CREATE TABLE IF NOT EXISTS setups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  symbol      TEXT,
  description TEXT NOT NULL DEFAULT '',
  image_url   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE setups ENABLE ROW LEVEL SECURITY;

-- Original: CREATE POLICY "setups_owner" ON setups
--             FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
-- Same missing TO clause as notebook_pages_owner. 023 scoped it.
DROP POLICY IF EXISTS "setups_owner" ON setups;
CREATE POLICY "setups_owner" ON setups
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_setups_user ON setups (user_id, updated_at DESC);

-- From ledger 202606020927 (add_setup_structured_fields), verbatim.
ALTER TABLE setups
  ADD COLUMN IF NOT EXISTS entry_conditions text,
  ADD COLUMN IF NOT EXISTS stop_loss        text,
  ADD COLUMN IF NOT EXISTS take_profit      text,
  ADD COLUMN IF NOT EXISTS market_context   text;

-- Not from the ledger: 019 adds this, and 019 is numbered BEFORE this file, so
-- on a clean rebuild it runs before `setups` exists and fails. Declared here so
-- the table is complete whichever order things run in; 019's own ALTER is then
-- a no-op on a database where this has already run. See the ordering note at
-- the foot — this papers over a symptom, it does not fix the sequence.
ALTER TABLE setups ADD COLUMN IF NOT EXISTS image_path TEXT;

-- The link onto trade_plans, from the same ledger row.
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS setup_id UUID REFERENCES setups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_trade_plans_setup ON trade_plans (setup_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- storage: the setup-images bucket and its policies
-- ═══════════════════════════════════════════════════════════════════════════

-- Original: VALUES ('setup-images', 'setup-images', true)
--
-- `true` made every object in the bucket readable by URL with no credential at
-- all — /storage/v1/object/public/setup-images/<path> served any known key to
-- anyone. 020 set it false after the signing build shipped. Created false.
--
-- ON CONFLICT DO NOTHING means this will not flip an existing bucket back, in
-- either direction. That is deliberate: 020's comment is explicit that flipping
-- this column is a break-glass action with immediate user-visible effect, and a
-- backfill migration is not the place for it.
INSERT INTO storage.buckets (id, name, public)
  VALUES ('setup-images', 'setup-images', false)
  ON CONFLICT (id) DO NOTHING;

-- The two policies, guarded the way the original was. The insert policy is
-- carried over unchanged — it was written correctly, with both TO authenticated
-- and the folder pin.
--
-- The select policy is NOT the original. The original, verbatim:
--
--     CREATE POLICY "setup_images_select" ON storage.objects
--       FOR SELECT USING (bucket_id = 'setup-images')
--
-- No TO clause and no folder pin, sitting immediately after an insert policy
-- that has both — the same migration, adjacent statements, disagreeing about
-- their own threat model. That is REF-72: any authenticated request could read
-- any user's chart screenshots. 018 replaced it with the version below, which
-- is what this file creates.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'setup_images_insert' AND tablename = 'objects'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "setup_images_insert" ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'setup-images' AND (storage.foldername(name))[1] = auth.uid()::text)
    $policy$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'setup_images_select' AND tablename = 'objects'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "setup_images_select" ON storage.objects
        FOR SELECT TO authenticated
        USING (bucket_id = 'setup-images' AND (storage.foldername(name))[1] = auth.uid()::text)
    $policy$;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Verification — run all four. IF NOT EXISTS hides mismatches; these find them.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Columns, compared both ways. A row here is either a column this file
--    declares that is not in the database, a column in the database this file
--    does not declare, or a type disagreement. Expect zero rows.
WITH expected(table_name, column_name, data_type) AS (
  VALUES
    ('notebook_pages', 'id',               'uuid'),
    ('notebook_pages', 'user_id',          'uuid'),
    ('notebook_pages', 'title',            'text'),
    ('notebook_pages', 'content',          'text'),
    ('notebook_pages', 'page_type',        'text'),
    ('notebook_pages', 'tags',             'text[]'),
    ('notebook_pages', 'created_at',       'timestamp with time zone'),
    ('notebook_pages', 'updated_at',       'timestamp with time zone'),
    ('setups',         'id',               'uuid'),
    ('setups',         'user_id',          'uuid'),
    ('setups',         'name',             'text'),
    ('setups',         'symbol',           'text'),
    ('setups',         'description',      'text'),
    ('setups',         'image_url',        'text'),
    ('setups',         'image_path',       'text'),
    ('setups',         'entry_conditions', 'text'),
    ('setups',         'stop_loss',        'text'),
    ('setups',         'take_profit',      'text'),
    ('setups',         'market_context',   'text'),
    ('setups',         'created_at',       'timestamp with time zone'),
    ('setups',         'updated_at',       'timestamp with time zone')
),
actual AS (
  SELECT c.relname AS table_name,
         a.attname AS column_name,
         format_type(a.atttypid, a.atttypmod) AS data_type
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = 'public'
    AND c.relname IN ('notebook_pages', 'setups')
    AND a.attnum > 0
    AND NOT a.attisdropped
)
SELECT
  COALESCE(e.table_name, a.table_name)   AS table_name,
  COALESCE(e.column_name, a.column_name) AS column_name,
  e.data_type AS this_file_says,
  a.data_type AS database_says,
  CASE
    WHEN a.column_name IS NULL THEN 'MISSING from the database'
    WHEN e.column_name IS NULL THEN 'IN THE DATABASE, not declared here'
    ELSE 'TYPE MISMATCH'
  END AS problem
FROM expected e
FULL OUTER JOIN actual a
  ON a.table_name = e.table_name AND a.column_name = e.column_name
WHERE e.column_name IS NULL
   OR a.column_name IS NULL
   OR e.data_type IS DISTINCT FROM a.data_type
ORDER BY 1, 2;

-- 2. trade_plans.setup_id exists and still points at setups. Expect one row.
SELECT
  pg_get_constraintdef(con.oid) AS fk_definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname = 'trade_plans'
  AND con.contype = 'f'
  AND pg_get_constraintdef(con.oid) ILIKE '%setups%';

-- 3. The bucket is private and both storage policies are scoped and pinned.
--    Expect public = false, and two policies both TO {authenticated} whose
--    expressions mention storage.foldername.
SELECT id, name, public FROM storage.buckets WHERE id = 'setup-images';

SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
  AND policyname LIKE 'setup_images%'
ORDER BY policyname;

-- 4. RLS is on for both tables and each has exactly its owner policy.
SELECT c.relname, c.relrowsecurity AS rls_enabled,
       (SELECT count(*) FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('notebook_pages', 'setups');


-- ── The ordering problem this file does not fix ──
--
-- 019 and 020 both reference `setups`, and both are numbered before 028. On a
-- clean rebuild in numeric order, 019's ALTER TABLE runs before the table
-- exists and errors — ADD COLUMN IF NOT EXISTS guards the column, not the
-- table. 020's UPDATE would match zero rows and pass silently, which is worse
-- in its way.
--
-- Declaring image_path above stops the column being missing, but it does not
-- make the sequence replayable: this directory still cannot be run start to
-- finish against an empty database. That is not a defect in this file, it is
-- the same finding the whole exercise turned up — the files are a change log,
-- not a schema definition — and it is resolved by the baseline reset described
-- in supabase/MIGRATION-STRATEGY.md, not by renumbering.

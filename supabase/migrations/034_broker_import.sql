-- REF-107 Stage 2: a closed broker trade becomes a row in the journal.
--
-- Adds provenance and a hide flag to `trade_plans`, relaxes the six intent
-- columns to nullable, and adds one declaration column to
-- `tradovate_connections`. Creates no table, drops no column, and reads no
-- amount.
--
-- RUN THIS BY HAND in the Supabase SQL Editor. Nothing in the repo applies
-- migrations.
--
-- NUMBERING: 029 is reserved for rule_violations and setup_images_delete
-- (REF-89) and still has no file; 021 is reserved for the
-- `ai-usage-accounting` branch. 030, 031, 032 and 033 are applied — 032 was
-- confirmed applied by Itamar on 13.10, which is what unblocks `unplanned`
-- below. 034 is the next number that is neither taken nor reserved. Do not
-- reuse 029 or 021.
--
--
-- DEPLOY ORDER DOES NOT MATTER, AND THAT IS ENFORCED IN CODE
-- ---------------------------------------------------------
--
-- The application does not name a single one of these columns until the
-- environment variable TRADOVATE_IMPORT_ENABLED is set to '1'. With the flag
-- unset — which is every deployment until the owner sets it — the import is a
-- no-op, the rule engine issues exactly the queries it issued before, and
-- nothing selects, inserts or updates a column this file adds. See
-- src/lib/tradovate/import.ts (isImportEnabled) and the note on
-- loadTradeRuleContext's `taken` query.
--
-- So the order is: deploy the code, run this file, THEN set the flag. Setting
-- the flag before this file has run is the one ordering that breaks, and it
-- breaks loudly (PostgREST 42703 on an undefined column) rather than silently.
--
--
-- BEFORE RUNNING IT — SURVEY
-- --------------------------
--
-- supabase/migrations/ does not describe the live database: objects here have
-- been created by hand in the dashboard and leave no trace in the repo (see
-- CLAUDE.md and supabase/README.md). This file was written WITHOUT database
-- access, from the repo's SQL only. Run all five of these first and read the
-- output.
--
--   -- 1. Which of this file's columns already exist, and how.
--   SELECT table_name, column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND (   (table_name = 'trade_plans' AND column_name IN
--                 ('source', 'broker_trade_key', 'broker_account_id',
--                  'broker_host', 'hidden', 'strategy', 'stop_loss',
--                  'take_profit', 'rr_ratio', 'trade_reason', 'emotional_state'))
--           OR (table_name = 'tradovate_connections' AND column_name = 'is_trade_source'))
--    ORDER BY table_name, column_name;
--
--   -- 2. Every CHECK constraint on trade_plans, with the columns it covers.
--   --    The six DROP NOT NULLs below must leave these alone; read this before
--   --    and after and compare.
--   SELECT c.conname,
--          pg_get_constraintdef(c.oid) AS definition,
--          (SELECT array_agg(a.attname ORDER BY a.attname)
--             FROM pg_attribute a
--            WHERE a.attrelid = c.conrelid
--              AND a.attnum   = ANY (c.conkey)) AS covered_columns
--     FROM pg_constraint c
--    WHERE c.conrelid = 'public.trade_plans'::regclass
--      AND c.contype  = 'c'
--    ORDER BY c.conname;
--
--   -- 3. Is anything already keyed like a broker row? Expect zero rows. A
--   --    non-zero answer means an earlier import ran, and step 6's UNIQUE
--   --    index would fail on the duplicates rather than create.
--   SELECT user_id, broker_trade_key, count(*)
--     FROM trade_plans
--    WHERE broker_trade_key IS NOT NULL
--    GROUP BY 1, 2
--   HAVING count(*) > 1;
--   -- (Errors with 42703 if the column does not exist yet. That IS the
--   --  expected answer on a first run — it means there is nothing to collide.)
--
--   -- 4. How many rows the six columns are about to stop constraining.
--   SELECT count(*) AS rows, count(DISTINCT user_id) AS users FROM trade_plans;
--
--   -- 5. How many connections the declaration in step 8 will default to true.
--   SELECT status, count(*) FROM tradovate_connections GROUP BY 1 ORDER BY 2 DESC;
--
--
-- WHY EACH CHANGE
-- ---------------
--
-- 1. source — the product principle stated on REF-107 by Imri on 13.10: EVERY
--    TRADE RECORDS ITS SOURCE, one table, one shape, no feature may require a
--    broker. `DEFAULT 'manual'` is the truth about every row that exists
--    today. `rule_context_source` (032) is deliberately NOT overloaded for
--    this: that column describes the RULE CHECK's provenance — what the engine
--    had in hand when the plan was saved — and this one describes the TRADE's.
--    Two different questions; §B5 of the investigation.
--
-- 2. broker_trade_key — the natural key from §A3, as Stage 1 built it:
--    `<host>:<lowest fill id in the group>`. A GROUP, because the unit a
--    journal means by "a trade" is every fill pair that shares a fill, and
--    Tradovate does not name that unit so it has no id of its own. Host-
--    qualified because nothing documents live and demo as sharing id spaces,
--    and unprefixed a demo fill 401 and a live fill 401 would be one key —
--    which under the UNIQUE in step 6 silently drops one of two real trades.
--
-- 3. broker_account_id + broker_host — E15, and REF-110's "every trade carries
--    an account". Rules stay aggregated across a trader's accounts (REF-90
--    §3ב: a discipline rule is about the trader, not one of their accounts),
--    but a JOURNAL that mixes a prop evaluation account with a personal one is
--    a journal nobody can read. BIGINT because Tradovate account ids are
--    `number` on the wire with no documented bound, and INTEGER is a bound we
--    would be inventing. Host beside it because the id is host-local — the
--    same reason it is in the key.
--
--    These are the Stage A half of REF-110: the ids, stored on every imported
--    row from the first one. The accounts TABLE, the manual "תיק" field and the
--    per-account screen are Stages B and C of that ticket and are not here.
--
-- 4. hidden — E12. A broker row that the user deletes comes BACK on the next
--    sync: the UNIQUE in step 6 prevents a duplicate, it does not remember a
--    deletion. So "delete" on such a row has to be a flag the import can read,
--    and the import skips a hidden key rather than resurrecting it.
--
--    NOT NULL DEFAULT false, so every existing row is visible and no reader
--    has to treat the absence of a value as a third state.
--
-- 5. The six NOT NULL intent columns — E4, decided by Imri on 13.10: RELAX TO
--    NULLABLE, NO PLACEHOLDERS. The broker knows price, quantity, direction,
--    time and money. It does not know why you entered, what you planned, or
--    how you felt, and the investigation's §0ג is the argument against
--    inventing those: a placeholder is a number that LOOKS like data, and
--    `emotional_state = 3` or `rr_ratio = 0` on two hundred imported rows
--    silently relabels a trader "Emotional Trader" or "Aggressive Scalper"
--    because of the sync rather than because of their trading. `NULL` makes
--    every reader decide, and REF-107 Stage 4 (`43cc33c`, merged) is the
--    change that made all of them decide correctly. THAT IS THE PRECONDITION
--    FOR THIS STEP: do not run this file on a deployment older than Stage 4.
--
--    The CHECKs stay. `emotional_state BETWEEN 1 AND 5` is not weakened by a
--    NULL — a CHECK rejects only FALSE, and `NULL BETWEEN 1 AND 5` is NULL —
--    so a null passes while 0 and 6 still do not. That is exactly the
--    behaviour wanted, and it is why this file drops nullability WITHOUT
--    touching a constraint.
--
-- 6. is_trade_source on tradovate_connections — E7, the per-broker
--    declaration (§C8 option ג). "Tradovate is the source of trades for this
--    account." When true, the broker's rows are canonical for closed money and
--    a manual row for the same trade is a plan waiting to be linked rather
--    than a second trade. Defaults TRUE because that is what a trader who just
--    connected a broker means by connecting it, and because option A in
--    lib/rules/tradeRuleContext.ts already behaves this way today — so the
--    default preserves current behaviour rather than changing it.
--
--    This table uses COLUMN-LEVEL GRANTS (017), and a new column carries no
--    privileges from them, so step 8 grants it explicitly. It is granted
--    because the rule engine runs in the browser and has to know which policy
--    it is under. There is still no INSERT/UPDATE policy for `authenticated`,
--    so a client can read this flag and cannot set it — flipping it is a
--    server-side change and the UI for it is not in this stage.
--
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--
--   - No `broker_fills` table (§C10.3). Raw fills are a trader's positions at
--     their most granular, we have never stored them, and nothing in Stage 2
--     needs them. It is a decision to revisit at Stage 5, with RLS, account
--     deletion and the privacy policy in the same change.
--   - No contract-spec cache (§C10.4). That is Stage 5's cost problem.
--   - No `profiles.timezone` (§C10.5). Still unsolved, and still only binding
--     on historical import: every column this file writes takes its instant
--     from the broker's own fill timestamps, not from a day boundary.
--   - No new index beyond the UNIQUE. The dedup rule adds `source` as one more
--     equality on query shapes that already run under
--     `idx_trade_plans_user_date` and the user_id/status/closed_at path; at
--     Stage 2 volumes a second index would be a guess. Revisit with Stage 5's
--     thousands of rows, where `(user_id, hidden) WHERE hidden` is the likely
--     shape.
--
--
-- IDEMPOTENT. Every statement is `IF NOT EXISTS`, a declarative `DROP NOT
-- NULL`, or a drop-then-add of a constraint this file owns. Safe to re-run.
-- One transaction, so a failure anywhere leaves the table exactly as it was.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. trade_plans.source
--
-- NOT NULL with a DEFAULT: Postgres 11+ fills existing rows from the default
-- without rewriting the table, and 'manual' is correct for every row in there
-- — all of them came from the form.
--
-- The CHECK is dropped and re-added rather than created inline, so a re-run
-- replaces this file's own constraint instead of failing on it. The list grows
-- when Stage 6 adds a second broker; `source` being CHECKed is what makes that
-- an added value rather than a change of shape.
-- ---------------------------------------------------------------------------

ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE trade_plans
  DROP CONSTRAINT IF EXISTS trade_plans_source_check;
ALTER TABLE trade_plans
  ADD CONSTRAINT trade_plans_source_check
  CHECK (source IN ('manual', 'tradovate'));


-- ---------------------------------------------------------------------------
-- 2. trade_plans.broker_trade_key
--
-- Nullable, and the null is the meaning: a manual row has no broker key. TEXT
-- rather than BIGINT because the value is `<host>:<fill id>` — see the header.
-- ---------------------------------------------------------------------------

ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS broker_trade_key TEXT;


-- ---------------------------------------------------------------------------
-- 3. trade_plans.broker_account_id and broker_host
-- ---------------------------------------------------------------------------

ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS broker_account_id BIGINT;

ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS broker_host TEXT;

ALTER TABLE trade_plans
  DROP CONSTRAINT IF EXISTS trade_plans_broker_host_check;
ALTER TABLE trade_plans
  ADD CONSTRAINT trade_plans_broker_host_check
  CHECK (broker_host IN ('live', 'demo'));


-- ---------------------------------------------------------------------------
-- 4. trade_plans.hidden
-- ---------------------------------------------------------------------------

ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;


-- ---------------------------------------------------------------------------
-- 5. The six intent columns become nullable.
--
-- One statement, so the six cannot land apart. `DROP NOT NULL` on a column
-- that is already nullable is accepted and does nothing, which is what makes
-- the re-run safe.
--
-- Nothing else about these columns changes: no default is added (a default
-- here would be the placeholder E4 refuses), no CHECK is touched, no row is
-- written.
-- ---------------------------------------------------------------------------

ALTER TABLE trade_plans
  ALTER COLUMN strategy        DROP NOT NULL,
  ALTER COLUMN stop_loss       DROP NOT NULL,
  ALTER COLUMN take_profit     DROP NOT NULL,
  ALTER COLUMN rr_ratio        DROP NOT NULL,
  ALTER COLUMN trade_reason    DROP NOT NULL,
  ALTER COLUMN emotional_state DROP NOT NULL;


-- ---------------------------------------------------------------------------
-- 6. One broker trade, one row — the index the whole import rests on.
--
-- PARTIAL, on `WHERE broker_trade_key IS NOT NULL`. A plain
-- `UNIQUE (user_id, broker_trade_key)` would also work, because Postgres
-- treats NULLs as distinct and would therefore allow any number of manual
-- rows — but it would index every manual row for nothing, and the predicate
-- states the intent instead of relying on a NULL-handling rule the reader has
-- to recall.
--
-- A UNIQUE INDEX rather than a UNIQUE CONSTRAINT because a constraint cannot
-- be partial.
--
-- WHAT IT BUYS: a re-import cannot duplicate. Without it, every second run
-- doubles the journal — which is why the import's own idempotence is NOT
-- allowed to rest on application logic alone, and why the test suite asserts
-- a second import writes nothing.
--
-- AND THE ONE THING IT DOES NOT BUY — §A3's caveat, and it is handled in code
-- rather than here: THE KEY IS STABLE ONLY ONCE THE POSITION IS FLAT. A later
-- pull that sees a new fill pair bridging two previously separate groups
-- merges them, and the merged group's lowest fill id can be the other group's.
-- So `importBrokerTrades` imports a trade only when every leg's position has
-- `netPos = 0`, and the index cannot be asked to catch a key that changed
-- legitimately. See src/lib/tradovate/import.ts.
--
-- NOT `CONCURRENTLY`: that cannot run inside a transaction, and this file is
-- one transaction on purpose. At Stage 2 volumes the brief lock is nothing; if
-- this is ever re-created on a large table, do it outside the BEGIN/COMMIT.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_plans_broker_trade_key
  ON trade_plans (user_id, broker_trade_key)
  WHERE broker_trade_key IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 7. The provenance columns are readable by the browser already.
--
-- Stated rather than granted, and checked rather than assumed — the same note
-- 032 carries. `trade_plans` does not use column-level GRANTs: no migration
-- and no part of supabase/schema.sql issues a column GRANT or REVOKE against
-- it, so it keeps Supabase's table-level grants under the table's existing RLS
-- policy ("Users can manage own trade plans", FOR ALL USING auth.uid() =
-- user_id). Every column added above is therefore readable and writable by its
-- owner as soon as it exists, and NO GRANT BELONGS HERE.
--
-- That the owner can WRITE them is worth naming, because `hidden` and
-- `broker_trade_key` are the two the import depends on. A user can clear their
-- own `broker_trade_key` from the browser and so cause their own trade to be
-- imported a second time. That is their row, their journal and their mess, it
-- is reachable only with a hand-written PostgREST call, and the alternative —
-- column grants on `trade_plans` — would mean enumerating forty-odd columns
-- and keeping that list in step with every future migration. Not worth it for
-- a self-inflicted duplicate. Revisit if the journal ever becomes shared.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 8. tradovate_connections.is_trade_source — E7's declaration.
--
-- The GRANT is required and is not boilerplate: 017 REVOKEd everything from
-- `authenticated` on this table and granted six named columns, 030 added three
-- more by name, and a column added without a grant is invisible to the browser
-- — which here would mean the rule engine silently falling back to the
-- Reflect-only policy for every user.
--
-- GRANTed to `authenticated` only. `anon` gets nothing on this table, 017
-- states that explicitly, and this does not change it.
--
-- Still no INSERT or UPDATE policy for `authenticated`: the flag is readable
-- by its owner and settable only by the server. The "סנכרן עכשיו" button and
-- the toggle that writes this column are UI work in a later stage.
-- ---------------------------------------------------------------------------

ALTER TABLE tradovate_connections
  ADD COLUMN IF NOT EXISTS is_trade_source BOOLEAN NOT NULL DEFAULT true;

GRANT SELECT (is_trade_source) ON tradovate_connections TO authenticated;

COMMIT;


-- ===========================================================================
-- VERIFY (read-only, after COMMIT)
-- ===========================================================================
--
-- 1. The five new columns on trade_plans, with the right nullability and
--    defaults. EXPECT: broker_account_id/broker_host/broker_trade_key YES-null
--    and no default; hidden NO-null default false; source NO-null default
--    'manual'.
--
--      SELECT column_name, data_type, is_nullable, column_default
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'trade_plans'
--         AND column_name IN ('source', 'broker_trade_key',
--                             'broker_account_id', 'broker_host', 'hidden')
--       ORDER BY column_name;
--
-- 2. The six intent columns are nullable. EXPECT: six rows, all YES.
--
--      SELECT column_name, is_nullable
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'trade_plans'
--         AND column_name IN ('strategy', 'stop_loss', 'take_profit',
--                             'rr_ratio', 'trade_reason', 'emotional_state')
--       ORDER BY column_name;
--
-- 3. The CHECKs survived step 5. EXPECT the emotional_state BETWEEN 1 AND 5
--    check still listed, plus this file's two new ones. Compare against the
--    output of survey query 2.
--
--      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
--        FROM pg_constraint c
--       WHERE c.conrelid = 'public.trade_plans'::regclass AND c.contype = 'c'
--       ORDER BY c.conname;
--
-- 4. The partial UNIQUE index exists and IS partial. EXPECT one row whose
--    definition ends in `WHERE (broker_trade_key IS NOT NULL)`. If the WHERE
--    is missing, something created a non-partial index first and step 6's
--    IF NOT EXISTS skipped silently.
--
--      SELECT indexname, indexdef
--        FROM pg_indexes
--       WHERE schemaname = 'public' AND tablename = 'trade_plans'
--         AND indexname = 'idx_trade_plans_broker_trade_key';
--
-- 5. A NULL emotional_state really is accepted and 0 really is not. Both
--    statements are expected to be rolled back; the point is which one errors.
--    EXPECT: the first succeeds, the second fails with
--    trade_plans_emotional_state_check (or whatever survey 2 called it).
--
--      BEGIN;
--        INSERT INTO trade_plans (user_id, entry_price, emotional_state)
--        SELECT user_id, 1, NULL FROM trade_plans LIMIT 1;
--      ROLLBACK;
--
--      BEGIN;
--        INSERT INTO trade_plans (user_id, entry_price, emotional_state)
--        SELECT user_id, 1, 0 FROM trade_plans LIMIT 1;
--      ROLLBACK;
--
-- 6. The declaration column and its grant. EXPECT one row from each.
--
--      SELECT column_name, data_type, is_nullable, column_default
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'tradovate_connections'
--         AND column_name = 'is_trade_source';
--
--      SELECT r.rolname, a.privilege_type
--        FROM pg_attribute att
--        JOIN pg_class c ON c.oid = att.attrelid
--        CROSS JOIN LATERAL aclexplode(att.attacl) a
--        JOIN pg_roles r ON r.oid = a.grantee
--       WHERE c.relname = 'tradovate_connections'
--         AND att.attname = 'is_trade_source';
--
-- 7. The token columns are STILL not granted. Step 8 touches one column, but
--    this is the table where that matters, so check it anyway. EXPECT zero
--    rows.
--
--      SELECT att.attname, r.rolname
--        FROM pg_attribute att
--        JOIN pg_class c ON c.oid = att.attrelid
--        CROSS JOIN LATERAL aclexplode(att.attacl) a
--        JOIN pg_roles r ON r.oid = a.grantee
--       WHERE c.relname = 'tradovate_connections'
--         AND att.attname IN ('access_token_encrypted', 'refresh_token_encrypted')
--         AND r.rolname IN ('anon', 'authenticated');
--
-- 8. Nothing was imported by running this file. EXPECT zero.
--
--      SELECT count(*) AS broker_rows FROM trade_plans WHERE source <> 'manual';
--
--
-- THEN, AND ONLY THEN: set TRADOVATE_IMPORT_ENABLED=1 in the Vercel project
-- and redeploy. Until that variable is '1' this migration changes nothing
-- about the running application except what a column list looks like.
--
--
-- ROLLBACK
-- --------
--
-- Steps 1-4, 6 and 8 reverse cleanly, and dropping a column takes its CHECK
-- with it:
--
--   BEGIN;
--     DROP INDEX IF EXISTS idx_trade_plans_broker_trade_key;
--     ALTER TABLE trade_plans
--       DROP COLUMN IF EXISTS source,
--       DROP COLUMN IF EXISTS broker_trade_key,
--       DROP COLUMN IF EXISTS broker_account_id,
--       DROP COLUMN IF EXISTS broker_host,
--       DROP COLUMN IF EXISTS hidden;
--     ALTER TABLE tradovate_connections DROP COLUMN IF EXISTS is_trade_source;
--   COMMIT;
--
-- Step 5 reverses ONLY while no null has been written:
--
--   ALTER TABLE trade_plans
--     ALTER COLUMN strategy        SET NOT NULL,
--     ALTER COLUMN stop_loss       SET NOT NULL,
--     ALTER COLUMN take_profit     SET NOT NULL,
--     ALTER COLUMN rr_ratio        SET NOT NULL,
--     ALTER COLUMN trade_reason    SET NOT NULL,
--     ALTER COLUMN emotional_state SET NOT NULL;
--
-- Once the import has run, that statement fails on the imported rows — which
-- is correct and is the point: those rows have no intent to restore. Unset
-- TRADOVATE_IMPORT_ENABLED first, then delete the imported rows if you really
-- mean to go back:
--
--   DELETE FROM trade_plans WHERE source = 'tradovate';
--
-- That is a destructive statement on a user's journal. It is also exactly
-- reversible by re-running the import for any day the broker still exposes,
-- which on current evidence (§A2, and the 15.10 reading of a live account) may
-- be today only.

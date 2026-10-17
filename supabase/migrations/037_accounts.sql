-- REF-110 Stages 1-2: a trader's broker accounts become rows, and every
-- imported trade points at one.
--
-- Creates ONE table, `accounts`, and adds ONE nullable column to `trade_plans`.
-- Drops nothing, rewrites nothing, and writes no row.
--
-- RUN THIS BY HAND in the Supabase SQL Editor. Nothing in the repo applies
-- migrations.
--
-- NUMBERING: 029 is reserved for rule_violations and setup_images_delete
-- (REF-89) and still has no file; 021 is reserved for the
-- `ai-usage-accounting` branch. 030-036 are applied. 037 is the next number
-- that is neither taken nor reserved, and REF-110 takes it by the decision
-- Imri recorded on 17.10 — REF-113's stop columns, whose investigation had
-- pencilled in 037, move to 038. Do not reuse 029 or 021, and do not let
-- REF-113 land on this number.
--
--
-- RUN THIS FILE **BEFORE** DEPLOYING THE CODE
-- -------------------------------------------
--
-- This is the OPPOSITE of 034's order and the SAME as 036's, for 036's reason:
-- `TRADOVATE_IMPORT_ENABLED` is already '1' in production, so every gate in
-- the Stage 1-2 code opens the moment the deploy lands. There is no window in
-- which the code is live and the flag is still off.
--
--   1. run this file     2. deploy the Stage 1-2 code
--
-- The other order breaks LOUDLY — a PostgREST 42703 on an undefined column,
-- from the account sync, from the import's `account_id`, and from the journal's
-- unlink button — rather than silently. Loud is the point; it is still an
-- outage of three features for however long it takes to notice.
--
-- One line of the Stage 1-2 code is NOT behind the import flag and is worth
-- naming here, because it is the one that would surprise someone: `unlinkPlan`
-- in src/lib/journal/link.ts clears `account_id` alongside the other
-- provenance columns, and it is reached from the browser. It already names
-- 034's columns the same way and for the same reason — an unlink is only
-- reachable on a row the import created — so this file does not change that
-- argument, it extends it by one column.
--
--
-- BEFORE RUNNING IT — SURVEY
-- --------------------------
--
-- supabase/migrations/ does not describe the live database: objects here have
-- been created by hand in the dashboard and leave no trace in the repo (see
-- CLAUDE.md and supabase/README.md). This file was written WITHOUT database
-- access, from the repo's SQL only. Run all five first and read the output.
--
--   -- 1. Does an `accounts` table already exist, under any shape? EXPECT zero
--   --    rows. A non-zero answer means something was created by hand and step
--   --    1's CREATE TABLE IF NOT EXISTS will SKIP SILENTLY, leaving every
--   --    column and constraint below unapplied. Read it before you run.
--   SELECT c.relname, c.relrowsecurity AS rls_on,
--          (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
--     FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relname = 'accounts';
--
--   -- 2. Does trade_plans.account_id already exist? EXPECT zero rows.
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'trade_plans'
--      AND column_name = 'account_id';
--
--   -- 3. The columns this change joins onto, to confirm 034 is applied. EXPECT
--   --    two rows: broker_account_id bigint, broker_host text. If this returns
--   --    nothing, STOP — 034 has not run and nothing below has anything to
--   --    point at.
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'trade_plans'
--      AND column_name IN ('broker_account_id', 'broker_host')
--    ORDER BY column_name;
--
--   -- 4. How many imported rows the backfill pass will eventually have to
--   --    reach, and how many distinct (account, host) pairs they name. Purely
--   --    informational — NOTHING IS BACKFILLED BY THIS FILE, see below.
--   SELECT count(*) AS broker_rows,
--          count(DISTINCT (broker_account_id, broker_host)) AS identities
--     FROM trade_plans
--    WHERE broker_account_id IS NOT NULL;
--
--   -- 5. update_updated_at() must exist before step 7 can attach a trigger to
--   --    it. EXPECT one row. This is 002's failure mode (see 026): the CREATE
--   --    TRIGGER is the only statement in a file that cares, so it fails alone
--   --    and quietly.
--   SELECT p.proname FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'update_updated_at';
--
--
-- WHY EACH CHANGE
-- ---------------
--
-- 1. accounts — one row per account a trader actually has, broker or not.
--
--    The ticket's §A.4 shape. `broker` is a COLUMN rather than a second table
--    because the screen is one list and the filter is one parameter: a manual
--    portfolio and a Tradovate account differ in how they are POPULATED, not
--    in what they ARE. A trader with an Interactive Brokers account and two
--    prop evaluations wants one screen, and they want the IB rows to carry a
--    status and a P&L exactly as the broker rows do.
--
--    `user_id REFERENCES auth.users(id)`, not `profiles(id)`. That follows
--    028 (`notebook_pages`, `setups`) rather than schema.sql, and 028 records
--    the inconsistency rather than resolving it. A new table joining the newer
--    convention is the smaller surprise.
--
-- 2. display_name vs nickname — the E12 boundary, restated for a new table.
--
--    THE BROKER OWNS ONE AND THE TRADER OWNS THE OTHER. `display_name` is
--    whatever `/account/list` called the account and the sync restates it on
--    every pull; `nickname` is the trader's and the sync never touches it. The
--    UI renders `nickname ?? display_name`.
--
--    `display_name` is NOT NULL because an account with no name is an account
--    the screen cannot render, and the broker's `name` is a required field on
--    the documented entity. `nickname` is nullable and the null is the
--    meaning: the trader has not renamed it.
--
--    This is the first BROKER-SUPPLIED FREE TEXT this product stores — every
--    column before it is a number, an enum or the trader's own writing. It is
--    allowed on screen, under the trader's own RLS, and it is never logged.
--    See src/lib/tradovate/account-sync.ts, which counts and never names.
--
-- 3. status — derived by the sync, never typed by a trader.
--
--      seen in this pull   → 'archived' if the broker says archived
--                          → 'closed'   if closed/restricted/readonly/
--                                       futuresDisabled
--                          → 'active'   otherwise;    last_seen_at = NOW()
--      NOT seen            → 'closed';                last_seen_at unchanged
--
--    AND THE ABSENCE BRANCH APPLIES ONLY TO A HOST THAT ANSWERED. `loadBrokerDay`
--    drops a non-mint host whose discovery failed, silently and by design, so
--    "not in the list" on a host that was never asked would mark every account
--    on it closed on the first demo outage. The asymmetry is the same one
--    `BrokerTrade.positionFlat` encodes: a stale `active` is a cosmetic chip, a
--    wrongly-`closed` account moves a trader's portfolio out from under them.
--    Enforced in code — this file only supplies the three values.
--
-- 4. hidden — the trader can hide an account, and can never delete one.
--
--    Same argument as 034 step 4 and a stronger one here: deleting an account
--    row would orphan every trade pointing at it. And HIDING IS A SCREEN
--    PREFERENCE, NOT A DELETE: a hidden account's trades stay in every total.
--    A trader hiding a breached evaluation does not mean "erase that month's
--    P&L from my statistics" (Imri, 17.10). If "exclude from statistics" is
--    ever wanted it is a SECOND flag with a different name, and this column is
--    not it.
--
-- 5. broker_account_id BIGINT + broker_host — the join to `trade_plans`.
--
--    The same two values 034 already stores on every imported row, and for
--    034's reasons: BIGINT because Tradovate account ids are `number` on the
--    wire with no documented bound, and the host beside the id because the id
--    is host-local. Both NULL for a manual portfolio, which is what makes the
--    unique index in step 5 partial.
--
-- 6. trade_plans.account_id — nullable, and the NULL means UNASSIGNED.
--
--    NOT "manual". This is the distinction the whole of Stage 3 rests on: if
--    NULL meant manual, the screen would open showing one portfolio called
--    "ידני" holding the trader's entire pre-REF-110 history, for a portfolio
--    they never created. Pre-existing rows land in an explicit "ללא תיק"
--    bucket the trader assigns from (Imri, 17.10).
--
--    ON DELETE SET NULL and never CASCADE. Deleting an account must never
--    delete trades. It is mostly theoretical — step 4 is why an account row is
--    hidden rather than deleted — and it is the one default that must not be
--    wrong if it ever stops being theoretical.
--
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--
--   - NO DATA BACKFILL. Mapping `(broker_account_id, broker_host) → accounts.id`
--     needs `accounts` rows, which needs a sync to have run, which needs code.
--     So the backfill is a pass on the next sync (account-sync.ts) and not an
--     UPDATE here — which is also what makes this file safe to run before any
--     code ships.
--
--   - NO COLUMN-LEVEL GRANTS, and that is a decision rather than an omission.
--     017's pattern would be the obvious way to stop a trader overwriting
--     `display_name` from the browser, and it would break the importer instead:
--     the import writes this table UNDER THE USER'S OWN SESSION on two of its
--     three paths (§C12), so `authenticated` MUST be able to write
--     `display_name`, `status` and `last_seen_at`. The boundary is enforced in
--     code, exactly as `EXECUTION_FACTS` already enforces it on `trade_plans`.
--     The stricter alternative — a service-role-only sync — buys grant-level
--     enforcement at the cost of reintroducing the service-role write that
--     REF-107 §C12 named as its central risk.
--
--   - NO NEW SECURITY ASSERTION. supabase/queries/security_assertions.sql is
--     invariants-only by design — "nothing here lists the tables… so a new
--     table never makes a query fire on its own" — and its rules 1, 2 and 3
--     already cover this table the moment it exists: RLS off fires rule 1, RLS
--     on with no policy fires rule 2, and a policy missing its TO clause (or
--     naming anon) fires rule 3. Steps 2 and 3 below are written to pass all
--     three. `accounts` is deliberately NOT added to 6b's never-list either:
--     that list is for SERVER-ONLY tables, and this one is read and written by
--     the browser under RLS.
--
--
-- IDEMPOTENT. Every statement is `IF NOT EXISTS`, a drop-then-create of an
-- object this file owns, or `CREATE OR REPLACE TRIGGER`. Safe to re-run. One
-- transaction, so a failure anywhere leaves the database exactly as it was.
--
-- READ SURVEY 1 BEFORE RE-RUNNING. `CREATE TABLE IF NOT EXISTS` skips the
-- whole table definition when a table of that name exists, however different
-- its shape — the one statement here whose idempotence is a silent skip rather
-- than a convergence.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. accounts
--
-- Two CHECKs, and the second one is the one that is easy to leave out.
--
-- `accounts_broker_identity_check` ties the two broker columns to the `broker`
-- value: a Tradovate row must carry both, a manual row must carry neither.
-- Without it the partial UNIQUE in step 5 does not actually promise
-- uniqueness — a Tradovate row with a NULL `broker_host` would be indexed
-- (`broker_account_id` is not null, so the predicate holds) and Postgres treats
-- NULLs in a unique index as DISTINCT, so two such rows coexist happily. The
-- code always writes both columns; this is what makes that a fact about the
-- database rather than a fact about the code.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  broker             TEXT NOT NULL
                       CHECK (broker IN ('tradovate', 'manual')),
  -- NULL for a manual portfolio. BIGINT — see the header.
  broker_account_id  BIGINT,
  broker_host        TEXT
                       CHECK (broker_host IN ('live', 'demo')),

  -- The broker's name for it, restated on every sync. The trader's own label
  -- for a manual portfolio, written once when they create it.
  display_name       TEXT NOT NULL,
  -- The trader's. The sync never touches it. Overrides display_name when set.
  nickname           TEXT,

  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'closed', 'archived')),
  -- Hide the card, keep the trades in every total. See the header.
  hidden             BOOLEAN NOT NULL DEFAULT false,

  -- Never restated once written. `last_seen_at` is restated on every pull that
  -- sees the account, and is deliberately NOT moved when an account goes
  -- missing — it is the answer to "when did I last trade this firm".
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT accounts_broker_identity_check CHECK (
    (broker = 'tradovate' AND broker_account_id IS NOT NULL AND broker_host IS NOT NULL)
    OR
    (broker = 'manual'    AND broker_account_id IS NULL     AND broker_host IS NULL)
  )
);


-- ---------------------------------------------------------------------------
-- 2. RLS, stated.
--
-- The `ensure_rls` event trigger would turn this on by itself — it is why
-- several tables in this database are not wide open — and a migration should
-- say what it means rather than rely on a trigger that is not in any
-- migration. 028's rule, and supabase/README.md's.
-- ---------------------------------------------------------------------------

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- 3. accounts_owner — the one policy.
--
-- `TO authenticated` is load-bearing and is the whole of 023: a policy with no
-- TO clause applies to PUBLIC, which includes `anon`, and the omission is
-- INVISIBLE in the CREATE POLICY text. That is exactly how the setup-images
-- hole passed review sitting beside a correct policy in the same file. Rule 3
-- of supabase/queries/security_assertions.sql is what catches it; this is
-- written so that rule never fires.
--
-- Drop-then-create rather than `IF NOT EXISTS` (which CREATE POLICY does not
-- have), so a re-run replaces this file's own policy instead of failing on it.
--
-- WITH CHECK as well as USING: USING filters what a statement may SEE, WITH
-- CHECK constrains what it may WRITE. Without the second, a trader could
-- insert a row carrying someone else's `user_id` — which they could not then
-- read, and which would sit in another trader's account list.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "accounts_owner" ON accounts;
CREATE POLICY "accounts_owner" ON accounts
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 4. The screen's index.
--
-- (user_id, status) — "my accounts, grouped by whether they are live" is the
-- only query the "התיקים שלי" screen makes.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_accounts_user_status
  ON accounts (user_id, status);


-- ---------------------------------------------------------------------------
-- 5. One broker account, one row — and the reason the sync is not an upsert.
--
-- PARTIAL, on `WHERE broker_account_id IS NOT NULL`, because manual rows all
-- have NULL there and a trader may have several.
--
-- AND THEREFORE THE SYNC CANNOT USE `upsert()`. PostgREST's
-- `upsert(..., { onConflict })` compiles to `ON CONFLICT (cols) DO UPDATE`, and
-- POSTGRES CANNOT INFER A PARTIAL INDEX FROM A BARE COLUMN LIST — inference
-- requires the statement to repeat the index's predicate, which PostgREST has
-- no way to express. Against this index an upsert fails with "no unique or
-- exclusion constraint matching the ON CONFLICT specification". So
-- account-sync.ts reads, then inserts the new and updates the changed, and
-- catches 23505 from a concurrent insert — the same shape, and the same
-- reason, as `importBrokerTrades` against 034's index. Written here because
-- this is where someone will be when they lose a day to that error message.
--
-- `broker` is in the key although `broker_account_id IS NOT NULL` already
-- implies `broker = 'tradovate'` under step 1's CHECK. It costs nothing and it
-- means a second broker (REF-107 Stage 6) reusing an account id cannot collide
-- with a Tradovate one.
--
-- NOT `CONCURRENTLY`: that cannot run inside a transaction and this file is one
-- transaction on purpose. The table is empty, so the lock is nothing.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_broker_identity
  ON accounts (user_id, broker, broker_account_id, broker_host)
  WHERE broker_account_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 6. trade_plans.account_id — every trade carries an account.
--
-- Nullable, and the NULL means UNASSIGNED rather than manual. See the header.
--
-- The index is (user_id, account_id) and not (account_id): every query this
-- product makes against trade_plans is already filtered by user, so a
-- single-column index would be the second-best half of this one.
-- ---------------------------------------------------------------------------

ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_trade_plans_account
  ON trade_plans (user_id, account_id);


-- ---------------------------------------------------------------------------
-- 7. updated_at.
--
-- `CREATE OR REPLACE TRIGGER` (PG14+, and Supabase is well past it) rather
-- than plain CREATE, so a re-run converges instead of raising "trigger already
-- exists". 026 is the file that explains why that matters, and survey query 5
-- is 026's lesson as a precondition: this is the only statement here that
-- depends on update_updated_at(), so without the function it would fail alone.
-- Inside one transaction it cannot fail alone — it takes the file with it,
-- which is the better outcome and is why the survey asks.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TRIGGER accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ---------------------------------------------------------------------------
-- 8. No GRANT belongs here.
--
-- `accounts` is a new table in `public`, so it takes Supabase's default
-- privileges for `authenticated` under the RLS policy in step 3 — which is the
-- same arrangement `trade_plans`, `setups` and `notebook_pages` run under, and
-- is what the sync needs (see the header on why column grants would break the
-- importer rather than the trader).
--
-- `trade_plans.account_id` likewise: that table uses no column-level grants, so
-- a new column on it is readable and writable by its owner the moment it
-- exists. 034 step 7 and 036 step 3 say the same thing at more length.
-- ---------------------------------------------------------------------------

COMMIT;


-- ===========================================================================
-- VERIFY (read-only, after COMMIT)
-- ===========================================================================
--
-- 1. The table's shape. EXPECT thirteen rows, and specifically:
--    display_name NO-null no default; nickname YES-null; status NO-null
--    default 'active'; hidden NO-null default false; broker_account_id
--    YES-null; the four timestamps NO-null default now().
--
--      SELECT column_name, data_type, is_nullable, column_default
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'accounts'
--       ORDER BY ordinal_position;
--
-- 2. The three CHECKs. EXPECT accounts_broker_check (or whatever Postgres
--    named the inline one), accounts_broker_host_check, accounts_status_check
--    and accounts_broker_identity_check — four, counting the named one.
--
--      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
--        FROM pg_constraint c
--       WHERE c.conrelid = 'public.accounts'::regclass AND c.contype = 'c'
--       ORDER BY c.conname;
--
-- 3. RLS is ON and there is exactly one policy, scoped to `authenticated`.
--    EXPECT rls_on = true, one row, roles = {authenticated}. If roles comes
--    back as {0} or contains `anon`, step 3 did not land and
--    security_assertions.sql rule 3 will fire tomorrow morning.
--
--      SELECT c.relrowsecurity AS rls_on,
--             p.polname,
--             (SELECT array_agg(r.rolname) FROM pg_roles r
--               WHERE r.oid = ANY (p.polroles)) AS roles,
--             pg_get_expr(p.polqual,      p.polrelid) AS using_expr,
--             pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
--        FROM pg_class c
--        LEFT JOIN pg_policy p ON p.polrelid = c.oid
--       WHERE c.oid = 'public.accounts'::regclass;
--
-- 4. Both indexes, and the unique one IS partial. EXPECT two rows, and the
--    `idx_accounts_broker_identity` definition must end in
--    `WHERE (broker_account_id IS NOT NULL)`. A missing WHERE means something
--    created a non-partial index first and step 5's IF NOT EXISTS skipped it.
--
--      SELECT indexname, indexdef
--        FROM pg_indexes
--       WHERE schemaname = 'public' AND tablename = 'accounts'
--       ORDER BY indexname;
--
-- 5. The column on trade_plans, its FK, and its index. EXPECT one row from
--    each; the FK's delete rule must be SET NULL ('n'), never CASCADE ('c').
--
--      SELECT column_name, data_type, is_nullable
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'trade_plans'
--         AND column_name = 'account_id';
--
--      SELECT conname, confdeltype, pg_get_constraintdef(oid) AS definition
--        FROM pg_constraint
--       WHERE conrelid = 'public.trade_plans'::regclass AND contype = 'f'
--         AND pg_get_constraintdef(oid) LIKE '%account_id%';
--
--      SELECT indexname, indexdef FROM pg_indexes
--       WHERE schemaname = 'public' AND tablename = 'trade_plans'
--         AND indexname = 'idx_trade_plans_account';
--
-- 6. Nothing was written and nothing was assigned. EXPECT zero and zero.
--
--      SELECT count(*) AS accounts_rows FROM accounts;
--      SELECT count(*) AS assigned_trades FROM trade_plans WHERE account_id IS NOT NULL;
--
-- 7. The identity CHECK really refuses a half-stated Tradovate row. Both
--    statements are rolled back; the point is which one errors. EXPECT: the
--    first succeeds, the second fails on accounts_broker_identity_check.
--
--      BEGIN;
--        INSERT INTO accounts (user_id, broker, broker_account_id, broker_host, display_name)
--        SELECT id, 'tradovate', 1, 'demo', 'x' FROM auth.users LIMIT 1;
--      ROLLBACK;
--
--      BEGIN;
--        INSERT INTO accounts (user_id, broker, broker_account_id, broker_host, display_name)
--        SELECT id, 'tradovate', 1, NULL, 'x' FROM auth.users LIMIT 1;
--      ROLLBACK;
--
-- 8. The updated_at trigger fires. Rolled back. EXPECT changed = true.
--
--      BEGIN;
--        INSERT INTO accounts (user_id, broker, display_name, updated_at)
--        SELECT id, 'manual', 'x', '2000-01-01T00:00:00Z' FROM auth.users LIMIT 1;
--        UPDATE accounts SET nickname = 'y' WHERE display_name = 'x';
--        SELECT updated_at > '2001-01-01T00:00:00Z' AS changed
--          FROM accounts WHERE display_name = 'x';
--      ROLLBACK;
--
-- 9. The standing security assertions still come back clean. Run
--    supabase/queries/security_assertions.sql — specifically rules 1, 2 and 3,
--    which are what cover a new table. EXPECT the usual two query-9 rows for
--    setup-images and nothing naming `accounts`.
--
--
-- THEN deploy the Stage 1-2 code. `TRADOVATE_IMPORT_ENABLED` is already '1' in
-- production, so accounts start being recorded on the first sync or the first
-- nightly cron run after the deploy — and the backfill pass points the
-- existing imported rows at them on that same run.
--
--
-- ROLLBACK
-- --------
--
-- Clean, and loses only what the sync recorded. No trade data lives in either
-- object: `trade_plans.account_id` is a pointer, and every imported row keeps
-- its own `broker_account_id` and `broker_host`, which is what the backfill
-- rebuilds the pointer FROM. So this is reversible and then re-appliable, and
-- the second sync after a re-apply puts everything back.
--
--   BEGIN;
--     DROP INDEX IF EXISTS idx_trade_plans_account;
--     ALTER TABLE trade_plans DROP COLUMN IF EXISTS account_id;
--     DROP TABLE IF EXISTS accounts;      -- takes its policy, indexes and trigger
--   COMMIT;
--
-- The column must go BEFORE the table: the FK would otherwise refuse the DROP,
-- and `DROP TABLE … CASCADE` would silently take the column with it, which is
-- the same outcome reached without saying so.
--
-- What is NOT recoverable by a re-apply: a `nickname` a trader typed and the
-- `hidden` flags they set. Those are the two columns no sync restates — they
-- are the trader's, which is the whole point of them — so there is nothing to
-- rebuild them from. Nothing holds them today, and that is the only reason
-- this rollback is listed as clean.

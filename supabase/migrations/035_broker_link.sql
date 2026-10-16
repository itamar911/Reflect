-- REF-107 Stage 3a: a broker trade and the plan behind it become ONE row.
--
-- Adds two bookkeeping columns to `trade_plans` and one function that performs
-- the merge atomically. Creates no table, drops no column, and writes no row.
--
-- RUN THIS BY HAND in the Supabase SQL Editor. Nothing in the repo applies
-- migrations.
--
-- NUMBERING: 029 is reserved for rule_violations and setup_images_delete
-- (REF-89) and still has no file; 021 is reserved for the
-- `ai-usage-accounting` branch. 030-034 are applied — 034 was run by Imri on
-- 15.10 and the import has been live since. 035 is the next number that is
-- neither taken nor reserved. Do not reuse 029 or 021.
--
--
-- DEPLOY ORDER: THIS FILE IS SAFE TO RUN AT ANY TIME, AND NOTHING CALLS IT YET
-- ---------------------------------------------------------------------------
--
-- Stage 3a ships the schema and nothing that uses it. No line of application
-- code names `link_confirmed_at`, `link_method` or `link_broker_trade()` —
-- the matcher that writes them and the confirmation screen that calls the
-- function are Stage 3b. So the deploy order has no constraint here: run this
-- before Stage 3b's code, in any order relative to 036, and the running
-- application does not change.
--
-- That is deliberate and is why this file is split out. 034 had a hard
-- ordering (deploy, migrate, then set the flag) because its columns were named
-- the moment the flag went on. This one has none, which makes it the cheapest
-- thing in Stage 3 to get out of the way.
--
--
-- BEFORE RUNNING IT — SURVEY
-- --------------------------
--
-- supabase/migrations/ does not describe the live database: objects here have
-- been created by hand in the dashboard and leave no trace in the repo (see
-- CLAUDE.md and supabase/README.md). This file was written WITHOUT database
-- access, from the repo's SQL only. Run all four of these first and read the
-- output.
--
--   -- 1. Do this file's columns already exist? EXPECT zero rows on a first run.
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'trade_plans'
--      AND column_name IN ('link_confirmed_at', 'link_method')
--    ORDER BY column_name;
--
--   -- 2. Does the function already exist, and with what signature? A re-run
--   --    REPLACEs it, so an existing one with DIFFERENT argument types would
--   --    be left behind as a second overload rather than replaced. EXPECT
--   --    zero rows on a first run; if there is a row, read its arguments.
--   SELECT p.oid::regprocedure::text AS signature,
--          p.prosecdef              AS security_definer,
--          p.proconfig              AS settings
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'link_broker_trade';
--
--   -- 3. 034's columns are all present. This file assumes every one of them.
--   --    EXPECT five rows.
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'trade_plans'
--      AND column_name IN ('source', 'broker_trade_key', 'broker_account_id',
--                          'broker_host', 'hidden')
--    ORDER BY column_name;
--
--   -- 4. How many rows are candidates for linking today — imported rows with
--   --    no plan behind them. Informational: it is the size of the queue the
--   --    Stage 3b confirmation screen will show.
--   SELECT count(*) AS unplanned_broker_rows
--     FROM trade_plans
--    WHERE source = 'tradovate' AND unplanned IS TRUE AND hidden IS NOT TRUE;
--
--
-- WHY EACH CHANGE
-- ---------------
--
-- 1. link_confirmed_at — WHEN the question was settled, and NULL means it has
--    not been. That is the whole state machine, and it is deliberately derived
--    rather than stored as an enum:
--
--      source      unplanned  link_confirmed_at   meaning
--      ----------  ---------  ------------------  --------------------------
--      tradovate   false      not null            linked to a plan
--      tradovate   true       NULL                IN THE QUEUE
--      tradovate   true       not null            trader said: not planned
--      manual      false      NULL                an ordinary plan
--
--    A separate `link_state` column would be a fourth thing that can disagree
--    with the three that already exist. A timestamp cannot: it is either set
--    or it is not, and "when" is a question the trader may well ask.
--
-- 2. link_method — WHO settled it. `auto` is the matcher, `confirmed` and
--    `declined` are the trader. Not derivable from anything else, and it is
--    the column that makes a bad automatic match auditable after the fact:
--    "show me every row the matcher linked by itself" is one predicate.
--
--    NO DEFAULT, and nullable. A row that has never been through the matcher
--    has no method, and inventing one would make the queue look settled.
--
-- 3. link_broker_trade() — the merge, in one transaction.
--
--    THIS IS THE ONLY PART OF STAGE 3 THAT CANNOT BE DONE FROM THE CLIENT, and
--    the reason is the partial UNIQUE index 034 created. `broker_trade_key`
--    cannot sit on two rows of the same user, so moving it from the broker row
--    to the plan is three statements in a forced order — clear, set, delete —
--    and PostgREST has no transaction. A failure between the first and the
--    third leaves a trade with no row at all.
--
--    SECURITY DEFINER IS FOR THE TRANSACTION AND FOR NOTHING ELSE. It does not
--    widen what the caller may touch: the body checks `auth.uid()` against the
--    `user_id` of BOTH rows before it writes, so a caller can only merge two
--    rows they already own. That check is not decoration — without it this
--    function would be a hole straight through the RLS policy it exists to
--    respect, callable by any authenticated user against any two row ids.
--
--    See §C of the Stage 3 investigation for why a merge and not a reference
--    column: two rows for one trade double the journal, the calendar, the
--    stats, the dashboard and `max_daily_trades`, and the eleven readers that
--    would each have to learn about the link do not know about it.
--
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--
--   - No index on `link_confirmed_at`. The queue query is
--     `source = 'tradovate' AND unplanned AND link_confirmed_at IS NULL`, and
--     at Stage 3 volumes (tens of rows per user) it rides the existing
--     user_id path. Revisit with Stage 5's thousands, where a partial index on
--     `(user_id) WHERE link_confirmed_at IS NULL` is the likely shape.
--   - No UNDO function. Unlinking is a plain UPDATE the owner can make under
--     their own RLS — clear the key, the method and the timestamp — and the
--     next sync re-imports the broker row because the key is free again. See
--     the ROLLBACK section.
--   - No change to the six intent columns, to `hidden`, or to the UNIQUE
--     index. 034 owns all three.
--
--
-- IDEMPOTENT. Both columns are `IF NOT EXISTS`, the CHECK is a drop-then-add
-- of a constraint this file owns, and the function is `CREATE OR REPLACE`.
-- Safe to re-run. One transaction, so a failure anywhere leaves the table
-- exactly as it was.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. trade_plans.link_confirmed_at
--
-- Nullable with no default, and the null is the meaning: nobody has settled
-- this row. Every row that exists today is therefore in the state "not
-- settled", which for a manual plan is correct and permanent — a manual plan
-- is never in the link queue, because the queue is filtered on
-- `source = 'tradovate'`.
-- ---------------------------------------------------------------------------

ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS link_confirmed_at TIMESTAMPTZ;


-- ---------------------------------------------------------------------------
-- 2. trade_plans.link_method
--
-- The CHECK is dropped and re-added rather than created inline, so a re-run
-- replaces this file's own constraint instead of failing on it — the same
-- pattern 034 uses for `source` and `broker_host`, and for the same reason.
--
-- The three values are closed on purpose. A fourth would mean a new way for a
-- row to leave the queue, and that is a product decision, not a string.
-- ---------------------------------------------------------------------------

ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS link_method TEXT;

ALTER TABLE trade_plans
  DROP CONSTRAINT IF EXISTS trade_plans_link_method_check;
ALTER TABLE trade_plans
  ADD CONSTRAINT trade_plans_link_method_check
  CHECK (link_method IN ('auto', 'confirmed', 'declined'));


-- ---------------------------------------------------------------------------
-- 3. link_broker_trade() — the merge.
--
-- Copies the thirteen EXECUTION_FACTS (src/lib/tradovate/import.ts) and
-- `broker_trade_key` from the broker row onto the plan, marks the plan as
-- planned-and-settled, and deletes the broker row. One transaction.
--
-- Thirteen plus one, and the one is the key: `source`, `broker_account_id` and
-- `broker_host` are already members of EXECUTION_FACTS, so the only identity
-- column the list does not carry is the key itself — which is also the only
-- one the UNIQUE index constrains, hence the three-write dance below.
--
-- THE ORDER OF THE THREE WRITES IS FORCED by the partial UNIQUE index: the
-- broker row must give up `broker_trade_key` before the plan can take it.
-- Doing it as DELETE-then-UPDATE would also satisfy the index, but it throws
-- away the source row before the destination has been written — and if the
-- UPDATE then fails, the trade is gone. Clearing first keeps both rows alive
-- until the plan is correct.
--
-- WHAT IT DOES NOT COPY: not one intent column. `strategy`, `stop_loss`,
-- `take_profit`, `rr_ratio`, `trade_reason`, `emotional_state`, the four
-- discipline flags, the notes and the debrief all stay exactly as the trader
-- wrote them on the plan. That is the entire point of linking rather than
-- importing — the broker supplies what happened, the trader supplied what
-- they meant — and it is the same list `EXECUTION_FACTS` draws in code, where
-- the regression suite asserts a trader-edited `strategy` survives a re-import.
--
-- `pnl_amount` is not copied either, for the reason stated in import.ts: it is
-- points x units x point value, a figure a broker row has no honest inputs
-- for, and `tradeMoneyPnl` prefers `actual_pnl` anyway.
--
-- SET search_path: pinned to a literal, so a caller cannot shadow `trade_plans`
-- with a table of their own in a schema earlier on the path. Mandatory for any
-- SECURITY DEFINER function and checked by rule 10 of
-- supabase/queries/security_assertions.sql.
--
-- EXECUTE is granted to `authenticated` ONLY, and REVOKEd from PUBLIC first.
-- A function's Postgres default is EXECUTE TO PUBLIC, which here would mean
-- `anon` could call it; the REVOKE is what makes the grant meaningful and is
-- what 024 and 027 were cleaning up across the schema. Rule 5 of
-- security_assertions.sql fires if this is ever undone.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.link_broker_trade(
  plan_id       UUID,
  broker_row_id UUID,
  method        TEXT DEFAULT 'confirmed'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller UUID := auth.uid();
  broker trade_plans%ROWTYPE;
  plan   trade_plans%ROWTYPE;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'link_broker_trade: no authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  IF method NOT IN ('auto', 'confirmed') THEN
    RAISE EXCEPTION 'link_broker_trade: method must be auto or confirmed'
      USING ERRCODE = '22023';
  END IF;

  -- BOTH ROWS, BOTH OWNED BY THE CALLER. The `user_id` predicate is on each
  -- SELECT rather than checked afterwards, so a row belonging to somebody else
  -- is simply not found — the function cannot report whether it exists.
  --
  -- FOR UPDATE on both: two confirmations of the same broker row racing each
  -- other would otherwise both read it, both clear it, and both try to take
  -- the key. The lock makes the second wait and then find nothing.
  SELECT * INTO broker FROM trade_plans
   WHERE id = broker_row_id AND user_id = caller
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'link_broker_trade: broker row not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO plan FROM trade_plans
   WHERE id = plan_id AND user_id = caller
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'link_broker_trade: plan not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Guards against linking the wrong KINDS of row together. Each one is a
  -- programming error in the caller, not something a trader can do from the
  -- confirmation screen, and each would corrupt a journal quietly.
  IF broker.source <> 'tradovate' OR broker.broker_trade_key IS NULL THEN
    RAISE EXCEPTION 'link_broker_trade: source row is not an imported trade'
      USING ERRCODE = '22023';
  END IF;

  IF plan.source <> 'manual' THEN
    RAISE EXCEPTION 'link_broker_trade: target row is not a manual plan'
      USING ERRCODE = '22023';
  END IF;

  IF plan.id = broker.id THEN
    RAISE EXCEPTION 'link_broker_trade: cannot link a row to itself'
      USING ERRCODE = '22023';
  END IF;

  -- Write 1 of 3: the broker row gives up the key, so the index lets the plan
  -- take it. The row still exists and still holds every fact.
  UPDATE trade_plans
     SET broker_trade_key = NULL
   WHERE id = broker.id AND user_id = caller;

  -- Write 2 of 3: the plan takes the facts and the identity.
  --
  -- The thirteen EXECUTION_FACTS are the first block; `source` is one of them
  -- and is what makes the merged row read as a broker row afterwards (deletes
  -- become hides, the detail modal shows a provenance line). Then the key,
  -- then the link bookkeeping.
  UPDATE trade_plans
     SET source            = broker.source,
         broker_account_id = broker.broker_account_id,
         broker_host       = broker.broker_host,
         symbol            = broker.symbol,
         direction         = broker.direction,
         entry_price       = broker.entry_price,
         exit_price        = broker.exit_price,
         quantity          = broker.quantity,
         actual_pnl        = broker.actual_pnl,
         pnl_currency      = broker.pnl_currency,
         submitted_at      = broker.submitted_at,
         closed_at         = broker.closed_at,
         status            = broker.status,
         broker_trade_key  = broker.broker_trade_key,
         unplanned         = false,
         link_confirmed_at = now(),
         link_method       = method
   WHERE id = plan.id AND user_id = caller;

  -- Write 3 of 3. A hard DELETE and not `hidden = true`, and §A of the
  -- investigation argues the case: a hidden row that kept the key would
  -- collide with the plan that now holds it, and `skippedHidden` would stop
  -- meaning "the trader deleted this". Undo is instead "clear the key and let
  -- the next sync re-import" — the key is deterministic, so the row that comes
  -- back is the same row.
  DELETE FROM trade_plans WHERE id = broker.id AND user_id = caller;
END;
$$;

REVOKE ALL ON FUNCTION public.link_broker_trade(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_broker_trade(UUID, UUID, TEXT) TO authenticated;

COMMIT;


-- ===========================================================================
-- VERIFY (read-only, after COMMIT)
-- ===========================================================================
--
-- 1. The two columns, with the right nullability. EXPECT two rows, both
--    YES-null, both with no default.
--
--      SELECT column_name, data_type, is_nullable, column_default
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'trade_plans'
--         AND column_name IN ('link_confirmed_at', 'link_method')
--       ORDER BY column_name;
--
-- 2. The CHECK exists and names the three values. EXPECT one row.
--
--      SELECT conname, pg_get_constraintdef(oid) AS definition
--        FROM pg_constraint
--       WHERE conrelid = 'public.trade_plans'::regclass
--         AND conname = 'trade_plans_link_method_check';
--
-- 3. The function exists, IS SECURITY DEFINER, and HAS a pinned search_path.
--    EXPECT one row: security_definer = t, settings containing
--    `search_path=public, pg_temp`. A null in `settings` is the finding —
--    that is rule 10 of security_assertions.sql.
--
--      SELECT p.oid::regprocedure::text AS signature,
--             p.prosecdef              AS security_definer,
--             p.proconfig              AS settings
--        FROM pg_proc p
--        JOIN pg_namespace n ON n.oid = p.pronamespace
--       WHERE n.nspname = 'public' AND p.proname = 'link_broker_trade';
--
-- 4. EXECUTE is granted to `authenticated` and NOT to PUBLIC. EXPECT exactly
--    one row, rolname = authenticated. A row with an empty rolname is PUBLIC
--    and means the REVOKE did not take.
--
--      SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, a.privilege_type
--        FROM pg_proc p
--        JOIN pg_namespace n ON n.oid = p.pronamespace
--        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
--        LEFT JOIN pg_roles r ON r.oid = a.grantee
--       WHERE n.nspname = 'public' AND p.proname = 'link_broker_trade';
--
-- 5. Only one overload exists. EXPECT one row. Two rows mean survey query 2
--    found an older signature and this file added a second rather than
--    replacing it — drop the old one by its exact signature.
--
--      SELECT count(*) AS overloads
--        FROM pg_proc p
--        JOIN pg_namespace n ON n.oid = p.pronamespace
--       WHERE n.nspname = 'public' AND p.proname = 'link_broker_trade';
--
-- 6. Nothing was linked by running this file. EXPECT zero for both.
--
--      SELECT count(*) FILTER (WHERE link_confirmed_at IS NOT NULL) AS settled,
--             count(*) FILTER (WHERE link_method IS NOT NULL)       AS methoded
--        FROM trade_plans;
--
-- 7. The function refuses a caller who owns neither row. Run this as an
--    ORDINARY USER from the browser, not here — the SQL editor runs as a
--    superuser and `auth.uid()` is null, so here it raises 28000 instead,
--    which is itself the first assertion worth seeing:
--
--      SELECT public.link_broker_trade(
--        '00000000-0000-0000-0000-000000000001'::uuid,
--        '00000000-0000-0000-0000-000000000002'::uuid);
--      -- EXPECT: ERROR 28000, "no authenticated caller".
--
--
-- NOTHING TO SET AFTERWARDS. Unlike 034, no environment variable turns this
-- on: no application code calls the function or names the columns until Stage
-- 3b ships. Running this file changes what a column list looks like and
-- nothing else.
--
--
-- ROLLBACK
-- --------
--
-- Clean, as long as nothing has been linked yet:
--
--   BEGIN;
--     DROP FUNCTION IF EXISTS public.link_broker_trade(UUID, UUID, TEXT);
--     ALTER TABLE trade_plans
--       DROP COLUMN IF EXISTS link_confirmed_at,
--       DROP COLUMN IF EXISTS link_method;
--   COMMIT;
--
-- Dropping the columns takes the CHECK with them.
--
-- ROLLING BACK AFTER ROWS HAVE BEEN LINKED DOES NOT UNDO THE MERGES. The
-- merged rows keep the broker's facts and the broker rows are gone; dropping
-- the two columns only removes the record of HOW they got that way. To undo
-- one merge, unlink it first and let the next sync re-import — the key is
-- deterministic, so the row that comes back is the row that was deleted:
--
--   UPDATE trade_plans
--      SET broker_trade_key  = NULL,
--          link_confirmed_at = NULL,
--          link_method       = NULL,
--          unplanned         = true
--    WHERE id = '<the merged row>';
--
-- That leaves the trader's intent on the row and hands the execution facts
-- back to the importer. It is a statement the owner can run themselves under
-- their own RLS, which is why there is no function for it.

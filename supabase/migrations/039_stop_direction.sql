-- REF-113 Stage 5: a widening is a different rule from a move, and a link
-- must stop throwing the stop evidence away.
--
-- TWO INDEPENDENT STEPS. Either can be run without the other, and the file is
-- written so that reading one does not require understanding the other:
--
--   1. custom_rules.condition_type gains 'moved_sl_widened_last_trade'.
--   2. link_broker_trade() carries the three columns migration 038 added
--      (plus the two self-report booleans) onto the plan instead of deleting
--      them with the broker row.
--
-- RUN THIS BY HAND in the Supabase SQL Editor. Nothing in the repo applies
-- migrations.
--
-- NUMBERING: 029 is reserved for rule_violations and setup_images_delete
-- (REF-89) and still has no file; 021 is reserved for the
-- `ai-usage-accounting` branch. 038 is REF-113 Stage 1's `broker_stops`. 039
-- is the next number that is neither taken nor reserved. Do not reuse 029 or
-- 021.
--
--
-- ORDER RELATIVE TO THE DEPLOY
-- ----------------------------
--
-- EITHER ORDER IS SAFE, which is the one respect in which this is easier than
-- 038. Neither step adds a column anything SELECTs, so there is no 42703 in
-- any direction.
--
--   - Step 1 BEFORE the deploy and nothing happens: no code writes the new
--     condition value yet.
--   - Step 1 AFTER the deploy and the rules editor offers a condition the
--     database refuses, with a 23514 on save. LOUD, and visible to exactly one
--     person — whoever tries to create that rule. Nothing else breaks: the
--     evaluator simply never sees a row with that value, so every existing
--     rule behaves identically.
--   - Step 2 is a function body. Running it early changes what a link copies
--     for callers that have no such columns to copy, which on a database where
--     038 has run is a no-op and on one where it has not would fail to compile
--     — so 038 IS A PREREQUISITE OF STEP 2 and of nothing else here.
--
-- Preferred: run this file, then deploy.
--
--
-- BEFORE RUNNING IT — SURVEY
-- --------------------------
--
-- supabase/migrations/ does not describe the live database: objects here have
-- been created by hand in the dashboard and leave no trace in the repo (see
-- CLAUDE.md and supabase/README.md). Read all five and read the output.
--
--   -- 1. The constraint step 1 replaces. EXPECT exactly one row, whose
--   --    definition lists the EIGHT values of migration 015 and NOT the new
--   --    one. If the name is not `custom_rules_condition_type_check`, note
--   --    what it IS — step 1 drops it by that name.
--   SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
--     FROM pg_constraint c
--    WHERE c.conrelid = 'public.custom_rules'::regclass
--      AND c.contype = 'c'
--      AND pg_get_constraintdef(c.oid) LIKE '%condition_type%';
--
--   -- 2. Nothing already carries the new value, under any constraint. EXPECT
--   --    zero. A non-zero means somebody created it by hand and the DROP/ADD
--   --    below would still succeed — this is informational, not a blocker.
--   SELECT count(*) AS already_widened FROM custom_rules
--    WHERE condition_type = 'moved_sl_widened_last_trade';
--
--   -- 3. How many rules the narrow condition would be an alternative TO, and
--   --    how many of those can block a day. Purely informational, and worth
--   --    writing down: these rules are NOT changed by this file and keep
--   --    firing on every move, including a tightening.
--   SELECT count(*)                                            AS moved_sl_rules,
--          count(*) FILTER (WHERE action_type = 'block_day')   AS can_block_a_day,
--          count(*) FILTER (WHERE is_active)                   AS active
--     FROM custom_rules WHERE condition_type = 'moved_sl_last_trade';
--
--   -- 4. Step 2's prerequisite: 038 has run. EXPECT three rows. If this
--   --    returns fewer, STOP — run 038 first, or run step 1 alone.
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'trade_plans'
--      AND column_name IN ('broker_stop_loss', 'broker_take_profit', 'stop_history')
--    ORDER BY column_name;
--
--   -- 5. The function step 2 replaces, so that its current definition is in
--   --    front of you before it is overwritten. COPY THE OUTPUT SOMEWHERE
--   --    before running the file: the body below was written from
--   --    supabase/migrations/035_broker_link.sql, and if the live function has
--   --    been edited by hand since, this file would silently revert that edit.
--   SELECT pg_get_functiondef(p.oid)
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'link_broker_trade';
--
--
-- WHY EACH STEP
-- -------------
--
-- 1. 'moved_sl_widened_last_trade' — A SECOND CONDITION, NOT A REPLACEMENT.
--
--    `moved_sl_last_trade` fires on any stop move, and the product decision of
--    19.10 is that moving a stop TOWARD the profit is risk management rather
--    than a discipline failure: a trader who pulls their stop to breakeven is
--    doing the thing this product is for. The score stopped charging twelve
--    points for it (src/lib/scoring/tradeScore.ts).
--
--    THE RULE DID NOT, AND DELIBERATELY. A trader who created
--    `moved_sl_last_trade` asked for every move, in those words, and that rule
--    can be `block_day` — silently narrowing what it means would change what
--    locks them out of the app tomorrow, on a rule they did not edit. So the
--    broad condition is untouched and keeps its behaviour, and the narrow one
--    is a separate row a trader opts into. Survey 3 counts who is affected by
--    that choice: nobody.
--
--    IT READS `stop_history.direction`, so it can only ever fire on a
--    Tradovate row — a self-report is one boolean and cannot say which way the
--    stop went. On a manual close it is false, and false is the permissive
--    answer on purpose: a wrong `true` on a `block_day` rule locks a trader
--    out over something they did not do, and a wrong `false` silences one rule
--    quietly. Between those two, silence.
--
--    DROP AND RE-ADD RATHER THAN `ADD CONSTRAINT ... NOT VALID`. The set is a
--    closed enumeration and the new one is a widening of it, so every existing
--    row already satisfies it and the validation scan is over a table with a
--    handful of rows per user. `NOT VALID` would leave a constraint that does
--    not mean what it says.
--
-- 2. link_broker_trade() — THE HOLE STAGE 5 EXPOSED, AND IT IS A REAL ONE.
--
--    The function copies the thirteen EXECUTION_FACTS onto the plan and then
--    DELETES the broker row. The three columns 038 added are not among the
--    thirteen — 038 came after 035 — so confirming a link throws the broker's
--    stop evidence away. Follow what happens next:
--
--      - the merged row reads `stop_history IS NULL`, which puts it straight
--        back into the import's candidate pool;
--      - if the trader confirms on the SAME trading day, the next sync derives
--        it again and the loss is invisible;
--      - if they confirm on a LATER day, `/order/list` no longer holds those
--        orders (`depthDays = 0`), the derivation answers 'interday', and that
--        is a PERMANENT 'unknown' — stored, never retried. An answer we had is
--        overwritten with "we could not read the orders", for good.
--
--    And in the meantime Stage 5's whole job is to SHOW this: the trade card's
--    `סטופ בברוקר` row and its one-line sentence both read `stop_history`, so
--    on a linked trade they would simply be absent.
--
--    SO THE LINK CARRIES THEM. Five columns, and the two halves are coalesced
--    in OPPOSITE DIRECTIONS, which is the only subtle thing in this step:
--
--      broker_stop_loss, broker_take_profit, stop_history
--        COALESCE(broker.…, plan.…) — prefer the BROKER row, because the broker
--        row IS this trade and a manual plan cannot have had these written to
--        it by anything. The fallback exists for one path: an unlink leaves
--        them on the plan (an unlink drops the exit half and keeps the entry
--        half), so a re-link of a row that came back with nothing must not
--        erase what the earlier link stored.
--
--      moved_sl, kept_sl
--        COALESCE(plan.…, broker.…) — prefer the PLAN, because these two are
--        the TRADER'S OWN ANSWER. If they closed the plan through the form and
--        said "no, I did not move my stop", that answer wins over the import's
--        derivation. This is the same fill-when-empty rule
--        src/lib/tradovate/import.ts applies, expressed in SQL, and getting
--        the direction wrong here would overwrite a self-report with a
--        broker read.
--
--    THE CONFIRMATION SCREEN STILL PROPOSES `moved_sl` AND STILL WINS, because
--    it writes in a SECOND statement after this function returns
--    (`confirmLink` in src/lib/journal/link.ts). Order: the function copies
--    what the broker said, then the trader's checkbox overwrites it. That is
--    the right precedence and it is worth knowing it is produced by the
--    ordering rather than by a rule in either place.
--
--    NOTHING ELSE IN THE FUNCTION CHANGES. The body below is 035's, verbatim,
--    with five lines added to write 2 of 3 and this file's note above it. It is
--    still `SECURITY DEFINER` for the one reason 035 gives — the merge needs a
--    transaction the browser does not have — and it still re-checks
--    `auth.uid()` against BOTH rows. Read survey 5 before running it.
--
--
-- IDEMPOTENT. Step 1 drops the constraint `IF EXISTS` and re-adds it; step 2
-- is `CREATE OR REPLACE`. Safe to re-run. One transaction, so a failure
-- anywhere leaves both the constraint and the function exactly as they were.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. custom_rules.condition_type — nine values, not eight
--
-- The eight are migration 015's, unchanged and in the same order, so a diff
-- against that file shows one added line and nothing else.
-- ---------------------------------------------------------------------------

ALTER TABLE custom_rules
  DROP CONSTRAINT IF EXISTS custom_rules_condition_type_check;

ALTER TABLE custom_rules
  ADD CONSTRAINT custom_rules_condition_type_check CHECK (condition_type IN (
    'daily_loss_dollar',
    'daily_loss_percent',
    'daily_trades_count',
    'loss_streak',
    'hour_after',
    'fomo_last_trade',
    'exited_early_last_trade',
    'moved_sl_last_trade',
    'moved_sl_widened_last_trade'
  ));


-- ---------------------------------------------------------------------------
-- 2. link_broker_trade() — the stop evidence survives a link
--
-- 035's body, with five columns added to write 2 of 3. See the header on why
-- three of them coalesce toward the broker and two toward the plan.
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
  -- become hides, the detail modal shows a provenance line). Then migration
  -- 038's stop evidence, then the two self-report booleans, then the key, then
  -- the link bookkeeping.
  --
  -- THE TWO COALESCE DIRECTIONS ARE OPPOSITE AND THAT IS THE POINT (REF-113
  -- Stage 5). The three stop columns prefer the BROKER's values, because the
  -- broker row is this trade; `moved_sl` and `kept_sl` prefer the PLAN's,
  -- because those are the trader's own answer and the import's own rule is to
  -- fill them only when they are empty. The full argument is in the header of
  -- this file.
  UPDATE trade_plans
     SET source             = broker.source,
         broker_account_id  = broker.broker_account_id,
         broker_host        = broker.broker_host,
         symbol             = broker.symbol,
         direction          = broker.direction,
         entry_price        = broker.entry_price,
         exit_price         = broker.exit_price,
         quantity           = broker.quantity,
         actual_pnl         = broker.actual_pnl,
         pnl_currency       = broker.pnl_currency,
         submitted_at       = broker.submitted_at,
         closed_at          = broker.closed_at,
         status             = broker.status,
         broker_stop_loss   = COALESCE(broker.broker_stop_loss,   plan.broker_stop_loss),
         broker_take_profit = COALESCE(broker.broker_take_profit, plan.broker_take_profit),
         stop_history       = COALESCE(broker.stop_history,       plan.stop_history),
         moved_sl           = COALESCE(plan.moved_sl,             broker.moved_sl),
         kept_sl            = COALESCE(plan.kept_sl,              broker.kept_sl),
         broker_trade_key   = broker.broker_trade_key,
         unplanned          = false,
         link_confirmed_at  = now(),
         link_method        = method
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
-- 1. The constraint lists NINE values now. EXPECT one row whose definition
--    contains 'moved_sl_widened_last_trade'.
--
--      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
--        FROM pg_constraint c
--       WHERE c.conrelid = 'public.custom_rules'::regclass
--         AND c.conname = 'custom_rules_condition_type_check';
--
-- 2. The new value is accepted and a nonsense one is still refused. Rolled
--    back. EXPECT the first INSERT to succeed and the second to raise 23514.
--
--      BEGIN;
--        INSERT INTO custom_rules (user_id, name, condition_type, action_type)
--        SELECT id, 'verify 039', 'moved_sl_widened_last_trade', 'warn'
--          FROM profiles LIMIT 1;
--        -- EXPECT: ERROR 23514 on this one.
--        INSERT INTO custom_rules (user_id, name, condition_type, action_type)
--        SELECT id, 'verify 039 bad', 'moved_sl_tightened_last_trade', 'warn'
--          FROM profiles LIMIT 1;
--      ROLLBACK;
--
-- 3. Existing rules are untouched. EXPECT the same number survey query 3
--    returned.
--
--      SELECT count(*) AS still_broad FROM custom_rules
--       WHERE condition_type = 'moved_sl_last_trade';
--
-- 4. The function still exists, is still SECURITY DEFINER, still has its
--    search_path pinned, and now names the five columns. EXPECT
--    security_definer = true, a config containing `search_path=public, pg_temp`,
--    and five true flags.
--
--      SELECT p.prosecdef AS security_definer,
--             p.proconfig,
--             pg_get_functiondef(p.oid) LIKE '%broker_stop_loss   = COALESCE%'   AS carries_stop,
--             pg_get_functiondef(p.oid) LIKE '%broker_take_profit = COALESCE%'   AS carries_target,
--             pg_get_functiondef(p.oid) LIKE '%stop_history       = COALESCE%'   AS carries_history,
--             pg_get_functiondef(p.oid) LIKE '%moved_sl           = COALESCE(plan%' AS plan_wins_moved,
--             pg_get_functiondef(p.oid) LIKE '%kept_sl            = COALESCE(plan%' AS plan_wins_kept
--        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--       WHERE n.nspname = 'public' AND p.proname = 'link_broker_trade';
--
-- 5. PUBLIC still cannot execute it. EXPECT false then true.
--
--      SELECT has_function_privilege('public', 'public.link_broker_trade(uuid,uuid,text)', 'EXECUTE')        AS public_can,
--             has_function_privilege('authenticated', 'public.link_broker_trade(uuid,uuid,text)', 'EXECUTE') AS authenticated_can;
--
-- 6. A link carries the evidence. THE ONLY VERIFY HERE THAT NEEDS REAL ROWS,
--    and it needs them under a session whose `auth.uid()` is their owner —
--    which the SQL Editor is not. Drive it from the app instead: confirm a
--    queued broker row that has a `stop_history`, then read the plan.
--    EXPECT a non-null document and the trade card's `סטופ בברוקר` row still
--    present after the link.
--
--      SELECT id, stop_history IS NOT NULL AS kept_history,
--             broker_stop_loss, moved_sl
--        FROM trade_plans
--       WHERE link_method = 'confirmed'
--       ORDER BY link_confirmed_at DESC LIMIT 5;
--
-- 7. The standing security assertions still come back clean. Run
--    supabase/queries/security_assertions.sql. EXPECT the usual two query-9
--    rows for setup-images and nothing new — this file replaces a
--    SECURITY DEFINER function, which is exactly the class of object those
--    assertions watch, so running them here is not a formality.
--
--
-- ROLLBACK
-- --------
--
-- Step 1 is reversible only while no row carries the new value; the DROP/ADD
-- below will fail with 23514 otherwise, which is the correct refusal rather
-- than a problem to work around. Delete or repoint those rules first.
--
-- Step 2 is reversible by re-running migration 035's own
-- `CREATE OR REPLACE FUNCTION` block verbatim. IT LOSES NOTHING ALREADY
-- WRITTEN — the columns stay on the rows that have them — and it resumes
-- dropping the evidence on every future link. Read the header on what that
-- costs before doing it.
--
--   BEGIN;
--     DELETE FROM custom_rules WHERE condition_type = 'moved_sl_widened_last_trade';
--     ALTER TABLE custom_rules
--       DROP CONSTRAINT IF EXISTS custom_rules_condition_type_check;
--     ALTER TABLE custom_rules
--       ADD CONSTRAINT custom_rules_condition_type_check CHECK (condition_type IN (
--         'daily_loss_dollar',
--         'daily_loss_percent',
--         'daily_trades_count',
--         'loss_streak',
--         'hour_after',
--         'fomo_last_trade',
--         'exited_early_last_trade',
--         'moved_sl_last_trade'
--       ));
--   COMMIT;

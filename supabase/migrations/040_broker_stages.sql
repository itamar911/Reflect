-- REF-117 Stage 6: how many pieces the position was entered and exited in.
--
-- TWO STEPS, AND THE SECOND IS NOT OPTIONAL. Either can be run alone, but
-- running step 1 without step 2 ships a feature that deletes itself the first
-- time a trader confirms a link — the same hole 039 step 2 closed for
-- `stop_history`, re-opened by a new column:
--
--   1. trade_plans gains `broker_stages` — JSONB, nullable, no default.
--   2. link_broker_trade() carries it onto the plan instead of deleting it
--      with the broker row.
--
-- RUN THIS BY HAND in the Supabase SQL Editor. Nothing in the repo applies
-- migrations.
--
-- NUMBERING: 029 is reserved for rule_violations and setup_images_delete
-- (REF-89) and still has no file; 021 is reserved for the
-- `ai-usage-accounting` branch. 039 is REF-113 Stage 5's `stop_direction`. 040
-- is the next number that is neither taken nor reserved. Do not reuse 029 or
-- 021.
--
--
-- ORDER RELATIVE TO THE DEPLOY — RUN THIS FIRST, AND THAT IS NOT A PREFERENCE
-- --------------------------------------------------------------------------
--
-- 038's hazard, exactly: `broker_stages` joins `EXECUTION_FACTS` in
-- src/lib/tradovate/import.ts, and `EXISTING_COLUMNS` is assembled from that
-- list and NAMED IN THE IMPORT'S OWN SELECT. TRADOVATE_IMPORT_ENABLED is
-- already '1' in production, so a deployment that reaches that select before
-- this file has run answers PostgREST **42703 (undefined column)** and
-- NOTHING IS IMPORTED AT ALL — not this column, not a single trade.
--
-- There is no flag gating this one and deliberately so: a second environment
-- variable per migration is a second thing to get wrong forever, and 038 set
-- the precedent of stating the order instead. So:
--
--     run 040, then deploy. Never the other way round.
--
-- The reverse failure is loud rather than silent, which is the one mercy in
-- it: the import's own log line reports `failed=N` and the Sync button says
-- "חלק מהעסקאות לא נשמרו".
--
--
-- BEFORE RUNNING IT — SURVEY
-- --------------------------
--
-- supabase/migrations/ does not describe the live database: objects here have
-- been created by hand in the dashboard and leave no trace in the repo (see
-- CLAUDE.md and supabase/README.md). Read all four and read the output.
--
--   -- 1. The column does not already exist. EXPECT zero rows. One row means
--   --    somebody added it by hand; compare `data_type` — it must be `jsonb`
--   --    — and then skip step 1.
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'trade_plans'
--      AND column_name = 'broker_stages';
--
--   -- 2. Step 2's prerequisite: 038 has run, because the function body below
--   --    names its three columns. EXPECT three rows. Fewer means STOP — run
--   --    038 and 039 first.
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'trade_plans'
--      AND column_name IN ('broker_stop_loss', 'broker_take_profit', 'stop_history')
--    ORDER BY column_name;
--
--   -- 3. The function step 2 replaces, so that its current definition is in
--   --    front of you before it is overwritten. COPY THE OUTPUT SOMEWHERE
--   --    before running the file: the body below was written from
--   --    supabase/migrations/039_stop_direction.sql, and if the live function
--   --    has been edited by hand since, this file would silently revert that
--   --    edit. EXPECT a body that already COALESCEs `stop_history` — if it
--   --    does not, 039 step 2 has not run and this file would carry the
--   --    stages while still dropping the stop evidence.
--   SELECT pg_get_functiondef(p.oid)
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'link_broker_trade';
--
--   -- 4. How many imported rows exist, so that "nothing has stages yet" is a
--   --    number rather than an assumption. Purely informational: there is no
--   --    backfill — see below.
--   SELECT count(*) AS broker_rows,
--          count(*) FILTER (WHERE quantity > 1) AS could_have_been_scaled
--     FROM trade_plans WHERE source = 'tradovate';
--
--
-- WHY A COLUMN AT ALL
-- -------------------
--
-- Because the three figures a row already carries provably erase the fact.
-- `quantity`, `entry_price` and `exit_price` are a count and two
-- QUANTITY-WEIGHTED MEANS, and src/lib/tradovate/fills.ts' averaging note is
-- entirely about making those three reproduce the P&L printed beside them.
-- What they cannot do is say how many decisions produced them: a long of three
-- entered whole and a long of three entered in three pieces are the same four
-- numbers. REF-117 Stage 0 measured a production position entered in two
-- pieces and covered in two, and the trade card is where a trader would see
-- that it happened.
--
-- NOTHING ELSE IN THE SCHEMA HOLDS IT. `BrokerTrade` was built from fill PAIRS
-- until REF-117 Stage 2 and from cycle LEGS after it, and neither the legs nor
-- the fills were ever written anywhere — `fill_ids` is not a column either.
-- So this is new storage and not a projection of something stored.
--
--
-- ITS SHAPE, as src/lib/tradovate/import.ts writes it
-- --------------------------------------------------
--
--     {
--       entries: [{ qty: number, price: number }],  -- time order
--       exits:   [{ qty: number, price: number }]   -- time order
--     }
--
-- ORDER IS DATA, like `stop_history.versions`: it is the order the trader
-- scaled in and out, and `src/lib/tradovate/import.ts`' `stableJson` sorts
-- object KEYS and never array elements for exactly that reason.
--
-- NO ids, NO instants, NO `orderId`, NO `splitFromFill`. The cycle leg carries
-- all four and `TradeStage` drops them: ids are the one thing this integration
-- asserts never leaves the server (the leak group in
-- scripts/tradovate-today-check.ts), and the instants are already summarised
-- into `submitted_at` and `closed_at`. What is left is what a sentence needs.
--
-- NO CHECK on that shape, for 038's reason: Postgres cannot usefully constrain
-- a free-form object, and src/lib/journal/stages.ts validates every field
-- before using it — a document whose two arrays cannot be read is read as no
-- document at all.
--
-- A JSONB COLUMN AND NOT TWO INTEGER COLUMNS, which was the cheaper-looking
-- option and is the wrong one. Two counts would answer the headline sentence
-- ("נכנסת ב-2 שלבים") and nothing else, and the per-stage quantity and price
-- are the whole content of the detail under it — a trader reconciling against
-- their broker statement needs the pieces, not the number of pieces. Same
-- argument 036 made for `debrief_ai` and 038 for `stop_history`, and the same
-- consequence: no SQL query filters on any of this.
--
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--
--   - NO `DEFAULT`, and this is the load-bearing omission. NULL has to keep
--     meaning "this row predates the column, or was not imported", which is a
--     different fact from `{"entries":[…],"exits":[…]}` with one of each =
--     "entered whole, exited whole". A default of `'{}'` would make every
--     manual trade ever logged claim to have been measured.
--
--   - NO BACKFILL, AND THERE CANNOT BE ONE. The legs are derived from
--     `/fill/list` and `/fillPair/list`, both measured at `depthDays = 0`
--     (REF-117 Stage 0), so the fills behind every existing row are gone. The
--     import also will not re-derive them: `restate()` only writes a column
--     whose value it has, and an existing row that is otherwise unchanged
--     will gain stages on the next sync ONLY IF that sync can still see its
--     fills — which for anything older than the current trading day it
--     cannot. SO THE DISPLAY IS FOR TRADES IMPORTED AFTER THIS RUNS, and the
--     readers are written to say nothing rather than something about the rest.
--
--   - NO INDEX. Nothing filters or orders by it.
--
--   - NOT ADDED TO `redact.ts`' SECRET_KEYS. It holds prices and quantities,
--     which are trade data under the same RLS as `entry_price`, not
--     credentials — and diluting that list is how it stops meaning anything.
--     038 made the same call for `stop_history`.
--
--
-- IDEMPOTENT. Step 1 is `ADD COLUMN IF NOT EXISTS`; step 2 is
-- `CREATE OR REPLACE`. Safe to re-run. One transaction, so a failure anywhere
-- leaves both the column and the function exactly as they were.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. trade_plans.broker_stages
-- ---------------------------------------------------------------------------

ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS broker_stages JSONB;

COMMENT ON COLUMN trade_plans.broker_stages IS
  'REF-117 Stage 6. The pieces a broker position was entered and exited in: '
  '{entries:[{qty,price}], exits:[{qty,price}]}, in time order. NULL means '
  'the row was not imported or predates the column -- never "entered whole". '
  'No backfill is possible: /fill/list is depthDays = 0.';


-- ---------------------------------------------------------------------------
-- 2. link_broker_trade() — the stages survive a link
--
-- 039's body, verbatim, with ONE column added to write 2 of 3. The COALESCE
-- direction is the broker's, like the three stop columns beside it and for the
-- same reason: the broker row IS this trade, and nothing can have written
-- stages to a manual plan. The fallback covers one path — an unlink leaves
-- them on the plan, so a re-link of a row that came back without them must not
-- erase what the earlier link stored.
--
-- WITHOUT THIS STEP the feature is self-deleting: `confirmLink` merges the
-- plan and DELETES the broker row, so a trader who confirms a link loses the
-- stages, the next sync cannot re-derive them (no fills to derive from), and
-- the trade card's row is simply absent on the trades they planned most
-- carefully. That is 039's lesson applied the first time rather than the
-- second.
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
  -- 038's stop evidence and 040's stages, then the two self-report booleans,
  -- then the key, then the link bookkeeping.
  --
  -- THE TWO COALESCE DIRECTIONS ARE OPPOSITE AND THAT IS THE POINT (REF-113
  -- Stage 5). The stop and stage columns prefer the BROKER's values, because
  -- the broker row is this trade; `moved_sl` and `kept_sl` prefer the PLAN's,
  -- because those are the trader's own answer and the import's own rule is to
  -- fill them only when they are empty. The full argument is in the header of
  -- migration 039.
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
         broker_stages      = COALESCE(broker.broker_stages,      plan.broker_stages),
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
-- 1. The column exists, is JSONB, is nullable and has NO default. EXPECT one
--    row: jsonb / YES / NULL. A non-null `column_default` is the one outcome
--    to act on — see the header on why.
--
--      SELECT column_name, data_type, is_nullable, column_default
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'trade_plans'
--         AND column_name = 'broker_stages';
--
-- 2. Every existing row is NULL, and NULL is distinguishable from an empty
--    document. EXPECT with_stages = 0 and empty_documents = 0.
--
--      SELECT count(*) FILTER (WHERE broker_stages IS NOT NULL)  AS with_stages,
--             count(*) FILTER (WHERE broker_stages = '{}'::jsonb) AS empty_documents
--        FROM trade_plans;
--
-- 3. RLS is unchanged — a column is not a policy, and `ensure_rls` is about
--    tables. EXPECT rowsecurity = true and the same policy set as before.
--
--      SELECT relrowsecurity AS rowsecurity
--        FROM pg_class WHERE oid = 'public.trade_plans'::regclass;
--      SELECT policyname, cmd FROM pg_policies
--       WHERE schemaname = 'public' AND tablename = 'trade_plans'
--       ORDER BY policyname;
--
-- 4. The function still exists, is still SECURITY DEFINER, still has its
--    search_path pinned, and now names the stages. EXPECT
--    security_definer = true, a config containing `search_path=public, pg_temp`,
--    and both flags true.
--
--      SELECT p.prosecdef AS security_definer,
--             p.proconfig,
--             pg_get_functiondef(p.oid) LIKE '%stop_history       = COALESCE%'  AS carries_history,
--             pg_get_functiondef(p.oid) LIKE '%broker_stages      = COALESCE%'  AS carries_stages
--        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--       WHERE n.nspname = 'public' AND p.proname = 'link_broker_trade';
--
-- 5. PUBLIC still cannot execute it. EXPECT false then true.
--
--      SELECT has_function_privilege('public', 'public.link_broker_trade(uuid,uuid,text)', 'EXECUTE')        AS public_can,
--             has_function_privilege('authenticated', 'public.link_broker_trade(uuid,uuid,text)', 'EXECUTE') AS authenticated_can;
--
-- 6. After the deploy and one sync: a scaled trade carries two arrays and a
--    trade entered whole carries one of each. THE ONLY VERIFY HERE THAT NEEDS
--    A RUN, and it is the one that proves the column is reachable rather than
--    merely present. EXPECT the arrays to sum to `quantity` on both sides.
--
--      SELECT broker_trade_key,
--             quantity,
--             jsonb_array_length(broker_stages -> 'entries') AS entry_pieces,
--             jsonb_array_length(broker_stages -> 'exits')   AS exit_pieces,
--             (SELECT sum((e ->> 'qty')::numeric)
--                FROM jsonb_array_elements(broker_stages -> 'entries') e) AS entered,
--             (SELECT sum((e ->> 'qty')::numeric)
--                FROM jsonb_array_elements(broker_stages -> 'exits') e)   AS exited
--        FROM trade_plans
--       WHERE source = 'tradovate' AND broker_stages IS NOT NULL
--       ORDER BY closed_at DESC LIMIT 10;
--
-- 7. A link carries the stages. Needs a session whose `auth.uid()` is the
--    rows' owner, which the SQL Editor is not — drive it from the app:
--    confirm a queued broker row that has `broker_stages`, then read the plan.
--
--      SELECT id, broker_stages IS NOT NULL AS kept_stages,
--             stop_history IS NOT NULL AS kept_history
--        FROM trade_plans
--       WHERE link_method = 'confirmed'
--       ORDER BY link_confirmed_at DESC LIMIT 5;
--
-- 8. The standing security assertions still come back clean. Run
--    supabase/queries/security_assertions.sql. EXPECT the usual two query-9
--    rows for setup-images and nothing new — this file replaces a
--    SECURITY DEFINER function, which is exactly the class of object those
--    assertions watch.
--
--
-- ROLLBACK
-- --------
--
-- Step 1: `ALTER TABLE trade_plans DROP COLUMN IF EXISTS broker_stages;`
-- DESTRUCTIVE AND UNRECOVERABLE — there is no backfill, so every document
-- written since this ran is gone for good. **And it must not be run while the
-- deployed code is current**, for the reason the deploy-order note gives from
-- the other side: the import's select names the column, so dropping it under
-- a running deployment stops every import with a 42703. Roll the code back
-- first, then the column.
--
-- Step 2 is reversible by re-running migration 039's own
-- `CREATE OR REPLACE FUNCTION` block verbatim. It loses nothing already
-- written and resumes dropping the stages on every future link.

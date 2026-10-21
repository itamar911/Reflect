-- REF-107: the symbol the trader typed, kept, so an unlink can give it back.
--
-- TWO STEPS, AND THE SECOND IS THE WHOLE FEATURE. Step 1 adds a column nothing
-- writes; step 2 is what writes it. Running step 1 alone is inert — no error,
-- no behaviour change, and `plan_symbol` stays NULL on every row forever:
--
--   1. trade_plans gains `plan_symbol` — TEXT, nullable, no default.
--   2. link_broker_trade() captures the plan's own symbol into it before the
--      broker's symbol overwrites `symbol`.
--
-- RUN THIS BY HAND in the Supabase SQL Editor. Nothing in the repo applies
-- migrations.
--
-- NUMBERING: 029 is reserved for rule_violations and setup_images_delete
-- (REF-89) and still has no file; 021 is reserved for the
-- `ai-usage-accounting` branch. 040 is REF-117 Stage 6's `broker_stages`. 041
-- is the next number that is neither taken nor reserved. Do not reuse 029 or
-- 021.
--
--
-- ORDER RELATIVE TO THE DEPLOY — EITHER ORDER IS SAFE, UNLIKE 038 AND 040
-- ----------------------------------------------------------------------
--
-- This is the first broker migration since 037 whose column is NOT an
-- execution fact, and that is what changes the hazard. `plan_symbol` is not in
-- `EXECUTION_FACTS` in src/lib/tradovate/import.ts, so it is not in
-- `EXISTING_COLUMNS`, so **THE IMPORT'S SELECT DOES NOT NAME IT** — and that
-- select is the line 038 and 040 say "run me first" because of. An import on a
-- database without this file reads exactly the columns it reads today.
--
-- Same for the pages: src/app/(app)/trades/page.tsx reads `select('*')` and
-- then maps field by field, so `(t.plan_symbol as string | null) ?? null` on a
-- database without the column is simply `null` — PostgREST returns no key,
-- which is the same shape every row has before its first link.
--
-- TWO STATEMENTS IN THE APP DO NAME THE COLUMN, and **both are written so that
-- a 42703 costs only the feature and never the operation**:
--
--   1. `unlinkPlan` (src/lib/journal/link.ts) reads
--      `.select('plan_symbol').eq('id', rowId).maybeSingle()` before it writes.
--      The error is deliberately ignored; `plan_symbol` reads as absent, and
--      the unlink sends exactly the statement it sends today — the broker's
--      symbol stays on the row, which is the currently shipped behaviour.
--
--   2. `linkOnto` (src/lib/tradovate/import.ts) captures the symbol on the
--      AUTO-link path with its own small UPDATE, before the one that moves the
--      facts. Its error is discarded too, and it is a separate statement for
--      exactly this reason: `plan_symbol` named in the facts UPDATE would make
--      the whole auto-link answer 42703 pre-041, and the trade would arrive in
--      the confirmation queue instead of on its plan.
--
-- So: EITHER ORDER WORKS, and nothing degrades except the capture itself.
-- Running this first is still preferable — then there is no window in which a
-- link quietly fails to keep a symbol, and no logged PostgREST errors.
--
--
-- TWO LINK PATHS, AND THE SECOND ONE IS NOT IN THIS FILE
-- -----------------------------------------------------
--
-- ref-107-small-fixes-2-investigation.md §2.1 states that both link paths go
-- through this function — the trader's confirmation and the matcher's
-- auto-link. **THAT IS WRONG, AND THE SUITE CAUGHT IT.** Only `confirmLink`
-- calls the RPC. The auto-link is `linkOnto` in src/lib/tradovate/import.ts: a
-- single UPDATE, deliberately not this function, because it has no second row
-- to reconcile and so needs neither the fixed statement order nor the
-- transaction (its own header argues this at length).
--
-- Consequence: step 2 below covers the CONFIRMATION path only, and the capture
-- on the auto-link path is a code change in `linkOnto`, shipped alongside.
-- Both implement the same rule — keep what was already captured, else take
-- `symbol` — one as `COALESCE`, the other as `.is('plan_symbol', null)`.
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
--   --    somebody added it by hand; compare `data_type` — it must be `text`
--   --    — and then skip step 1.
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'trade_plans'
--      AND column_name = 'plan_symbol';
--
--   -- 2. Step 2's prerequisites: 038 and 040 have run, because the function
--   --    body below names their four columns. EXPECT four rows. Fewer means
--   --    STOP — run 038, 039 and 040 first, or this file's function body will
--   --    fail on an unknown column and the transaction will take step 1 back
--   --    out with it.
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'trade_plans'
--      AND column_name IN ('broker_stop_loss', 'broker_take_profit',
--                          'stop_history', 'broker_stages')
--    ORDER BY column_name;
--
--   -- 3. The function step 2 replaces, so that its current definition is in
--   --    front of you before it is overwritten. COPY THE OUTPUT SOMEWHERE
--   --    before running the file: the body below was written from
--   --    supabase/migrations/040_broker_stages.sql, and if the live function
--   --    has been edited by hand since, this file would silently revert that
--   --    edit. EXPECT a body that already COALESCEs `broker_stages` — if it
--   --    does not, 040 step 2 has not run and this file would capture the
--   --    plan symbol while still dropping the stages.
--   SELECT pg_get_functiondef(p.oid)
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'link_broker_trade';
--
--   -- 4. HOW MANY ROWS THIS FILE CANNOT HELP — the number behind "future
--   --    only" below. Every already-linked row had its symbol overwritten in
--   --    place by an earlier `link_broker_trade`, and the broker row it was
--   --    merged from was hard-DELETEd, so there is nothing to backfill from.
--   --    Purely informational; nothing acts on it.
--   SELECT count(*) FILTER (WHERE source = 'tradovate' AND unplanned = false)
--            AS already_linked_cannot_be_repaired,
--          count(*) FILTER (WHERE source = 'manual')
--            AS plans_that_will_be_captured_on_their_next_link
--     FROM trade_plans;
--
--
-- WHY A COLUMN AT ALL
-- -------------------
--
-- Because `link_broker_trade`'s write 2 sets `symbol = broker.symbol` as a
-- plain overwrite, and the plan's own value is discarded IN PLACE. There is no
-- shadow column, no history table, no return value, and write 3 then hard-
-- DELETEs the broker row. The investigation searched every candidate and came
-- up empty: no `plan_symbol`-shaped column anywhere in src/ or supabase/, no
-- audit table, nothing in the stored debrief (`buildDebriefPrompt` has no
-- symbol line at all, so the four stored paragraphs cannot contain it even by
-- accident), and `setups.symbol` is the SETUP's instrument rather than the one
-- this plan was typed with — and null on most rows besides.
--
-- WHY THE SYMBOL AND NOT THE OTHER FOUR ENTRY FACTS. `entry_price`,
-- `quantity` and `submitted_at` from the broker are MORE accurate than what
-- the trader typed; keeping them on an unlink is arguably a feature, and the
-- dialog says so. The symbol is different in kind. A micro dated contract and
-- a continuous mini are not a correction of each other — they are two
-- different products in the trader's head — so a restored plan that keeps the
-- broker's spelling groups under the wrong instrument in stats and will not
-- match the trader's next plan for the same setup.
--
--
-- WHY `COALESCE` AND NOT A PLAIN ASSIGNMENT
-- -----------------------------------------
--
-- For the RE-LINK case, which is reachable today: unlink, then let the next
-- sync import the trade again and link it a second time. With a plain
-- assignment the second link would capture whatever `symbol` holds at that
-- moment — which, for a row unlinked before this file ran, is the BROKER's
-- spelling. The capture would then overwrite the trader's original with the
-- very value this column exists to replace.
--
-- `COALESCE(plan.plan_symbol, plan.symbol)` prefers the plan's own earlier
-- answer, which is the same direction the two `moved_sl` / `kept_sl` COALESCEs
-- beside it use and for the same reason. Migration 039's header has the full
-- argument.
--
-- ONE LINE COVERS THE CONFIRMATION PATH — `confirmLink` is the only caller of
-- this function. The auto-link captures the same value in `linkOnto`; see the
-- deploy-order section above for why that is a separate statement there and
-- why the investigation's claim that both paths share this function is wrong.
--
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--
--   - NO `DEFAULT` and NO `CHECK`. NULL is load-bearing: it means "this row
--     has never been linked, or was linked before 041 ran", and that is
--     exactly the population whose unlink must keep behaving as it does today.
--     A default of `''` would make every row claim to have a captured symbol
--     and would hand `symbol = ''` to an unlink.
--
--   - NO BACKFILL, AND THERE CANNOT BE ONE — see survey 4. The value was
--     overwritten in place and every other copy is gone. ALREADY-LINKED ROWS
--     ARE NOT REPAIRABLE, and the product therefore carries two populations
--     for a while: rows whose unlink restores the symbol, and rows whose
--     unlink cannot. src/lib/journal/link.ts' `unlinkWarningText` branches on
--     `plan_symbol` for that reason, so the dialog never promises the second
--     population something this column cannot give them.
--
--   - NO INDEX. Nothing filters, orders or joins on it.
--
--   - NOT ADDED TO `EXECUTION_FACTS`. It is the opposite of an execution fact:
--     the import must never write it, and nothing the broker sends should ever
--     reach it. Adding it there would hand the trader's own column to the
--     broker forever, which is the hazard that list's header is about.
--
--   - NOT ADDED TO `redact.ts`' SECRET_KEYS. A contract spelling is trade data
--     under the same RLS as `symbol` beside it, not a credential, and diluting
--     that list is how it stops meaning anything. 038 and 040 made the same
--     call.
--
--   - DOES NOT RETIRE `match.ts` CONDITION 8. `!decidedAlready(plan)` is still
--     the only thing stopping the next sync from re-linking the trade the
--     trader just released. Restoring the symbol weakens ONE of the agreements
--     §0א of ref-107-unlink.md cited for it, but `direction` and
--     `submitted_at` still match by construction and the window is still zero.
--     Do not read this file as having made that condition redundant.
--
--
-- IDEMPOTENT. Step 1 is `ADD COLUMN IF NOT EXISTS`; step 2 is
-- `CREATE OR REPLACE`. Safe to re-run. One transaction, so a failure anywhere
-- leaves both the column and the function exactly as they were.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. trade_plans.plan_symbol
-- ---------------------------------------------------------------------------

ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS plan_symbol TEXT;

COMMENT ON COLUMN trade_plans.plan_symbol IS
  'REF-107. The symbol the trader typed on this plan, captured by '
  'link_broker_trade() before the broker''s symbol overwrites `symbol`, and '
  'restored by an unlink. NULL means the row has never been linked or was '
  'linked before migration 041 -- never "the trader typed nothing". No '
  'backfill is possible: the value was overwritten in place and the broker '
  'row it was merged from was deleted.';


-- ---------------------------------------------------------------------------
-- 2. link_broker_trade() — the plan's own symbol survives the link
--
-- 040's body, verbatim, with ONE line added to write 2 of 3. The COALESCE
-- direction is the PLAN's, like `moved_sl` and `kept_sl` below it and unlike
-- the four broker columns above them: this is the trader's own value, and the
-- broker has nothing to say about it.
--
-- WITHOUT THIS STEP step 1 is dead storage. The column stays NULL on every
-- row, `unlinkPlan` finds nothing to restore, and the dialog keeps telling
-- every trader that the entry details stay as the broker reported them —
-- which is the behaviour this ticket was opened about.
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
  -- 041's capture of the symbol the facts are about to overwrite, then
  -- migration 038's stop evidence and 040's stages, then the two self-report
  -- booleans, then the key, then the link bookkeeping.
  --
  -- THE TWO COALESCE DIRECTIONS ARE OPPOSITE AND THAT IS THE POINT (REF-113
  -- Stage 5). The stop and stage columns prefer the BROKER's values, because
  -- the broker row is this trade; `plan_symbol`, `moved_sl` and `kept_sl`
  -- prefer the PLAN's, because those are the trader's own answers. The full
  -- argument is in the header of migration 039.
  --
  -- `plan_symbol` READS `plan.*` ON BOTH SIDES, which is not a typo. The
  -- broker has no opinion about what the trader typed; the only question is
  -- whether an earlier link already captured it (re-link — keep it) or not
  -- (first link — take `symbol`, which is still the trader's at this point
  -- because `plan` was read into a record variable before this UPDATE).
  UPDATE trade_plans
     SET source             = broker.source,
         broker_account_id  = broker.broker_account_id,
         broker_host        = broker.broker_host,
         symbol             = broker.symbol,
         plan_symbol        = COALESCE(plan.plan_symbol, plan.symbol),
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
-- 1. The column exists, is TEXT, is nullable and has NO default. EXPECT one
--    row: text / YES / NULL. A non-null `column_default` is the one outcome to
--    act on — see the header on why NULL is load-bearing.
--
--      SELECT column_name, data_type, is_nullable, column_default
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'trade_plans'
--         AND column_name = 'plan_symbol';
--
-- 2. Every existing row is NULL, and NULL is distinguishable from an empty
--    string. EXPECT with_plan_symbol = 0 and empty_strings = 0.
--
--      SELECT count(*) FILTER (WHERE plan_symbol IS NOT NULL) AS with_plan_symbol,
--             count(*) FILTER (WHERE plan_symbol = '')        AS empty_strings
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
--    search_path pinned, and now captures the symbol WITHOUT having lost
--    anything 038/039/040 added. EXPECT security_definer = true, a config
--    containing `search_path=public, pg_temp`, and all three flags true.
--
--      SELECT p.prosecdef AS security_definer,
--             p.proconfig,
--             pg_get_functiondef(p.oid) LIKE '%stop_history       = COALESCE%' AS carries_history,
--             pg_get_functiondef(p.oid) LIKE '%broker_stages      = COALESCE%' AS carries_stages,
--             pg_get_functiondef(p.oid) LIKE '%plan_symbol        = COALESCE%' AS captures_symbol
--        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--       WHERE n.nspname = 'public' AND p.proname = 'link_broker_trade';
--
-- 5. PUBLIC still cannot execute it. EXPECT false then true.
--
--      SELECT has_function_privilege('public', 'public.link_broker_trade(uuid,uuid,text)', 'EXECUTE')        AS public_can,
--             has_function_privilege('authenticated', 'public.link_broker_trade(uuid,uuid,text)', 'EXECUTE') AS authenticated_can;
--
-- 6. After the deploy and one link: the linked plan carries BOTH spellings —
--    the broker's in `symbol` and the trader's in `plan_symbol` — and they are
--    allowed to be equal (a trader who typed the dated contract themselves).
--    THE ONLY VERIFY HERE THAT NEEDS A RUN, and the one that proves the column
--    is reachable rather than merely present. Needs a session whose
--    `auth.uid()` is the rows' owner, which the SQL Editor is not — drive it
--    from the app: confirm a queued broker row against a plan that has a
--    symbol, then read the plan.
--
--      SELECT id, symbol, plan_symbol,
--             symbol = plan_symbol AS trader_typed_the_same_thing
--        FROM trade_plans
--       WHERE source = 'tradovate' AND plan_symbol IS NOT NULL
--       ORDER BY link_confirmed_at DESC LIMIT 10;
--
-- 7. Then unlink that row from the app and read it again. EXPECT `symbol` to
--    be the trader's spelling and `plan_symbol` to be NULL — the capture is
--    SPENT by the restore, so a second link captures afresh.
--
--      SELECT id, source, status, symbol, plan_symbol
--        FROM trade_plans
--       WHERE id = '<the row from 6>';
--
-- 8. A row linked BEFORE this file ran is untouched by all of it. EXPECT
--    plan_symbol IS NULL, and an unlink of one of these keeps the broker's
--    symbol exactly as it does today — which is what the dialog's conditional
--    wording exists for.
--
--      SELECT count(*) FROM trade_plans
--       WHERE source = 'tradovate' AND unplanned = false AND plan_symbol IS NULL;
--
-- 9. The standing security assertions still come back clean. Run
--    supabase/queries/security_assertions.sql. EXPECT the usual two query-9
--    rows for setup-images and nothing new — this file replaces a
--    SECURITY DEFINER function, which is exactly the class of object those
--    assertions watch.
--
--
-- ROLLBACK
-- --------
--
-- Step 1: `ALTER TABLE trade_plans DROP COLUMN IF EXISTS plan_symbol;`
-- DESTRUCTIVE AND UNRECOVERABLE — there is no backfill, so every symbol
-- captured since this ran is gone for good and those plans can never be given
-- their own spelling back. Unlike 038 and 040 this CAN be run under the
-- current deployment without stopping anything: the import's select does not
-- name the column (see the deploy-order note), and the one read that does name
-- it already treats a 42703 as "nothing to restore". It is still the wrong
-- order — roll the code back first if the code is the problem.
--
-- Step 2 is reversible by re-running migration 040's own
-- `CREATE OR REPLACE FUNCTION` block verbatim. It loses nothing already
-- captured and resumes discarding the plan's symbol on every future link.

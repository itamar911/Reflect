-- trade_plans: unplanned trades, rule-context provenance, and a third status.
--
-- Groundwork for REF-82 (the trade plan form). Adds two columns and widens the
-- status CHECK. Creates nothing and drops no data.
--
-- RUN THIS BY HAND in the Supabase SQL Editor. Nothing in the repo applies
-- migrations.
--
-- NUMBERING: 029 is reserved for rule_violations and setup_images_delete
-- (REF-89) and has no file yet; 030 and 031 are applied. 032 is the next number
-- that is neither taken nor reserved. Do not reuse 029.
--
--
-- BEFORE RUNNING IT
-- -----------------
--
-- supabase/migrations/ does not describe the live database — objects here have
-- been created by hand in the dashboard and leave no trace in the repo (see
-- CLAUDE.md). supabase/schema.sql says trade_plans.status carries an inline,
-- unnamed CHECK (status IN ('open','closed')), which Postgres would have named
-- trade_plans_status_check — but schema.sql is known to be stale, the
-- constraint may have been renamed, replaced or dropped by hand, and this file
-- cannot see which. So the status change below discovers the real constraint
-- from pg_constraint instead of assuming a name, and refuses to guess when it
-- finds something it does not recognise.
--
-- Run this first and read the output:
--
--   -- 1. Which of this file's columns already exist, and how.
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name   = 'trade_plans'
--      AND column_name IN ('status', 'unplanned', 'rule_context_source')
--    ORDER BY column_name;
--
--   -- 2. Every CHECK constraint on trade_plans, with the columns it covers.
--   --    Look for anything constraining `status`.
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
--   -- 3. Status values actually present. A value outside the new CHECK would
--   --    make this migration fail; better to see it here first.
--   SELECT status, count(*) FROM trade_plans GROUP BY status ORDER BY 2 DESC;
--
-- If (2) shows a CHECK covering `status` together with other columns, or (3)
-- shows a status value this file does not list, stop and reconcile. The DO
-- block below raises in both cases rather than proceeding.
--
--
-- COLUMN GRANTS: DELIBERATELY NONE
-- --------------------------------
--
-- 017/030 had to grant each new column on tradovate_connections explicitly,
-- because that table uses column-level GRANTs and a new column carries no
-- privileges from them. trade_plans does not: no migration and no part of
-- schema.sql issues a column-level GRANT or REVOKE against it, so it keeps
-- Supabase's table-level grants and both new columns are readable by
-- `authenticated` as soon as they exist, under the table's existing RLS
-- policies. Checked, not assumed — and the reason this file adds no GRANT.
--
--
-- WHY EACH CHANGE
-- ---------------
--
-- 1. unplanned — REF-82 §5.4. A trade that reaches the journal without a plan
--    is marked and still counts toward the rules. Counting it is the point:
--    otherwise the rule defeats itself, because a trader who loses twice
--    without filling the form gets a clean verdict from the form afterwards.
--    Nothing writes this column yet; REF-90 (the broker pull layer) is what
--    produces such a row, and it is not built.
--
-- 2. rule_context_source — REF-82 §6. When a plan is saved, this records what
--    the rule check actually had to judge it against, so the row can later be
--    shown as "saved without verification" instead of being read as checked.
--
--    TEXT with a CHECK rather than the single boolean the brief suggests
--    ("one column"), because §6 itself distinguishes two failure kinds with
--    different user actions — an expired connection the user fixes in one
--    click, and a Tradovate outage nobody can fix — and a boolean throws that
--    distinction away. Decided on REF-82 (emri, 12.10, decision 5).
--
--      reflect_only       — no broker data consulted. The only value REF-82
--                           writes, and the DEFAULT, because until REF-90
--                           exists this is true of every plan.
--      broker_verified    — broker data was fetched and judged against.
--      broker_expired     — the connection had lapsed; the user must reconnect.
--      broker_unavailable — the fetch failed upstream.
--
--    The last three are written by REF-90, not here.
--
-- 3. status 'not_entered' — REF-82 §5.2. A plan left open from a previous day
--    is either a forgotten trade or one never entered, and the next form asks
--    which. "Never entered" is not `closed`: there is no exit price and no
--    P&L, and leaving it `open` means the form asks again tomorrow, forever.
--
--    NOTE for whoever builds step 2: widening the CHECK is necessary but not
--    sufficient. Every reader that filters on status has to be looked at —
--    lib/rules/tradeRuleContext.ts counts today's trades by submitted_at with
--    no status filter at all, so a 'not_entered' plan would currently be
--    counted as a trade taken. That is a code change, deliberately not in
--    this file.


-- ---------------------------------------------------------------------------
-- 1. unplanned
--
-- NOT NULL with a DEFAULT: Postgres 11+ fills existing rows from the default
-- without rewriting the table, and false is correct for every existing row —
-- every plan in there today came from the form.
--
-- No index. Nothing queries by this column yet; the weekly summary will, and
-- that is the change that should justify and add one.
-- ---------------------------------------------------------------------------

ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS unplanned BOOLEAN NOT NULL DEFAULT false;


-- ---------------------------------------------------------------------------
-- 2. rule_context_source
--
-- Unlike 030's environment column this one does take a DEFAULT. There the
-- default was the hazard — it is how a live token comes to be labelled 'demo'
-- by accident. Here 'reflect_only' is the honest description of every row that
-- exists and of every row REF-82 writes, and it is the conservative value: it
-- claims no verification.
-- ---------------------------------------------------------------------------

ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS rule_context_source TEXT NOT NULL DEFAULT 'reflect_only';

ALTER TABLE trade_plans
  DROP CONSTRAINT IF EXISTS trade_plans_rule_context_source_check;
ALTER TABLE trade_plans
  ADD CONSTRAINT trade_plans_rule_context_source_check
  CHECK (rule_context_source IN
    ('reflect_only', 'broker_verified', 'broker_expired', 'broker_unavailable'));


-- ---------------------------------------------------------------------------
-- 3. status: allow 'not_entered'
--
-- One DO block, and therefore one statement, so the drop and the re-add cannot
-- land apart: a failure anywhere below leaves the existing constraint in
-- place. That ordering is deliberate — the data is validated BEFORE anything
-- is dropped, so a stray status value aborts the migration instead of leaving
-- the table unconstrained.
--
-- Idempotent: a re-run drops the constraint this file added and adds it back.
--
-- Works whether or not a CHECK on status exists today, which is the whole
-- reason for the block:
--
--   - a status-only CHECK (any name)  -> dropped and replaced
--   - no CHECK on status at all       -> the new one is simply added
--   - a CHECK covering status AND     -> raises. Dropping it would silently
--     other columns                      remove an unrelated rule, and this
--                                        file has no way to reconstruct it.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  status_attnum SMALLINT;
  unexpected    TEXT[];
  conflicting   TEXT[] := '{}';
  con           RECORD;
BEGIN
  SELECT a.attnum INTO status_attnum
    FROM pg_attribute a
   WHERE a.attrelid = 'public.trade_plans'::regclass
     AND a.attname  = 'status'
     AND NOT a.attisdropped;

  IF status_attnum IS NULL THEN
    RAISE EXCEPTION
      '032: trade_plans has no status column. The repo expects one; reconcile before running this.';
  END IF;

  -- Data first. ADD CONSTRAINT validates every existing row, so a value
  -- outside the new list would fail the ALTER — and if the old constraint had
  -- already been dropped by then, the table would be left with none.
  SELECT array_agg(DISTINCT t.status) INTO unexpected
    FROM trade_plans t
   WHERE t.status NOT IN ('open', 'closed', 'not_entered');

  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION
      '032: trade_plans holds status value(s) %, which the new CHECK would reject. '
      'Nothing has been changed. Decide what these rows are, then widen the list '
      'in this file or correct the rows.',
      array_to_string(unexpected, ', ');
  END IF;

  -- Then the constraints. Discovered by the columns they cover, not by name.
  FOR con IN
    SELECT c.conname, c.conkey, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
     WHERE c.conrelid = 'public.trade_plans'::regclass
       AND c.contype  = 'c'
       AND c.conkey @> ARRAY[status_attnum]
  LOOP
    IF con.conkey = ARRAY[status_attnum] THEN
      RAISE NOTICE '032: replacing status CHECK % — was: %', con.conname, con.def;
      EXECUTE format('ALTER TABLE trade_plans DROP CONSTRAINT %I', con.conname);
    ELSE
      conflicting := conflicting || format('%s (%s)', con.conname, con.def);
    END IF;
  END LOOP;

  IF array_length(conflicting, 1) > 0 THEN
    RAISE EXCEPTION
      '032: trade_plans has CHECK constraint(s) covering status together with other '
      'columns: %. Dropping one blindly could remove an unrelated rule. Reconcile by '
      'hand, then re-run. Nothing has been changed.',
      array_to_string(conflicting, ' | ');
  END IF;

  ALTER TABLE trade_plans
    ADD CONSTRAINT trade_plans_status_check
    CHECK (status IN ('open', 'closed', 'not_entered'));

  RAISE NOTICE '032: trade_plans.status now allows open, closed, not_entered.';
END $$;


-- ---------------------------------------------------------------------------
-- AFTER RUNNING IT
--
-- Re-run queries (1) and (2) from the header and confirm:
--   - unplanned and rule_context_source are both NOT NULL with their defaults
--   - exactly one CHECK covers status, and it lists three values
--   - trade_plans_rule_context_source_check exists
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- ROLLBACK
--
-- Safe only while nothing has written a non-default value. Dropping the
-- columns destroys any 'unplanned' marks and any provenance already recorded,
-- so check before running it:
--
--   SELECT count(*) FILTER (WHERE unplanned),
--          count(*) FILTER (WHERE rule_context_source <> 'reflect_only')
--     FROM trade_plans;
--
-- Both zero means nothing is lost.
--
--   ALTER TABLE trade_plans DROP CONSTRAINT IF EXISTS trade_plans_rule_context_source_check;
--   ALTER TABLE trade_plans DROP COLUMN IF EXISTS rule_context_source;
--   ALTER TABLE trade_plans DROP COLUMN IF EXISTS unplanned;
--
--   -- Restore the two-value status CHECK. Fails if any row is 'not_entered';
--   -- those rows have to be resolved first, because the narrower constraint
--   -- has no way to represent them.
--   ALTER TABLE trade_plans DROP CONSTRAINT IF EXISTS trade_plans_status_check;
--   ALTER TABLE trade_plans
--     ADD CONSTRAINT trade_plans_status_check CHECK (status IN ('open', 'closed'));
-- ---------------------------------------------------------------------------

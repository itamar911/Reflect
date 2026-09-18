-- 026 — restore the two updated_at triggers that 002 never managed to create
--
-- 002 creates personal_strategies_updated_at and alert_settings_updated_at.
-- Neither exists in the database. Everything else in 002 landed — both tables,
-- both policies, the index, the subscription_tier column — so this was not a
-- migration that went unrun. Two adjacent statements failed and the rest
-- succeeded.
--
-- Their one shared dependency is update_updated_at(), which schema.sql defines
-- BELOW the tables it serves. If 002 ran before that part of schema.sql had
-- been applied, both CREATE TRIGGERs would have failed with "function
-- update_updated_at() does not exist" and nothing else in 002 would have
-- cared: no other statement in the file references it. By the time 017 ran the
-- function existed, which is why tradovate_connections_updated_at is there and
-- these two are not.
--
-- That is inference. Postgres keeps no DDL history, so it cannot be proved —
-- but nothing else explains exactly those two statements failing while the ones
-- four lines above and below them succeeded.
--
-- ── What was actually broken ──
--
-- updated_at on both tables sits at its insert-time DEFAULT NOW() and never
-- advances, because nothing else was setting it either: the update payloads in
-- StrategiesClient.tsx:277, StrategyBuilder.tsx:190 and AlertsPanel contain no
-- updated_at. Every row on both tables says it was last modified at the moment
-- it was created.
--
-- Nothing reads it. Every query on personal_strategies orders by created_at
-- (strategies/page.tsx:13, StrategiesClient.tsx:285, StrategyBuilder.tsx:208,
-- TradePlanForm.tsx:240) and alert_settings is only ever fetched by user_id
-- with .single(). So this is cosmetic today, and worth fixing anyway: the
-- column is NOT NULL, carries a plausible timestamp, and is wrong. The first
-- person to sort by "recently edited" gets silently incorrect ordering with
-- nothing to tip them off. A column that is absent fails loudly; a column that
-- lies does not.
--
-- ── No backfill, deliberately ──
--
-- The real modification times are gone. Writing created_at into updated_at
-- would make every row assert something we do not know, in a column that is
-- supposed to be a fact — a guess wearing the shape of one. Rows that say
-- "created, never edited" are at least true of the rows that were never edited,
-- and for the rest the honest answer is that we cannot say.
--
-- From the moment this runs, the value is correct going forward. That is the
-- most that is recoverable.
--
-- ── Why this one is idempotent and 002 was not ──
--
-- CREATE OR REPLACE TRIGGER (Postgres 14+, and Supabase is well past that) is
-- a single atomic statement: it installs the trigger whether or not one of that
-- name exists, with no window in which the table is left without it. Plain
-- CREATE TRIGGER — which is what 002 used, and what four of the seven
-- CREATE TRIGGER statements in this directory still use — raises "trigger
-- already exists" on a second run, so re-running the file fails instead of
-- converging. See supabase/README.md.
--
-- If this ever has to run somewhere older than PG14, the equivalent is
--   DROP TRIGGER IF EXISTS <name> ON <table>;
--   CREATE TRIGGER <name> ...;
-- which is what 017 does, and which is idempotent but not atomic.

-- Fail loudly rather than silently, which is the whole lesson of 002. Without
-- this block, a missing update_updated_at() gives the same outcome it gave the
-- first time: an error in the middle of a script, easy to scroll past, leaving
-- a migration that looks applied.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'update_updated_at'
  ) THEN
    RAISE EXCEPTION
      'update_updated_at() is missing from schema public. It is defined in supabase/schema.sql; create it before running this migration. Creating these triggers without it is exactly how 002 failed.';
  END IF;
END
$$;

CREATE OR REPLACE TRIGGER personal_strategies_updated_at
  BEFORE UPDATE ON public.personal_strategies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER alert_settings_updated_at
  BEFORE UPDATE ON public.alert_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ── Verification ──

-- 1. Both triggers exist and point at the right function. Expect two rows.
SELECT c.relname AS on_table, t.tgname AS trigger_name, p.proname AS function_name,
       pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c     ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p      ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND n.nspname = 'public'
  AND t.tgname IN ('personal_strategies_updated_at', 'alert_settings_updated_at')
ORDER BY c.relname;

-- 2. The repo and the database now agree on triggers. Query 6 of
--    supabase/queries/schema_drift.sql should return zero rows.

-- 3. Behavioural, and it WRITES — run it against one of your own rows.
--    updated_at should differ from created_at afterwards, and should not have
--    differed before.
--
--      SELECT id, created_at, updated_at FROM personal_strategies LIMIT 1;
--      UPDATE personal_strategies SET name = name WHERE id = '<that id>';
--      SELECT id, created_at, updated_at FROM personal_strategies WHERE id = '<that id>';
--
--    Note SET name = name: the trigger fires on any UPDATE, including one that
--    changes nothing, so this proves the trigger rather than the assignment.
--    The only lasting effect is that this row's updated_at becomes now(), which
--    is true — it was just updated.

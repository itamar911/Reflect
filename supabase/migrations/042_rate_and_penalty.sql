-- REF-112 §4: the state the rate and cost caps need, and nothing else.
--
-- Six objects, all of them bookkeeping about HOW OFTEN we may talk to
-- Tradovate on one trader's behalf. Not one of them is trade data, not one is
-- a credential, and not one is read by the browser:
--
--   1. tradovate_connections.penalised_until    -- the captcha/penalty lockout
--   2. tradovate_connections.last_sync_at       -- the POST /sync cooldown
--   3. tradovate_connections.last_import_at     -- the 20:00 import cron cursor
--   4. tradovate_connections.last_orders_at     -- the 21:30 orders cron cursor
--   5. tradovate_connections.last_alert_import_at -- send-alerts' import cursor
--   6. tradovate_call_counts + bump_tradovate_calls() -- the daily call counter
--
-- RUN THIS BY HAND in the Supabase SQL Editor. Nothing in the repo applies
-- migrations.
--
-- NUMBERING: 029 is reserved for rule_violations and setup_images_delete
-- (REF-89) and still has no file; 021 is reserved for the
-- `ai-usage-accounting` branch. 041 is REF-107's `plan_symbol`. 042 is the
-- next number that is neither taken nor reserved. Do not reuse 029 or 021.
--
--
-- ORDER RELATIVE TO THE DEPLOY — EITHER ORDER IS SAFE, AND THAT IS DESIGNED
-- ------------------------------------------------------------------------
--
-- **THE CODE IS SAFE TO DEPLOY BEFORE THIS FILE RUNS.** That is a property of
-- the code rather than a hope about it, and it is the reason the five columns
-- are read the way they are. Migration 038's and 040's "run me first" hazard
-- was that the import's single SELECT named their columns, so a 42703 took the
-- whole operation down with the feature. Nothing here is named in that select.
--
-- Instead every one of the six is reached through a statement WHOSE OWN FAILURE
-- IS THE ABSENCE OF THE FEATURE:
--
--   - `claimSyncSlot` (src/lib/tradovate/connections.ts) is one conditional
--     UPDATE naming `last_sync_at`. A 42703 is read as "no cooldown is
--     recorded", which answers `allowed` — so POST /api/tradovate/sync behaves
--     exactly as it does today, with the client's own 180-second throttle and
--     its explicit-click bypass as the only guard. The backstop is absent, not
--     broken.
--
--   - `readPenaltyState` is one SELECT naming `penalised_until`. A 42703 is
--     read as "not penalised", so the four callers pull as they do today. The
--     WRITE (`recordPenalty`) is its own UPDATE whose error is logged as a kind
--     and discarded, so a captcha still fails the one pull it failed before —
--     it simply does not yet buy the hour of quiet.
--
--   - `listConnectionsForImport` asks for its cursor column and FALLS BACK to
--     today's `ORDER BY user_id` on a 42703, reporting `cursor: false`. The
--     bounded batch still applies pre-042; the FAIRNESS does not, because
--     without the column every run covers the same stable prefix. That is
--     exactly today's behaviour with a bound on it, which is why this is safe
--     rather than merely tolerable — and it is also why running this file is
--     what actually fixes REF-112 §4.6 item 1.
--
--   - The counter is a table rather than a column, so a pre-042 deployment gets
--     PGRST205 ("relation does not exist") from `bump_tradovate_calls`.
--     `flushUserCalls` discards it and logs one kind per process. Nothing
--     counts; nothing else changes.
--
-- SO: either order works, and the degradation is "the cap is not there yet"
-- in all six cases, never "the pull failed". Running this file first is still
-- preferable — then there is no window in which the caps are shipped and inert.
--
--
-- BEFORE RUNNING IT — SURVEY
-- --------------------------
--
-- supabase/migrations/ does not describe the live database: objects here have
-- been created by hand in the dashboard and leave no trace in the repo (see
-- CLAUDE.md and supabase/README.md). Read all five and read the output.
--
--   -- 1. None of the five columns already exists. EXPECT zero rows. A row
--   --    means somebody added it by hand; compare `data_type` — every one of
--   --    them must be `timestamp with time zone` — and then let the
--   --    `IF NOT EXISTS` below do nothing.
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'tradovate_connections'
--      AND column_name IN ('penalised_until', 'last_sync_at', 'last_import_at',
--                          'last_orders_at', 'last_alert_import_at')
--    ORDER BY column_name;
--
--   -- 2. The table does not already exist. EXPECT zero rows.
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_name = 'tradovate_call_counts';
--
--   -- 3. The function does not already exist under a different signature.
--   --    EXPECT zero rows. One row means READ ITS BODY before this file
--   --    replaces it — `CREATE OR REPLACE` would silently overwrite a hand
--   --    edit, which is 041 survey 3's lesson.
--   SELECT pg_get_functiondef(p.oid)
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'bump_tradovate_calls';
--
--   -- 4. The column GRANT on tradovate_connections, so it is in front of you
--   --    before five columns are added to the table it covers. EXPECT exactly
--   --    the seven columns 017 granted — id, user_id, status,
--   --    tradovate_user_id, expires_at, created_at, updated_at — and NOTHING
--   --    else. The five columns below are deliberately NOT added to it; see
--   --    "WHO MAY READ ANY OF THIS" further down. If this query shows a
--   --    table-level grant rather than a column list, STOP: a later blanket
--   --    `GRANT SELECT ON tradovate_connections` would publish all five the
--   --    moment they exist.
--   SELECT grantee, column_name, privilege_type
--     FROM information_schema.column_privileges
--    WHERE table_schema = 'public' AND table_name = 'tradovate_connections'
--      AND grantee IN ('anon', 'authenticated', 'PUBLIC')
--    ORDER BY grantee, column_name;
--
--   -- 5. HOW MANY CONNECTIONS THE CURSORS WILL HAVE TO ROTATE THROUGH — the
--   --    number behind REF-112 §4.6's "breaks at ~10 users". Purely
--   --    informational; nothing acts on it. If `active` is already above
--   --    IMPORT_BATCH_LIMIT (20, src/lib/tradovate/connections.ts) then the
--   --    orders cron has ALREADY been starving its tail and this file is
--   --    overdue rather than preventative.
--   SELECT status, count(*) FROM tradovate_connections GROUP BY status;
--
--
-- WHO MAY READ ANY OF THIS
-- -----------------------
--
-- NOBODY BUT THE SERVER, and for the five columns that is automatic rather
-- than asserted. Migration 017 grants SELECT on a NAMED LIST of seven columns
-- (017:99) precisely because Postgres row security has no column dimension —
-- so a column added to this table is unreadable by `authenticated` until
-- somebody names it in a grant, and this file names none of them. A browser
-- asking for `penalised_until` gets a permission error, not a value.
--
-- That is the right answer rather than merely the cheap one. `penalised_until`
-- is the one field here a trader could conceivably want to see, and surfacing
-- it is a product decision with Hebrew copy attached, not a grant.
--
-- `tradovate_call_counts` is service-role only, with no policy at all. The
-- `ensure_rls` event trigger (ours, not Supabase's, and in no migration — see
-- CLAUDE.md) turns RLS on for every table created in `public`, and with zero
-- policies RLS denies everything. The REVOKEs below are belt and braces for
-- Supabase's default grants to `anon` and `authenticated`, exactly as 017
-- argues at 017:86-92.
--
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--
--   - NO DEFAULTS on the five columns. NULL is load-bearing on every one of
--     them and means "this has never happened": never penalised, never synced,
--     never picked up by that cron. `NULLS FIRST` in the cursor ordering turns
--     that into "goes first", which is what makes a brand-new connection the
--     next one served rather than the last.
--
--   - NO CHECK CONSTRAINTS. A `penalised_until` in the past is not corrupt
--     data, it is an expired lockout, and that is the normal resting state of
--     the column for any trader who was ever penalised once.
--
--   - NO INDEXES ON THE FIVE. The cursor ORDER BY is over a table with one row
--     per connected user; at the scale this is sized for (REF-112 §4.6 counts
--     users in the tens to low hundreds) a sort is cheaper than an index to
--     maintain on a column three crons write every night. Revisit if
--     `tradovate_connections` ever passes a few thousand rows.
--
--   - NO CAP ENFORCEMENT ANYWHERE. `tradovate_call_counts` is VISIBILITY
--     ONLY — REF-112 §4.5 item 1 is that nothing can answer "how many calls
--     did this user make yesterday", and this answers it. Nothing reads the
--     number to refuse a request, and the counter must not grow a threshold
--     without the measured limit REF-112 §4.1 says does not exist yet.
--
--   - NOT ADDED TO `EXECUTION_FACTS` or to redact.ts' SECRET_KEYS. None of
--     these is a fact about a trade and none is a credential. 041's header
--     makes both arguments.
--
--   - NO BACKFILL, AND NONE IS POSSIBLE. Nothing recorded a sync time, a
--     penalty or a call before this file, so every row starts NULL and every
--     counter starts at its first flush. The cursors do not need one: NULL
--     sorts first, so the first run after this file reaches the users that have
--     waited longest by construction.
--
--
-- IDEMPOTENT. Five `ADD COLUMN IF NOT EXISTS`, one `CREATE TABLE IF NOT
-- EXISTS`, one `CREATE OR REPLACE FUNCTION`. Safe to re-run. One transaction,
-- so a failure anywhere leaves the schema exactly as it was.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. tradovate_connections.penalised_until — the lockout
--
-- REF-112 §4.5 item 3. `TradovatePenaltyError{captcha:true}` is classified
-- TRANSIENT (connections.ts), and transient BY DESIGN writes nothing to the
-- database (errors.ts, from REF-101) — so until now nothing anywhere recorded
-- that a trader was inside an hour-long captcha lockout, and the 15-second
-- live poll kept asking roughly 240 times an hour while three sync mount
-- points and four crons did the same.
--
-- This is the one piece of state that makes "stop asking" expressible. It is
-- deliberately an INSTANT and not a flag: a flag needs something to clear it,
-- and the only thing that could is another cron.
-- ---------------------------------------------------------------------------

ALTER TABLE tradovate_connections
  ADD COLUMN IF NOT EXISTS penalised_until TIMESTAMPTZ;

COMMENT ON COLUMN tradovate_connections.penalised_until IS
  'REF-112. Until when every Tradovate call for this user is skipped, after '
  'Tradovate answered with a penalty body (p-captcha, or an exhausted p-time '
  'retry budget). Written by recordPenalty() in src/lib/tradovate/connections.ts '
  'as now + PENALTY_BACKOFF_MS (60 min, the FAQ''s own "try again in about an '
  'hour"). NULL means never penalised; a value in the past means the lockout '
  'expired and is the normal resting state. Honoured by the import cron, the '
  'orders cron, POST /api/tradovate/sync and GET /api/tradovate/live -- NOT by '
  'the keep-alive, which makes one renewal call a day and whose job is to stop '
  'the connection dying while the trader waits the hour out.';


-- ---------------------------------------------------------------------------
-- 2. tradovate_connections.last_sync_at — the cooldown
--
-- REF-112 §4.5 item 2, "the single cheapest missing cap". POST
-- /api/tradovate/sync is fifteen to twenty upstream calls, it is
-- trader-triggered, and the client guard is DESIGNED to be bypassed on an
-- explicit click (syncClock.ts) — so holding the button down is a one-user
-- denial of service against their own Tradovate quota.
--
-- Stamped by the CONDITIONAL UPDATE that also enforces the window, so the
-- check and the claim are one statement and two concurrent requests cannot
-- both pass it. See `claimSyncSlot`.
-- ---------------------------------------------------------------------------

ALTER TABLE tradovate_connections
  ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;

COMMENT ON COLUMN tradovate_connections.last_sync_at IS
  'REF-112. When POST /api/tradovate/sync last ran for this user. Read and '
  'written by one conditional UPDATE (claimSyncSlot in '
  'src/lib/tradovate/connections.ts) so the SYNC_COOLDOWN_MS window is claimed '
  'atomically rather than checked and then stamped. NULL means never synced '
  'through that route. Not a record of every broker read -- /today, /trades and '
  'the crons do not touch it.';


-- ---------------------------------------------------------------------------
-- 3-5. The three cron cursors
--
-- REF-112 §4.5 item 6 and §4.6 item 1. `listConnectionsForImport` had no
-- `.limit()`, no `.range()` and no resume cursor: it returned EVERY active
-- connection, ordered by `user_id ASC`, iterated serially with zero pacing
-- inside a 60-second function. The orders cron costs fifteen to twenty
-- requests a trader, so it runs out of budget at roughly ten users — and
-- because the ordering never rotates, THE SAME USERS ARE STARVED EVERY NIGHT.
-- For that job the loss is permanent: `/order/list` has `depthDays = 0`, so
-- tomorrow's run cannot pick up what tonight's missed.
--
-- "Least recently processed first" rather than a stored cursor row, and the
-- difference matters. A cursor row is one more piece of state to get wrong —
-- it can point past the end of the list, it can be stale after a disconnect,
-- and two overlapping runs fight over it. A per-connection timestamp cannot:
-- it is stamped on the row that was actually processed, `NULLS FIRST` puts a
-- never-processed connection at the head of the queue, and every run reaches
-- the twenty users who have waited longest BY CONSTRUCTION. Fairness is a
-- property of the ORDER BY instead of a thing the code maintains.
--
-- ONE COLUMN PER JOB, AND THEY MUST NOT BE SHARED. The three jobs run at
-- different hours and cover different users: the 20:00 import takes every
-- active connection, the 21:30 orders run takes the same list but costs double
-- per user, and send-alerts imports only the users whose chosen hour this
-- invocation is. A single shared column would let the 21:30 run read the 20:00
-- run's stamps as "already served tonight" and skip the very users it exists
-- to reach.
-- ---------------------------------------------------------------------------

ALTER TABLE tradovate_connections
  ADD COLUMN IF NOT EXISTS last_import_at TIMESTAMPTZ;

COMMENT ON COLUMN tradovate_connections.last_import_at IS
  'REF-112. When the 20:00 UTC import cron last PROCESSED this connection -- '
  'stamped whether the pull succeeded or failed, because the point is rotation '
  'and a failing user must not hold the head of the queue forever. The cron '
  'orders by this column ASC NULLS FIRST and takes IMPORT_BATCH_LIMIT rows, so '
  'every user is reached across runs. NULL means never processed, which sorts '
  'first.';

ALTER TABLE tradovate_connections
  ADD COLUMN IF NOT EXISTS last_orders_at TIMESTAMPTZ;

COMMENT ON COLUMN tradovate_connections.last_orders_at IS
  'REF-112. When the 21:30 UTC orders cron last PROCESSED this connection. Its '
  'own column and not shared with last_import_at: the two jobs run ninety '
  'minutes apart over the same users, and one shared stamp would let the second '
  'skip everyone the first served. THE JOB THIS MATTERS MOST FOR -- /order/list '
  'has depthDays = 0, so a user this run does not reach loses that day''s stop '
  'history permanently.';

ALTER TABLE tradovate_connections
  ADD COLUMN IF NOT EXISTS last_alert_import_at TIMESTAMPTZ;

COMMENT ON COLUMN tradovate_connections.last_alert_import_at IS
  'REF-112. When send-alerts last ran an import-before-summary for this user. '
  'Rations the IMPORT only; the EMAIL is never rationed and never ordered by '
  'this column -- a trader whose import did not fit this invocation still gets '
  'their summary, built from the rows already in the journal, which is the '
  'degradation importBeforeSummary was already written to accept.';


-- ---------------------------------------------------------------------------
-- 6. tradovate_call_counts — how many calls one trader cost us today
--
-- REF-112 §4.5 item 1: "A per-user call budget or counter of any kind.
-- Nothing counts. There is no way today to answer 'how many calls did user X
-- make yesterday'." This answers exactly that question and no other.
--
-- A TABLE AND NOT A COLUMN ON tradovate_connections, which is the one
-- placement decision here worth defending. The live poll alone is 240 requests
-- an hour per holding trader, so this row is written on the order of hundreds
-- of times a day per user. Putting that on the connection row would:
--
--   - fire 017's `tradovate_connections_updated_at` trigger every time, so
--     `updated_at` on a CREDENTIAL row would mean "we made an API call" rather
--     than "the token changed";
--   - put counter writes in contention with saveConnection's compare-and-swap,
--     which conditions an UPDATE on the stored refresh-token ciphertext; and
--   - churn a table whose rows are tokens, for a number that is diagnostics.
--
-- Two columns in the key, so the history is kept rather than reset in place: a
-- counter that zeroes itself at midnight cannot answer "how many YESTERDAY",
-- which is the question §4.5 actually asked. Old days are pruned by hand or by
-- a later job; nothing in this file deletes anything.
--
-- THE DAY IS UTC, like every other boundary in this integration's background
-- jobs (`setUTCHours(0,0,0,0)` in both crons). It is NOT the trader's trading
-- day and must not be read as one — a trader's evening session straddles two
-- rows here. That is acceptable because the consumer is an operator reading a
-- cron summary, not a figure shown to anyone.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tradovate_call_counts (
  -- ON DELETE CASCADE, like 017's own user_id: deleting the auth user takes
  -- their call history with it, and /api/account/delete therefore needs no
  -- change to stay complete.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- UTC calendar day. See the header on why this is not the trading day.
  call_day DATE NOT NULL,

  -- Upstream Tradovate requests made with THIS user's OAuth token, counted in
  -- src/lib/tradovate/client.ts -- the one place every such request passes
  -- through. Requests made with the application's own password-grant session
  -- have no user to attribute and are not counted here.
  calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The composite key is what makes the increment below an upsert rather than
  -- a read-modify-write.
  PRIMARY KEY (user_id, call_day)
);

COMMENT ON TABLE tradovate_call_counts IS
  'REF-112 §4.5 item 1. Upstream Tradovate requests per user per UTC day. '
  'VISIBILITY ONLY -- nothing reads this to refuse a request, and it must not '
  'grow a threshold until REF-112 §4.1''s unsourced "5,000 requests per hour" '
  'figure has been replaced by a measured one. Service-role only: no grants, no '
  'RLS policy, nothing reaches the browser.';

-- 017's argument, restated for a new table: Supabase's default privileges
-- grant ALL on new public tables to anon and authenticated, so take that back
-- before granting anything. Here nothing is granted afterwards at all.
REVOKE ALL ON tradovate_call_counts FROM PUBLIC;
REVOKE ALL ON tradovate_call_counts FROM anon;
REVOKE ALL ON tradovate_call_counts FROM authenticated;

-- Belt and braces behind the `ensure_rls` event trigger, which already turns
-- this on for anything created in `public`. Stated so that a reader of this
-- file does not have to know about a trigger that lives in no migration.
ALTER TABLE tradovate_call_counts ENABLE ROW LEVEL SECURITY;

-- There is deliberately NO POLICY OF ANY KIND. RLS denies by default, so with
-- no policy every client read and every client write is rejected regardless of
-- what a future blanket grant does.


-- ---------------------------------------------------------------------------
-- 6b. bump_tradovate_calls() — the atomic increment
--
-- WHY A FUNCTION. `calls = calls + $n` is not expressible through PostgREST:
-- the client can only send a literal, so the alternative is read-then-write,
-- which loses counts whenever two of a trader's lambdas flush at once — and
-- the live poll makes that the normal case rather than a race to worry about
-- later.
--
-- NOT `SECURITY DEFINER`, and that is deliberate. The only caller is the
-- service role, which bypasses RLS already, so definer rights would buy
-- nothing and would put this function in the class of object
-- supabase/queries/security_assertions.sql watches. `SECURITY INVOKER` (the
-- default) plus a grant to `service_role` alone is the smaller claim.
--
-- `search_path` is still pinned. A function with an unpinned search_path is a
-- hazard whether or not it is definer, and every other function in this schema
-- pins it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bump_tradovate_calls(
  p_user_id UUID,
  p_day     DATE,
  p_calls   INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- A non-positive flush is a caller bug rather than something to record. It
  -- is ignored rather than raised: this function is called in a `finally` on
  -- the way out of a request, and a throw there would turn a diagnostic into
  -- a failed pull.
  IF p_calls IS NULL OR p_calls <= 0 THEN
    RETURN;
  END IF;

  INSERT INTO tradovate_call_counts (user_id, call_day, calls, updated_at)
  VALUES (p_user_id, p_day, p_calls, NOW())
  ON CONFLICT (user_id, call_day) DO UPDATE
    SET calls      = tradovate_call_counts.calls + EXCLUDED.calls,
        updated_at = NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.bump_tradovate_calls(UUID, DATE, INTEGER) FROM PUBLIC;
-- `authenticated` is named explicitly, not merely left out of the grant: a
-- trader must not be able to inflate or invent their own call history, and a
-- future blanket grant on the schema would otherwise reach this.
REVOKE ALL ON FUNCTION public.bump_tradovate_calls(UUID, DATE, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.bump_tradovate_calls(UUID, DATE, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bump_tradovate_calls(UUID, DATE, INTEGER) TO service_role;

COMMIT;


-- ===========================================================================
-- VERIFY (read-only, after COMMIT)
-- ===========================================================================
--
-- 1. The five columns exist, are all TIMESTAMPTZ, all nullable, and NONE has a
--    default. EXPECT five rows, every one `timestamp with time zone` / YES /
--    NULL. A non-null `column_default` is the one outcome to act on — see the
--    header on why NULL is load-bearing on all five.
--
--      SELECT column_name, data_type, is_nullable, column_default
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'tradovate_connections'
--         AND column_name IN ('penalised_until', 'last_sync_at',
--                             'last_import_at', 'last_orders_at',
--                             'last_alert_import_at')
--       ORDER BY column_name;
--
-- 2. Every existing row is NULL on all five. EXPECT five zeroes. Anything else
--    means this file has already run and the crons have been through at least
--    one pass, which is fine — but then (6) below is no longer a clean test.
--
--      SELECT count(*) FILTER (WHERE penalised_until      IS NOT NULL) AS penalised,
--             count(*) FILTER (WHERE last_sync_at         IS NOT NULL) AS synced,
--             count(*) FILTER (WHERE last_import_at       IS NOT NULL) AS imported,
--             count(*) FILTER (WHERE last_orders_at       IS NOT NULL) AS ordered,
--             count(*) FILTER (WHERE last_alert_import_at IS NOT NULL) AS alerted
--        FROM tradovate_connections;
--
-- 3. **THE IMPORTANT ONE.** The five new columns are NOT readable by the
--    browser. EXPECT the SAME seven column names survey 4 returned and not one
--    more — id, user_id, status, tradovate_user_id, expires_at, created_at,
--    updated_at. If any of the five appears here, a grant has gone wrong and a
--    signed-in user can read when we last called Tradovate for them.
--
--      SELECT grantee, column_name, privilege_type
--        FROM information_schema.column_privileges
--       WHERE table_schema = 'public' AND table_name = 'tradovate_connections'
--         AND grantee IN ('anon', 'authenticated', 'PUBLIC')
--       ORDER BY grantee, column_name;
--
-- 4. The counter table exists, RLS is ON, and it has NO POLICIES. EXPECT
--    rowsecurity = true and zero policy rows. A policy here is the one result
--    that would mean a client can reach it.
--
--      SELECT relrowsecurity AS rowsecurity
--        FROM pg_class WHERE oid = 'public.tradovate_call_counts'::regclass;
--      SELECT policyname, cmd FROM pg_policies
--       WHERE schemaname = 'public' AND tablename = 'tradovate_call_counts';
--
-- 5. Nobody but the service role can execute the increment, and nobody but the
--    service role can touch the table. EXPECT false, false, false for the
--    function and zero rows for the table grants.
--
--      SELECT has_function_privilege('public',        'public.bump_tradovate_calls(uuid,date,integer)', 'EXECUTE') AS public_can,
--             has_function_privilege('anon',          'public.bump_tradovate_calls(uuid,date,integer)', 'EXECUTE') AS anon_can,
--             has_function_privilege('authenticated', 'public.bump_tradovate_calls(uuid,date,integer)', 'EXECUTE') AS authed_can;
--
--      SELECT grantee, privilege_type FROM information_schema.table_privileges
--       WHERE table_schema = 'public' AND table_name = 'tradovate_call_counts'
--         AND grantee IN ('anon', 'authenticated', 'PUBLIC');
--
-- 6. The increment ADDS rather than replaces, and is safe to call twice. Run
--    the three statements in order against a real connected user id. EXPECT
--    calls = 7 on the first read and 7 again after the zero-call flush.
--    DELETE THE ROW AFTERWARDS if the user is a real trader — this is a write,
--    and it is the only verify here that is not read-only.
--
--      SELECT bump_tradovate_calls('<user_id>'::uuid, CURRENT_DATE, 3);
--      SELECT bump_tradovate_calls('<user_id>'::uuid, CURRENT_DATE, 4);
--      SELECT calls FROM tradovate_call_counts
--       WHERE user_id = '<user_id>' AND call_day = CURRENT_DATE;      -- 7
--      SELECT bump_tradovate_calls('<user_id>'::uuid, CURRENT_DATE, 0);
--      SELECT calls FROM tradovate_call_counts
--       WHERE user_id = '<user_id>' AND call_day = CURRENT_DATE;      -- 7
--      DELETE FROM tradovate_call_counts
--       WHERE user_id = '<user_id>' AND call_day = CURRENT_DATE;
--
-- 7. After the deploy and one night: THE CURSORS ARE MOVING AND NOBODY IS
--    STUCK. This is the verify that proves REF-112 §4.6 item 1 is actually
--    fixed, and it needs two nights to be meaningful. EXPECT every active
--    connection to have a non-null `last_orders_at` within the last 48 hours
--    once the user count is below IMPORT_BATCH_LIMIT, and — above it — EXPECT
--    the oldest stamp to keep moving forward night over night rather than
--    sitting still on the same rows.
--
--      SELECT status,
--             count(*)                                  AS connections,
--             count(*) FILTER (WHERE last_orders_at IS NULL) AS never_reached,
--             min(last_orders_at)                       AS oldest,
--             max(last_orders_at)                       AS newest
--        FROM tradovate_connections
--       GROUP BY status;
--
-- 8. And the counter has something in it. EXPECT one row per active trader per
--    day they used the app. A trader with a connection and no row at all means
--    the flush is not reaching the database — check for a logged
--    `[tradovate][calls]` kind.
--
--      SELECT call_day, count(*) AS users, sum(calls) AS calls, max(calls) AS heaviest_user
--        FROM tradovate_call_counts
--       GROUP BY call_day ORDER BY call_day DESC LIMIT 7;
--
-- 9. The standing security assertions still come back clean. Run
--    supabase/queries/security_assertions.sql. EXPECT the usual two query-9
--    rows for setup-images and NOTHING NEW — this file adds a table and a
--    function, which is exactly the class of object those assertions watch.
--    `bump_tradovate_calls` is SECURITY INVOKER precisely so it does not
--    appear in the definer-function assertion; if it does, the function was
--    created differently from this file.
--
--
-- ROLLBACK
-- --------
--
-- SAFE TO RUN UNDER THE CURRENT DEPLOYMENT, all of it, and that is the same
-- property the header's deploy-order section argues: every statement that
-- names any of these six objects treats its own failure as "the cap is not
-- there". Rolling back therefore returns the app to its pre-REF-112 §4
-- behaviour rather than breaking it — the sync cooldown stops rejecting, the
-- penalty lockout stops being recorded, the crons go back to a stable prefix
-- of users ordered by `user_id`, and nothing counts.
--
-- It is still the wrong order. Roll the CODE back first if the code is the
-- problem; the caps are worth more than the columns are expensive.
--
--   ALTER TABLE tradovate_connections DROP COLUMN IF EXISTS penalised_until;
--   ALTER TABLE tradovate_connections DROP COLUMN IF EXISTS last_sync_at;
--   ALTER TABLE tradovate_connections DROP COLUMN IF EXISTS last_import_at;
--   ALTER TABLE tradovate_connections DROP COLUMN IF EXISTS last_orders_at;
--   ALTER TABLE tradovate_connections DROP COLUMN IF EXISTS last_alert_import_at;
--   DROP FUNCTION IF EXISTS public.bump_tradovate_calls(UUID, DATE, INTEGER);
--   DROP TABLE IF EXISTS tradovate_call_counts;
--
-- DESTRUCTIVE ON TWO OF THEM AND HARMLESS ON THE REST. Dropping
-- `tradovate_call_counts` destroys the only record of how much the integration
-- has cost per trader, which is the measurement REF-112 §4.1 says the whole
-- design is missing — keep a dump of it before dropping if the numbers have
-- not been read yet. Dropping `penalised_until` loses any lockout currently in
-- force, so a trader mid-captcha is immediately polled again; prefer waiting
-- an hour. The three cursors lose only their place in the queue, which the
-- next run re-establishes from NULL.

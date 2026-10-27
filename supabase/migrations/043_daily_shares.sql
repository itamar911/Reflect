-- REF-125 Stage 2: the share record, and the one opt-in handle it may print.
--
-- Three objects, and between them they are the entire storage half of "share
-- my trading day as a link":
--
--   1. daily_shares                 -- one row per link the trader has minted
--   2. daily_shares.* policies      -- owner select/insert/update, nothing else
--   3. profiles.public_nickname     -- the only name a stranger may ever see
--
-- RUN THIS BY HAND in the Supabase SQL Editor. Nothing in the repo applies
-- migrations.
--
-- NUMBERING: 021 lands on the `ai-usage-accounting` branch and 029 is reserved
-- for rule_violations and setup_images_delete (REF-89); neither has a file and
-- neither may be reused. 042 is REF-112's rate-and-penalty state. 043 is the
-- next number that is neither taken nor reserved.
--
--
-- WHAT A ROW HERE IS
-- ------------------
--
-- A CAPABILITY AND A FROZEN DOCUMENT. `token` is 256 bits of randomness and is
-- the whole of the authorisation: whoever holds it may read `snapshot` and
-- nothing else, for as long as `revoked_at` is NULL. There is no sharing
-- relationship, no recipient, no grant — the link IS the permission, which is
-- why there is no second table here and no join.
--
-- `snapshot` is the card as it read AT THE MOMENT IT WAS MINTED, and freezing
-- it is the point rather than a cost. src/lib/journal/debrief.ts:9-27 argues
-- the opposite case — that a stored derived value freezes a number the product
-- has since decided was wrong — and that argument is correct for a debrief
-- score and wrong here, for two reasons a reader should not have to re-derive:
--
--   - A LINK MUST NOT CHANGE UNDER ITS READER. Somebody sent this to their
--     trading group on Tuesday. If the page recomputed, a later edit to one
--     trade, a later broker sync, or a later change to how the product defines
--     "followed the plan" would silently rewrite what they shared. The trader
--     published a claim about one day; the claim has to stay the one they made.
--
--   - THE READER HAS NO RIGHT TO THE INPUTS. Recomputing means reading
--     `trade_plans` on behalf of an anonymous visitor. Freezing means the only
--     thing the public path ever touches is this column, and the reduction
--     happened once, on the server, under the trader's own session. That is
--     what makes the blast radius auditable: see "THE SNAPSHOT IS THE ATTACK
--     SURFACE" below.
--
-- So this sits on the `weekly_summaries.stats` side of the precedent, and it
-- inherits that side's known cost, documented at 033:32 — historical rows hold
-- data shaped the way the product shaped it then. Here that is a feature: an
-- old card is a record of an old day.
--
--
-- ORDER RELATIVE TO THE DEPLOY — EITHER ORDER IS SAFE
-- --------------------------------------------------
--
-- **THE CODE IS SAFE TO DEPLOY BEFORE THIS FILE RUNS**, and as in 042 that is
-- a property of the code rather than a hope about it. The mechanism is the one
-- 042's header describes: every statement naming one of these objects treats
-- its own failure as the ABSENCE OF THE FEATURE rather than as an error.
--
--   - `src/lib/share/store.ts` routes every read and write through one place,
--     and `isMissingTable()` (src/lib/supabase/missing.ts) classifies 42P01 and
--     PGRST205 as "not deployed yet". The two API routes answer 503 with
--     `{ error: 'share_unavailable' }`, the dashboard's GET answers the same,
--     and the button is NOT RENDERED at all — so a trader on a pre-043
--     deployment sees the product they saw yesterday, with no broken control
--     and no failed request behind it.
--
--   - `profiles.public_nickname` is a COLUMN and therefore a different code:
--     42703, or PGRST204 from the schema cache. It is never named in the
--     dashboard's own `select`, only in a one-column read of its own
--     (`readPublicNickname`), whose failure answers null — and null is already
--     the value that means "this trader has not opted in", so a pre-043
--     database renders every card anonymously, which is the correct card for a
--     database in which nobody can have opted in.
--
-- SO: either order works, and the degradation is "the feature is not there
-- yet" in both cases, never "the dashboard failed". Running this file first is
-- still preferable — then there is no window in which the button is absent for
-- a reason nobody can see from the UI.
--
-- 038's and 040's hazard is the one being avoided: their columns were named in
-- the import's single SELECT, so a 42703 took the whole operation down with the
-- feature. Nothing here is named in any pre-existing select.
--
--
-- BEFORE RUNNING IT — SURVEY
-- --------------------------
--
-- supabase/migrations/ does not describe the live database: objects here have
-- been created by hand in the dashboard and leave no trace in the repo (see
-- CLAUDE.md and supabase/README.md). Read all six and read the output.
--
--   -- 1. The table does not already exist. EXPECT zero rows. A row means
--   --    somebody built this by hand; read its columns against step 1 below
--   --    before letting `IF NOT EXISTS` quietly do nothing over a different
--   --    shape. The CHECK constraints are the ones to compare — a table with
--   --    the right column names and no token CHECK accepts a four-character
--   --    token.
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_name = 'daily_shares';
--
--   -- 2. `profiles.public_nickname` does not already exist. EXPECT zero rows.
--   --    A row means it was added by hand: compare `data_type` (must be
--   --    `text`) and `is_nullable` (must be YES — see step 5 on why NULL is
--   --    the opt-out), then let the `IF NOT EXISTS` do nothing.
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'profiles'
--      AND column_name = 'public_nickname';
--
--   -- 3. WHAT IS ALREADY GRANTED ON `profiles`, in front of you before a
--   --    column is added to it. EXPECT a table-level grant to
--   --    `authenticated` and NO column rows. If this comes back as a COLUMN
--   --    LIST, stop and read step 5: a new column on a column-granted table is
--   --    unreadable by its own owner until somebody names it, which is 017's
--   --    arrangement and NOT this table's.
--   SELECT grantee, column_name, privilege_type
--     FROM information_schema.column_privileges
--    WHERE table_schema = 'public' AND table_name = 'profiles'
--      AND grantee IN ('anon', 'authenticated', 'PUBLIC')
--    ORDER BY grantee, column_name;
--
--   -- 4. `update_updated_at()` exists, because step 6 is the only statement in
--   --    this file that depends on it. EXPECT one row. 026's lesson as a
--   --    precondition, and 037 survey 5's: without the function the trigger
--   --    would fail, and inside one transaction it cannot fail alone — it takes
--   --    the file with it, which is the better outcome and is why this asks.
--   SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'update_updated_at';
--
--   -- 5. `gen_random_uuid()` is reachable. EXPECT one row. pgcrypto is enabled
--   --    by supabase/schema.sql and every table since has used this default, so
--   --    a zero here means something larger is wrong than this file.
--   SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'uuid-ossp');
--
--   -- 6. THE STANDING ASSERTIONS, BEFORE. Run supabase/queries/
--   --    security_assertions.sql and KEEP THE OUTPUT. EXPECT the usual two
--   --    query-9 rows for setup-images and nothing else. This file adds a table
--   --    and three policies, which is exactly the class of object those
--   --    assertions watch, and VERIFY 7 below is a comparison against this
--   --    reading rather than against memory.
--
--
-- WHO MAY READ ANY OF THIS
-- -----------------------
--
-- THE OWNER, THROUGH RLS — AND THE SERVER. Nobody else, and in particular
-- **`anon` IS GRANTED NOTHING HERE**, which is the single most important
-- sentence in this file.
--
-- That is not caution, it is the repo's standing invariant. There is no
-- `GRANT ... TO anon` anywhere in supabase/, there is no policy naming `anon`,
-- and /api/cron/security-assertions asserts it nightly at 03:30 (vercel.json).
-- Rule 3 of supabase/queries/security_assertions.sql fires on any policy whose
-- roles include `public` OR `anon`, and 024:42-45 records what the shape costs:
-- `get_user_tier` was SECURITY DEFINER, returned a scalar, and "answered 'what
-- tier is this user' to anyone holding a user UUID, over HTTP, with no
-- authentication, bypassing RLS."
--
-- THE PUBLIC PAGE THEREFORE DOES NOT READ THIS TABLE AS `anon`. It is a server
-- component: the browser never holds a Supabase client, never holds a key, and
-- never issues a PostgREST request. `/share/[token]` calls `createAdminClient()`
-- (service role, server-only) and the service role bypasses RLS by definition,
-- so an anonymous VISITOR is served by an authenticated READER. Nothing about
-- the table has to be opened for that to work, and nothing is.
--
-- THE TICKET'S RPC IS DELIBERATELY NOT HERE. REF-125 §4.3 proposed a
-- `SECURITY DEFINER` `read_daily_share(p_token)` granted to `service_role`
-- alone, and it would be a real improvement on one axis: a function returning
-- `snapshot` and nothing else cannot be made to leak `user_id`, however the
-- call site is later edited. What replaces it is a narrower rule in one place —
-- `readSharedSnapshot()` in src/lib/share/store.ts is the ONLY code that reads
-- this table with the service role, and it names three columns
-- (`snapshot, revoked_at, trading_day`). There is no `select('*')` on the
-- public path to leak anything. That is weaker than the RPC by exactly the
-- amount a reviewer has to trust a column list over a function signature, and
-- the trade is taken knowingly: a function would be the first object in this
-- schema whose whole purpose is to be reachable on behalf of a stranger, it
-- would appear in schema_drift.sql query 13 as CALLABLE OVER HTTP, and Stage 3
-- (the PNG) will want the same read from the same module. Revisit if a second
-- public reader ever appears.
--
--
-- THE SNAPSHOT IS THE ATTACK SURFACE
-- ----------------------------------
--
-- `snapshot` is the only column a stranger's eyes ever reach, so it is the only
-- place a privacy mistake can happen — and the mistake would be made by the
-- WRITER, in TypeScript, not by a grant here. Two consequences:
--
--   - What may be in it is enumerated in src/lib/share/snapshot.ts, which is an
--     allow-list and not a redaction pass: the builder names every field it
--     emits and copies nothing wholesale. src/lib/ai/tradeFacts.ts is the
--     existing precedent for the shape.
--
--   - What may NEVER be in it is asserted by scripts/share-leak-check.ts, which
--     serialises a snapshot built from fixtures and greps the JSON for the
--     fixture's account ids, broker display names, email and user id. REF-125
--     §2.5 is the list; portfolio.ts:34-41 is the sharpest item on it ("On a
--     prop trader's account `display_name` is a firm's name ... never in a log
--     line, never in an error message, and NEVER IN AN AI PROMPT" — a public
--     card is strictly worse than an AI prompt).
--
-- No CHECK on the column enforces any of that, and none could: it is JSONB with
-- a shape that will grow. The guarantee is the writer plus the suite.
--
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ---------------------------------------
--
--   - NO DELETE POLICY, and therefore no way for a trader to delete a share
--     row through PostgREST. Revocation is a STAMP (`revoked_at`), the same
--     decision `trade_plans.hidden` records at 034:242-243 and for a sharper
--     reason: a deleted row cannot answer "this link was revoked", and the
--     audit trail of what was published and when is the only record that a
--     public claim was ever made. Account deletion still takes these rows —
--     that is the `ON DELETE CASCADE` on `user_id`, not a policy.
--
--   - NO UNIQUE ON (user_id, trading_day). Re-sharing a day MINTS A NEW TOKEN
--     and leaves the old row revocable on its own, because one row per day
--     would mean revoking today's link silently breaks the link shared last
--     week. REF-125 §7.
--
--   - NO EXPIRY, no TTL column and no cleanup job. The ticket asks for
--     owner-controlled revocation and nothing else. A share with no expiry is a
--     decision the revoke button is the answer to.
--
--   - NO CHECK ON `snapshot`, which is the house rule for every JSONB column in
--     this schema (`stop_history`, `broker_stages`, `weekly_summaries.stats`)
--     and the reason every one of them is read through a defensive reader.
--     `readDailyShareSnapshot()` is this column's.
--
--   - NO `anon` GRANT, NO RPC, NO VIEW. See above. A view would be worse than
--     either: schema_drift.sql query 12 exists because a view is the way round
--     RLS entirely.
--
--   - NO COLUMN GRANT ON `token`, and this one is a trap worth naming. Rule 7
--     of security_assertions.sql matches `attname ~* '(token|secret|key|
--     password)'` granted to `anon` or `authenticated`, so a column grant here
--     would fire it nightly. The table takes its table-level default grant
--     instead and the policies do the constraining, exactly as `trade_plans`
--     and `accounts` do. Rule 7 reads `pg_attribute.attacl`, which holds only
--     COLUMN-level grants, so a table-level grant leaves it silent — that is
--     the arrangement, not a loophole being exploited.
--
--   - NO BACKFILL, AND NONE IS POSSIBLE. Nothing has ever shared a day, so the
--     table starts empty and `public_nickname` starts NULL for everyone. NULL
--     is the opt-out and the only safe starting value: defaulting it from
--     `profiles.display_name` would publish real names and email local-parts
--     for every trader who never chose a handle, because that is what
--     `display_name` is seeded with (schema.sql:40-45,
--     `COALESCE(raw_user_meta_data->>'full_name', split_part(email,'@',1))`).
--     REF-125 §2.6.
--
--
-- IDEMPOTENT. One `CREATE TABLE IF NOT EXISTS`, one `ADD COLUMN IF NOT
-- EXISTS`, three drop-then-create policies, two `CREATE INDEX IF NOT EXISTS`,
-- one `CREATE OR REPLACE TRIGGER`. Safe to re-run. One transaction, so a
-- failure anywhere leaves the schema exactly as it was.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. daily_shares — one row per link minted.
--
-- Column order follows 037: identity, then the capability, then the subject,
-- then the document, then the lifecycle stamps, with created_at/updated_at
-- last.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS daily_shares (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE, like 017's and 037's: deleting the auth user takes
  -- every card they ever published with it, so /api/account/delete needs no
  -- change to stay complete. It DOES need this table in its sweep list to be
  -- able to PROVE they are gone — see src/lib/account/deleteAccount.ts.
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- THE CAPABILITY. `randomBytes(32).toString('base64url')` — 256 bits, 43
  -- characters, the same construction and the same reasoning as
  -- src/lib/tradovate/oauth-state.ts ("not guessable, and cheap").
  --
  -- NOT SIGNED AND NOT DERIVED FROM A KEY, which is a decision rather than a
  -- shortcut. A signed token proves authenticity without a lookup; this one
  -- needs a lookup anyway, because `revoked_at` can only be read from the row.
  -- Given the lookup, randomness is the whole security property and an HMAC
  -- would add a key to rotate for nothing. In particular it must NOT reuse
  -- TRADOVATE_TOKEN_ENCRYPTION_KEY: coupling a share link's lifetime to the
  -- BROKER key's rotation is a connection nobody would choose on purpose
  -- (REF-125 §1.4).
  --
  -- THE CHECK IS THE ONE PLACE THE TOKEN'S STRENGTH IS A DATABASE INVARIANT.
  -- The generator lives in TypeScript and can be edited; this cannot be
  -- satisfied by a short or a non-URL-safe token however the generator changes,
  -- and a row hand-inserted in the SQL editor with token = 'test' is rejected
  -- rather than published. 24 characters is the floor the ticket sets (~143
  -- bits at this alphabet) and is well under the 43 the generator emits, so it
  -- is a floor and not a description.
  token         TEXT NOT NULL UNIQUE
                  CONSTRAINT daily_shares_token_shape_check
                  CHECK (length(token) >= 24 AND token ~ '^[A-Za-z0-9_-]+$'),

  -- WHICH DAY THE CARD DESCRIBES, named the way src/lib/tradingDay.ts names it:
  -- the CME trading day, by its Chicago closing date (REF-125 Stage 1).
  --
  -- NOT THE UTC CALENDAR DAY, and `tradovate_call_counts.call_day` is the
  -- counter-example to keep in view — that column IS a UTC day, deliberately,
  -- because its reader is an operator reading a cron summary. This one is shown
  -- to a stranger as "יום מסחר 27.10", so it has to be the day the product
  -- means by "today" everywhere else. A DATE and not a timestamptz because a
  -- trading day is a NAME, not an instant; the instants it spans are derived
  -- from it by `tradingDayBounds()` and are not stored.
  trading_day   DATE NOT NULL,

  -- THE FROZEN CARD, and the only column a stranger ever reads. Nullable, no
  -- default, no CHECK -- the house rule for every JSONB column in this schema,
  -- and read defensively by `readDailyShareSnapshot()`. See "THE SNAPSHOT IS
  -- THE ATTACK SURFACE" in the header for what may and may not be in it.
  --
  -- NULLABLE rather than NOT NULL because a reader must handle a malformed
  -- document anyway -- it is JSONB with no CHECK -- and once it handles that,
  -- NULL is one more case it already covers. A NOT NULL would buy a guarantee
  -- the reader cannot use.
  snapshot      JSONB,

  -- WHAT THE TRADER AGREED TO SHOW. Three flags, ALL FALSE BY DEFAULT, and the
  -- default direction is the security property: a row inserted by code that has
  -- not been taught about a flag shows LESS, never more.
  --
  -- NOT NULL WITH A DEFAULT, unlike `snapshot` beside it, and the difference is
  -- real rather than inconsistency. `snapshot` is a document whose shape will
  -- grow; this is a fixed set of booleans with a safe resting value, and
  -- "absent" has no useful meaning for it -- a card either shows the nickname
  -- or it does not. `readShareVisibility()` still validates every field, so the
  -- default is a convenience for the writer and not a promise to the reader.
  --
  -- `accounts` AND `balance` ARE NOT WIRED IN STAGE 2 and nothing can set them
  -- true from the UI yet: neither value is in the snapshot at all, because
  -- REF-125 §2.5 puts `accounts.display_name` (a prop firm's name) and anything
  -- account-size-shaped on the never-leaves-the-server list. They exist as
  -- columns now so that turning one on later is a UI change and a snapshot
  -- field, not a migration -- and so that an old row's answer to "did this
  -- trader consent to showing a balance" is a recorded false rather than a
  -- missing key.
  visibility    JSONB NOT NULL
                  DEFAULT '{"nickname": false, "accounts": false, "balance": false}'::JSONB,

  -- NULL MEANS NEVER REVOKED. A stamp, not a delete -- see the header. Readers
  -- filter `revoked_at IS NULL`, which makes a revoked token indistinguishable
  -- from a token that never existed: the page 404s either way and cannot be
  -- used to probe which tokens are real.
  --
  -- WHAT REVOCATION ACTUALLY DOES, so the Hebrew in the dialog can be honest
  -- about it: it stops FUTURE visits to the page. It does not retract a copy
  -- already fetched, and from Stage 3 onward it will not unpublish an image
  -- already sitting in a WhatsApp or Twitter cache. REF-125 §7.
  revoked_at    TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE daily_shares IS
  'REF-125 Stage 2. One row per public "my trading day" link a trader has '
  'minted. `token` is the whole authorisation and `snapshot` is the whole '
  'public payload, frozen when the link was created so that a shared link '
  'cannot change under its reader and so that no anonymous visit ever reads '
  'trade_plans. Owner-only through RLS; `anon` is granted nothing. The public '
  'page reads it with the service role from a server component and names three '
  'columns -- see readSharedSnapshot() in src/lib/share/store.ts.';

COMMENT ON COLUMN daily_shares.token IS
  'REF-125. 256 bits from randomBytes(32).toString(''base64url''), 43 chars. '
  'The capability: whoever holds it may read `snapshot` and nothing else, '
  'while `revoked_at` is NULL. Unsigned on purpose -- the row has to be looked '
  'up anyway to read `revoked_at`, so randomness is the whole property. The '
  'CHECK is the floor the generator cannot be edited below.';

COMMENT ON COLUMN daily_shares.trading_day IS
  'REF-125. The CME trading day the card describes, named by its Chicago '
  'closing date -- src/lib/tradingDay.ts, Stage 1. NOT a UTC calendar day; '
  'contrast tradovate_call_counts.call_day, which is one deliberately.';

COMMENT ON COLUMN daily_shares.snapshot IS
  'REF-125. The card as it read when the link was minted. THE ONLY COLUMN A '
  'STRANGER READS, and therefore the feature''s whole privacy surface. Written '
  'by an allow-list builder (src/lib/share/snapshot.ts) that names every field '
  'it emits; asserted by scripts/share-leak-check.ts, which greps the '
  'serialised JSON for fixture account ids, broker display names, email and '
  'user id. No CHECK enforces any of that and none could.';

COMMENT ON COLUMN daily_shares.visibility IS
  'REF-125. What the trader agreed to show: {nickname, accounts, balance}, all '
  'false by default so that code which has not been taught a flag shows less '
  'rather than more. Only `nickname` is live in Stage 2 -- `accounts` and '
  '`balance` have no snapshot field behind them yet, by REF-125 §2.5.';

COMMENT ON COLUMN daily_shares.revoked_at IS
  'REF-125. NULL means never revoked. A stamp and not a delete, so the record '
  'that a claim was published survives the claim being withdrawn. Readers '
  'filter IS NULL, so a revoked token and an invented one are indistinguishable. '
  'Stops future visits; does not retract a copy already fetched or cached by a '
  'social platform.';


-- ---------------------------------------------------------------------------
-- 2. RLS, stated.
--
-- The `ensure_rls` event trigger would turn this on by itself -- it is ours,
-- it is in no migration, and it is the only reason several tables in this
-- database are not wide open. A migration should say what it means rather than
-- rely on a trigger a reader of this file cannot see. 028's rule, 037's
-- restatement, and supabase/README.md's.
-- ---------------------------------------------------------------------------

ALTER TABLE daily_shares ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- 3. The three policies — select, insert, update. There is no fourth.
--
-- `TO authenticated` ON ALL THREE IS LOAD-BEARING and is the whole of 023: a
-- policy with no TO clause applies to PUBLIC, which INCLUDES `anon`, and the
-- omission is INVISIBLE in the CREATE POLICY text. That is exactly how the
-- setup-images hole passed review sitting beside a correct policy in the same
-- file. On this table it would be the worst possible version of that mistake —
-- a `FOR SELECT` policy that forgot its TO clause would let any anonymous
-- PostgREST caller read every share row on the system, including `user_id`.
-- Rule 3 of security_assertions.sql is what catches it; these are written so it
-- never fires.
--
-- THREE PER-OPERATION POLICIES RATHER THAN ONE `FOR ALL`, which is where this
-- departs from `accounts` (037:302) and follows `personal_strategies` (004)
-- instead. The reason is the fourth operation: `FOR ALL` grants DELETE, and
-- this table must not be deletable through PostgREST (see the header). Spelling
-- the three out is how "no DELETE" becomes visible in the policy list rather
-- than being a sentence in a comment -- `pg_policies` will show exactly three
-- cmds, and VERIFY 3 asserts it.
--
-- Drop-then-create rather than `IF NOT EXISTS`, which CREATE POLICY does not
-- have, so a re-run replaces this file's own policies instead of failing on
-- them.
-- ---------------------------------------------------------------------------

-- The owner reads their own share list: the dialog's "you already have a link
-- for today" state, and the revoke button's target.
DROP POLICY IF EXISTS "daily_shares_select_own" ON daily_shares;
CREATE POLICY "daily_shares_select_own" ON daily_shares
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- WITH CHECK AND NO USING, because that is what INSERT means: there is no
-- existing row to filter, only a proposed one to constrain. Without this a
-- trader could mint a row carrying somebody else's `user_id` -- which they
-- could not then read, and which would sit in another trader's share list with
-- a token only the first trader holds.
DROP POLICY IF EXISTS "daily_shares_insert_own" ON daily_shares;
CREATE POLICY "daily_shares_insert_own" ON daily_shares
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- BOTH CLAUSES, AND THE SECOND IS NOT REDUNDANT. USING filters which rows the
-- UPDATE may see; WITH CHECK constrains what they may become. With USING alone
-- a trader could take their own row and rewrite `user_id` to somebody else's,
-- handing them a published card they never made and cannot revoke. 037:296-299
-- makes the same argument for the insert half.
--
-- This policy is what revocation and the visibility toggles both run through:
-- neither needs an RPC, because both are ordinary owner UPDATEs. What stops a
-- trader from rewriting `snapshot` to a fiction is NOT this policy -- it is
-- that the API route never writes that column on a PATCH. A trader editing
-- their own published card through PostgREST directly is not a threat this
-- table defends against, and could not be: it is their card, and the honesty
-- of the figures is what the provenance tag is for.
DROP POLICY IF EXISTS "daily_shares_update_own" ON daily_shares;
CREATE POLICY "daily_shares_update_own" ON daily_shares
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 4. Two indexes, and one of them already exists.
--
-- THE TOKEN LOOKUP NEEDS NOTHING: `UNIQUE` in step 1 creates a unique btree on
-- `token`, and that index IS the public page's entire query plan. Named here
-- because the absence of a `CREATE INDEX ... (token)` below is otherwise the
-- kind of omission a later reader "fixes" into a duplicate index.
--
-- (user_id, trading_day) is the owner's two questions -- "my shares" and "do I
-- already have one for today" -- and the second is the one the dialog asks on
-- every open.
--
-- NOT PARTIAL on `revoked_at IS NULL`, although the dialog only wants live
-- rows. A partial index would have to be re-planned the moment anything lists
-- revoked history, and at one row per trader per shared day the table is small
-- enough that the predicate is a filter rather than a scan. 042's reasoning
-- about index cost at this product's scale, applied to a much smaller table.
--
-- NOT `CONCURRENTLY`: that cannot run inside a transaction and this file is one
-- transaction on purpose. The table is empty, so the lock is nothing.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_daily_shares_user_day
  ON daily_shares (user_id, trading_day);


-- ---------------------------------------------------------------------------
-- 5. profiles.public_nickname — the only name a stranger may see.
--
-- NEITHER EXISTING NAME IS SAFE AS A PUBLIC HANDLE, which is why this is a new
-- column rather than a read of one (REF-125 §2.6):
--
--   - `profiles.display_name` is SEEDED FROM THE IDENTITY. handle_new_user()
--     writes `COALESCE(raw_user_meta_data->>'full_name',
--     split_part(email,'@',1))` (schema.sql:40-45), so its default value is a
--     real name or a fragment of an email address. Publishing it would publish
--     a legal name for every trader who never chose a handle -- and there is no
--     post-onboarding edit path for it at all (settings/page.tsx shows it
--     read-only), so they could not even take it back.
--
--   - `accounts.nickname` is per-portfolio and FALLS BACK TO THE FIRM'S NAME
--     through portfolioLabel() (portfolio.ts:34-41). On a prop account that is
--     the firm, which is the sharpest item on the never-publish list.
--
-- NULLABLE, NO DEFAULT, AND NULL IS THE OPT-OUT. A trader who has not typed a
-- handle has NULL here, the snapshot carries no name, and the card renders
-- anonymously. There is no backfill and none is possible -- see the header.
--
-- NOT NULL would be wrong and `DEFAULT ''` would be worse: an empty string is a
-- value that LOOKS like consent, and the three-state lesson
-- (stopHistory.ts:224-229, "THREE STATES, AND THE ABSENT ONE IS NOT `true`")
-- applies to consent more sharply than it does to a stop. The reader treats
-- NULL and whitespace-only alike, in one place, so a row that acquires `''`
-- some other way is still anonymous.
--
-- NO CHECK ON LENGTH OR CHARACTER SET, and that is a product decision rather
-- than an omission: this is a Hebrew-first product, the handle is free text a
-- trader chose for themselves, and a regex here would be a content policy
-- enforced by a constraint nobody can read an error message out of. The API
-- route trims it and bounds its length; see `readPublicNickname()` in
-- src/lib/share/snapshot.ts.
--
-- READABLE AND WRITABLE BY ITS OWNER THE MOMENT IT EXISTS, with no grant in
-- this file. `profiles` uses no column-level grants, so a new column on it
-- takes the table's existing arrangement -- the three "Users can ... own
-- profile" policies from schema.sql. 034 step 7, 036 step 3 and 037 step 8 say
-- the same thing at more length. Survey 3 is what confirms it before the fact.
--
-- AND IT IS NOT READABLE BY `anon`, for the same reason nothing on `profiles`
-- is: the SELECT policy is `auth.uid() = id`, and `auth.uid()` is NULL for an
-- anonymous caller, so the predicate is NULL and the row is not returned. The
-- handle reaches the public page only by having been COPIED INTO `snapshot` at
-- mint time, under the trader's own session, if and only if
-- `visibility->>'nickname'` was true. The public path never reads `profiles`.
-- ---------------------------------------------------------------------------

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS public_nickname TEXT;

COMMENT ON COLUMN profiles.public_nickname IS
  'REF-125. The opt-in handle shown on a public share card, and the ONLY name '
  'this product will print for a stranger. NULL means not opted in and is the '
  'default for every existing row -- there is deliberately no backfill from '
  'display_name, which handle_new_user() seeds from the Google full_name or the '
  'email local part. Copied into daily_shares.snapshot at mint time when '
  'visibility->>''nickname'' is true; the public page never reads profiles.';


-- ---------------------------------------------------------------------------
-- 6. updated_at.
--
-- `CREATE OR REPLACE TRIGGER` (PG14+, and Supabase is well past it) rather
-- than plain CREATE, so a re-run converges instead of raising "trigger already
-- exists" -- 026 is the file that explains why that matters, and 037 step 7
-- restates it.
--
-- WORTH HAVING ON THIS TABLE SPECIFICALLY, because unlike most of the schema
-- this table is EXPECTED to be updated after it is written: the visibility
-- toggles and the revoke stamp are both owner UPDATEs under step 3's policy.
-- `created_at` answers "when was this published" and `updated_at` answers "when
-- was it last changed", and for a public artifact those are different
-- questions somebody will eventually ask.
--
-- NOTE FOR THE OWNER: `updated_at` is the one column here that is NOT in the
-- REF-125 Stage 2 column list as written. It is added because every mutable
-- table in this schema has it and this table is mutable by design. Dropping it
-- means dropping this trigger with it; nothing in the application code reads
-- the column.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE TRIGGER daily_shares_updated_at
  BEFORE UPDATE ON daily_shares
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ---------------------------------------------------------------------------
-- 7. Grants — two REVOKEs, and nothing granted to anyone.
--
-- 017:86-92's argument, restated for a new table: Supabase's default privileges
-- grant ALL on new tables in `public` to `anon` and `authenticated`, so take
-- back what must not be there before relying on what is.
--
-- `anon` IS NAMED EXPLICITLY rather than merely left out. This is the whole
-- security posture of the feature in one line: an unauthenticated PostgREST
-- caller has no business knowing a share exists, let alone whose it is. Note
-- that RLS would already deny it -- step 3's three policies are all
-- `TO authenticated`, so `anon` matches no policy and RLS denies by default --
-- which makes this REVOKE belt and braces rather than the mechanism. Both are
-- wanted: the REVOKE survives somebody adding a policy with a missing TO
-- clause, and the policies survive somebody running a blanket
-- `GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon`.
--
-- `authenticated` IS DELIBERATELY NOT REVOKED, and this is the one line that
-- differs from 042's otherwise identical block. 042's table is service-role
-- only and revokes all three roles; this table's OWNER has to reach it, and
-- the three policies in step 3 are what they reach it through. Revoking
-- `authenticated` here would leave those policies with nothing to constrain --
-- the trader would get a permission error before RLS was ever consulted, and
-- the feature would be dead in a way no policy change explains. RLS is the
-- constraint; the grant is only the door.
--
-- NO GRANT TO `service_role` EITHER, and none is needed: the service role has
-- Supabase's default privileges on `public` already and bypasses RLS by
-- definition. 042 granted EXECUTE on a FUNCTION to `service_role`, which is a
-- different thing -- functions default to EXECUTE for PUBLIC and have to be
-- taken back and re-granted. A table needs neither.
-- ---------------------------------------------------------------------------

REVOKE ALL ON daily_shares FROM PUBLIC;
REVOKE ALL ON daily_shares FROM anon;

COMMIT;


-- ===========================================================================
-- VERIFY (read-only, after COMMIT)
-- ===========================================================================
--
-- 1. The table exists with the shape step 1 declares. EXPECT nine rows.
--    `token` and `trading_day` NOT NULL; `snapshot` and `revoked_at` nullable
--    with no default; `visibility` NOT NULL with the three-false default.
--    A NULLABLE `token` or a NULL-able `trading_day` is the one outcome to act
--    on -- both are load-bearing.
--
--      SELECT column_name, data_type, is_nullable, column_default
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'daily_shares'
--       ORDER BY ordinal_position;
--
-- 2. **THE IMPORTANT ONE.** NOBODY ANONYMOUS CAN TOUCH THIS TABLE. EXPECT
--    false for all four. A `true` on either anon column means the REVOKE in
--    step 7 did not take, or something re-granted afterwards -- stop and find
--    out what, because that is a public read of every trader's share list.
--
--      SELECT has_table_privilege('anon', 'public.daily_shares', 'SELECT') AS anon_select,
--             has_table_privilege('anon', 'public.daily_shares', 'INSERT') AS anon_insert,
--             has_table_privilege('anon', 'public.daily_shares', 'UPDATE') AS anon_update,
--             has_table_privilege('anon', 'public.daily_shares', 'DELETE') AS anon_delete;
--
--    And the owner CAN, because the policies need a door to constrain. EXPECT
--    true, true, true -- a false here is a dead feature rather than a leak.
--
--      SELECT has_table_privilege('authenticated', 'public.daily_shares', 'SELECT') AS authed_select,
--             has_table_privilege('authenticated', 'public.daily_shares', 'INSERT') AS authed_insert,
--             has_table_privilege('authenticated', 'public.daily_shares', 'UPDATE') AS authed_update;
--
-- 3. RLS is on, there are EXACTLY THREE policies, every one of them is
--    `{authenticated}`, and the cmds are SELECT/INSERT/UPDATE with NO DELETE.
--    EXPECT rowsecurity = true and three rows. A fourth row, a `{public}` in
--    `roles`, or a DELETE in `cmd` are each a finding -- see step 3's header on
--    why the missing TO clause is the invisible mistake.
--
--      SELECT relrowsecurity AS rowsecurity
--        FROM pg_class WHERE oid = 'public.daily_shares'::regclass;
--
--      SELECT policyname, cmd, roles, qual AS using_expr, with_check AS with_check_expr
--        FROM pg_policies
--       WHERE schemaname = 'public' AND tablename = 'daily_shares'
--       ORDER BY policyname;
--
-- 4. The token CHECK actually rejects a weak token, and the UNIQUE actually
--    rejects a duplicate. EXPECT both INSERTs to FAIL -- the first with
--    `daily_shares_token_shape_check`, the second with a unique violation.
--    RUN AS THE SERVICE ROLE in the SQL editor against your own user id, and
--    DELETE THE GOOD ROW AFTERWARDS. This is the only verify here that writes.
--
--      -- too short: EXPECT 23514 check_violation
--      INSERT INTO daily_shares (user_id, token, trading_day)
--      VALUES ('<your_user_id>'::uuid, 'short', '2026-10-27');
--
--      -- not URL-safe: EXPECT 23514 check_violation
--      INSERT INTO daily_shares (user_id, token, trading_day)
--      VALUES ('<your_user_id>'::uuid, 'aaaaaaaaaaaaaaaaaaaaaaaa+/=', '2026-10-27');
--
--      -- good, and it should carry the all-false visibility default
--      INSERT INTO daily_shares (user_id, token, trading_day)
--      VALUES ('<your_user_id>'::uuid, 'verify043verify043verify043', '2026-10-27');
--      SELECT visibility, revoked_at, created_at = updated_at AS untouched
--        FROM daily_shares WHERE token = 'verify043verify043verify043';
--      --   EXPECT {"balance": false, "accounts": false, "nickname": false},
--      --   NULL, and true.
--
--      -- duplicate token: EXPECT 23505 unique_violation
--      INSERT INTO daily_shares (user_id, token, trading_day)
--      VALUES ('<your_user_id>'::uuid, 'verify043verify043verify043', '2026-10-28');
--
--      -- the trigger moves updated_at and nothing else
--      UPDATE daily_shares SET revoked_at = NOW()
--       WHERE token = 'verify043verify043verify043';
--      SELECT updated_at > created_at AS trigger_fired
--        FROM daily_shares WHERE token = 'verify043verify043verify043';   -- true
--
--      DELETE FROM daily_shares WHERE token = 'verify043verify043verify043';
--
-- 5. The column on `profiles` exists, is TEXT, is nullable, has no default, and
--    IS NULL FOR EVERY EXISTING ROW. EXPECT one row (text/YES/NULL) and then a
--    count of 0. A non-zero count means something backfilled it -- read the
--    header on why that would be a privacy incident rather than a convenience,
--    and find out what wrote it before the feature ships.
--
--      SELECT column_name, data_type, is_nullable, column_default
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'profiles'
--         AND column_name = 'public_nickname';
--
--      SELECT count(*) AS opted_in FROM profiles WHERE public_nickname IS NOT NULL;
--
-- 6. NO COLUMN-LEVEL GRANT APPEARED on either table, and in particular none on
--    `token`. EXPECT zero rows. A row naming `token` and `authenticated` is
--    rule 7 of security_assertions.sql firing tomorrow at 03:30.
--
--      SELECT c.relname || '.' || a.attname AS column_name, r.rolname
--        FROM pg_attribute a
--        JOIN pg_class c     ON c.oid = a.attrelid
--        JOIN pg_namespace n ON n.oid = c.relnamespace
--        CROSS JOIN LATERAL aclexplode(a.attacl) acl
--        JOIN pg_roles r ON r.oid = acl.grantee
--       WHERE n.nspname = 'public'
--         AND c.relname IN ('daily_shares', 'profiles')
--         AND a.attacl IS NOT NULL
--       ORDER BY 1, 2;
--
-- 7. THE STANDING ASSERTIONS, AFTER — compared against the reading survey 6
--    kept. Run supabase/queries/security_assertions.sql. EXPECT **exactly what
--    survey 6 returned and not one row more**: the usual two query-9 rows for
--    setup-images. This file adds a table and three policies, which is the
--    class of object rules 1-4 watch, so a new row here is this file's and not
--    somebody else's.
--
--    Specifically EXPECT NO row for: `daily_shares` under rule 1 (RLS off) --
--    step 2 turns it on; rule 2 (RLS on, zero policies) -- step 3 writes three;
--    rule 3 (policy whose roles include public or anon) -- all three are
--    `TO authenticated`; rule 7 (secret-looking column granted) -- step 7
--    grants nothing and verify 6 is the narrower check.
--
--    Rules 5 and 10 cannot fire for this file at all: it creates no function.
--
-- 8. And the drift sweep is quiet. Run supabase/queries/schema_drift.sql.
--    EXPECT `daily_shares` absent from query 8's MISSING list, the three
--    policies absent from query 9's, `daily_shares_updated_at` absent from
--    query 6's, and NONE of the four appearing as unexpected drift in queries
--    2 and 4 -- all four lists were edited in this same change, which is what
--    schema_drift.sql:32-38 requires and is the only way this stays true.
--
--    KNOWN PRE-EXISTING NOISE, so it is not mistaken for this file's: queries 2,
--    4 and 8 do NOT know about `accounts` (037), `accounts_owner`,
--    `accounts_updated_at`, `tradovate_call_counts` (042) or
--    `bump_tradovate_calls`, because those two migrations did not edit the
--    lists. Those rows are expected and are not REF-125's. They are worth a
--    separate ticket; this file deliberately does not fix them, because adding
--    another ticket's objects to an assertion list is how an assertion list
--    starts describing what somebody assumed rather than what was checked.
--
-- 9. AFTER THE FIRST REAL SHARE, the end-to-end property worth one query:
--    every snapshot that was minted carries no identifier. EXPECT zero rows.
--    This is the database-side echo of scripts/share-leak-check.ts and catches
--    the case the suite cannot -- a snapshot written by a future build.
--
--      SELECT id, trading_day
--        FROM daily_shares
--       WHERE snapshot::text ~* '(user_id|account_id|display_name|@|broker_account)'
--       ORDER BY created_at DESC;
--
--
-- ROLLBACK
-- --------
--
-- SAFE TO RUN UNDER THE CURRENT DEPLOYMENT, all of it, and that is the same
-- property the header's deploy-order section argues: every statement naming
-- any of these objects treats its own failure as the absence of the feature.
-- Rolling back returns the app to its pre-REF-125-Stage-2 state -- the share
-- button stops rendering, the two API routes answer 503, and the public page
-- 404s -- rather than breaking anything that was working.
--
--   DROP TRIGGER IF EXISTS daily_shares_updated_at ON daily_shares;
--   DROP TABLE IF EXISTS daily_shares;                      -- takes its policies
--   ALTER TABLE profiles DROP COLUMN IF EXISTS public_nickname;
--
-- DESTRUCTIVE, AND MORE SO THAN IT LOOKS. Two things worth stopping for:
--
--   - **DROPPING THE TABLE DOES NOT UNPUBLISH ANYTHING.** Every link already
--     shared stops resolving, which is the good half; every copy already
--     fetched, screenshotted or cached by a social platform is unaffected, and
--     the record of WHAT was published and to WHICH day is gone with the rows.
--     If anything shared so far is disputed, dump the table before dropping it:
--     `CREATE TABLE daily_shares_backup_043 AS SELECT * FROM daily_shares;`
--
--   - Dropping `public_nickname` silently discards every handle a trader chose,
--     and there is no second copy anywhere -- it is deliberately not derived
--     from `display_name`. Re-running this file afterwards gives everyone a
--     NULL again, i.e. opts the whole user base back out. That is the safe
--     direction, and it is still a thing they typed and lost.
--
-- Roll the CODE back first if the code is the problem. The code is designed to
-- survive this file's absence; this file is not designed to survive the code's.

-- Tradovate connections: environment, OAuth token metadata, ciphertext guards.
--
-- Amends 017_tradovate_connections.sql. Does NOT recreate the table.
--
-- NUMBERING: 028 is written but not yet applied, and 029 is reserved for
-- rule_violations and setup_images_delete (Linear REF-89). 030 is the next
-- number that is neither taken nor reserved.
--
-- RUN THIS BY HAND in the Supabase SQL Editor. Nothing in the repo applies
-- migrations.
--
-- BEFORE RUNNING IT, run supabase/queries/tradovate_connections_state.sql and
-- read the output. This file assumes 017 landed as written, and the repo has
-- repeatedly been shown not to describe the live database — objects have been
-- created by hand in the dashboard and leave no trace here. If the table's
-- policies, grants or columns differ from what 017 says, stop and reconcile
-- first. In particular this file does NOT re-grant 017's original columns and
-- does NOT recreate its SELECT policy, so if either is missing in production,
-- this migration will not put it back.
--
--
-- WHY EACH CHANGE
-- ---------------
--
-- 1. environment — Demo and Live tokens are not interchangeable, and a stored
--    token currently carries no record of which server minted it. Reading
--    simulated fills as though they were real ones is a silent, plausible
--    failure, which is the worst kind. The OAuth flow now resolves the
--    environment from TRADOVATE_API_URL and writes it on every save.
--    Demo and Live also use different authorize and token hosts, and the Demo
--    host varies by organization:
--      https://docs.ninjatrader.com/api/oauth
--      https://docs.ninjatrader.com/api/dynamic-api-hosts
--
-- 2. refresh_expires_at — 017's comment states Tradovate issues no refresh
--    token. The REST reference contradicts it: OAuthTokenResponse lists both
--    refresh_token and refresh_token_expires_in, and the request body accepts
--    a refresh_token. 017 already provides refresh_token_encrypted but has
--    nowhere to record its expiry.
--      https://docs.ninjatrader.com/api/rest-api-endpoints/authentication/o-auth-token
--    Whether one is actually issued is Q8, unresolved until the Phase 2 test.
--
-- 3. token_type — the OAuthTokenResponse field. Expected to be "Bearer";
--    stored so a change becomes visible instead of being silently ignored.
--
-- 4. api_hosts — the dynamic-hosts page says to re-read apiHosts on every
--    authentication and use it as the base for subsequent calls. A client that
--    ignores it gets HTTP 307 on REST and 421 on WebSocket, and many HTTP
--    clients drop the Authorization header across a cross-host redirect, so the
--    symptom is a confusing 401. JSONB rather than columns because the same
--    page says to ignore unrecognised fields and that more hosts may be added.
--
-- 5. ciphertext CHECK constraints — defence in depth, see below.


-- ---------------------------------------------------------------------------
-- 1. environment
--
-- Added nullable, backfilled, then made NOT NULL, so the migration is safe on a
-- table that already has rows. No column DEFAULT: a default is exactly how a
-- live token would come to be labelled 'demo' by accident. The application
-- always supplies this value (saveConnection requires it).
--
-- Existing rows are backfilled to 'demo' because no connection has been made
-- against Live — the OAuth flow has never successfully run. If that is not true
-- in production, fix the backfill before running this.
-- ---------------------------------------------------------------------------

ALTER TABLE tradovate_connections
  ADD COLUMN IF NOT EXISTS environment TEXT;

UPDATE tradovate_connections SET environment = 'demo' WHERE environment IS NULL;

ALTER TABLE tradovate_connections
  ALTER COLUMN environment SET NOT NULL;

ALTER TABLE tradovate_connections
  DROP CONSTRAINT IF EXISTS tradovate_connections_environment_check;
ALTER TABLE tradovate_connections
  ADD CONSTRAINT tradovate_connections_environment_check
  CHECK (environment IN ('demo', 'live'));


-- ---------------------------------------------------------------------------
-- 2-4. OAuth token metadata
-- ---------------------------------------------------------------------------

-- Expiry of refresh_token_encrypted, when one is issued. Nullable: the OAuth
-- guide never mentions refresh tokens and only the reference schema lists them.
ALTER TABLE tradovate_connections
  ADD COLUMN IF NOT EXISTS refresh_expires_at TIMESTAMPTZ;

-- The OAuthTokenResponse `token_type` field.
ALTER TABLE tradovate_connections
  ADD COLUMN IF NOT EXISTS token_type TEXT;

-- apiHosts from the most recent authentication or renewal response. Bare
-- hostnames with no scheme; the client adds https:// or wss://. Not a secret,
-- but not granted to the client either — see the grants section.
ALTER TABLE tradovate_connections
  ADD COLUMN IF NOT EXISTS api_hosts JSONB;


-- ---------------------------------------------------------------------------
-- 5. Refuse a plaintext token
--
-- token-crypto.ts writes "v1.<iv>.<tag>.<ciphertext>", all base64url. A raw
-- Tradovate access token does not match that shape. Without this constraint, a
-- future code path that forgot to encrypt would write plaintext tokens and
-- nothing would notice; with it, that becomes a failed INSERT.
--
-- Matched as v<digits> so a v2 envelope still passes — key rotation is the
-- reason the version prefix exists, and this must not be what blocks it.
-- ---------------------------------------------------------------------------

ALTER TABLE tradovate_connections
  DROP CONSTRAINT IF EXISTS tradovate_connections_access_token_is_ciphertext;
ALTER TABLE tradovate_connections
  ADD CONSTRAINT tradovate_connections_access_token_is_ciphertext
  CHECK (access_token_encrypted ~ '^v[0-9]+\.');

ALTER TABLE tradovate_connections
  DROP CONSTRAINT IF EXISTS tradovate_connections_refresh_token_is_ciphertext;
ALTER TABLE tradovate_connections
  ADD CONSTRAINT tradovate_connections_refresh_token_is_ciphertext
  CHECK (refresh_token_encrypted IS NULL OR refresh_token_encrypted ~ '^v[0-9]+\.');


-- ---------------------------------------------------------------------------
-- Column grants for the new columns
--
-- A new column carries NO privileges from 017's column-level GRANT. The new
-- columns are therefore unreadable by `authenticated` right now, which is the
-- safe default — grant only the non-secret ones, deliberately.
--
-- api_hosts is deliberately NOT granted. It is not a secret, but the browser
-- has no use for it, and the smallest client-visible surface is the right one.
--
-- The token columns are not granted here and must never be. 017's comment
-- explains why the column grant and the RLS policy are both required: Postgres
-- row security has no column dimension, so a select-own-row policy alone would
-- happily return access_token_encrypted to the browser.
-- ---------------------------------------------------------------------------

GRANT SELECT (environment, refresh_expires_at, token_type)
  ON tradovate_connections TO authenticated;

-- anon keeps nothing. Restated rather than left to 017, so that a future
-- blanket grant does not silently re-open it.
REVOKE ALL ON tradovate_connections FROM anon;


-- ---------------------------------------------------------------------------
-- No policy changes
--
-- 017 created exactly one policy — tradovate_connections_select_own, FOR SELECT
-- TO authenticated, USING (auth.uid() = user_id) — and deliberately no INSERT,
-- UPDATE or DELETE policy, so RLS denies every client write by default. Rows
-- are written only through the service role, which bypasses RLS.
--
-- That is still correct and nothing here changes it. A client must never be
-- able to plant a row (which would point a connection at another user) or flip
-- status back to 'active' on a token the server has already given up on.
--
-- Re-run supabase/queries/tradovate_connections_state.sql AFTER applying this
-- file and confirm nothing moved: still exactly one policy, still scoped
-- TO authenticated, and still no grant naming either token column.
-- ---------------------------------------------------------------------------

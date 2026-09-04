-- Tradovate OAuth connections.
--
-- One row per user, holding the OAuth access token Reflect uses to READ that
-- user's executions. Read-only by design: nothing in this integration places or
-- manages orders.
--
-- The two token columns hold AES-256-GCM ciphertext produced by
-- src/lib/tradovate/token-crypto.ts, never raw tokens. The encryption key lives
-- in TRADOVATE_TOKEN_ENCRYPTION_KEY and never reaches the database, so a dump of
-- this table on its own does not yield usable tokens.
--
-- Depends on update_updated_at(), defined in supabase/schema.sql.

CREATE TABLE IF NOT EXISTS tradovate_connections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- UNIQUE: one Tradovate connection per Reflect user. Reconnecting upserts
  -- this row rather than accumulating stale token copies. ON DELETE CASCADE so
  -- deleting the auth user takes the tokens with it.
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,

  -- AES-256-GCM ciphertext, format "v1.<iv>.<tag>.<ciphertext>" (base64url).
  access_token_encrypted TEXT NOT NULL,

  -- Nullable on purpose. Tradovate's /auth/oauthtoken returns access_token and
  -- expires_in but NO refresh_token; sessions are extended in place through
  -- /auth/renewaccesstoken using the access token itself. The column exists so
  -- that if Tradovate ever starts issuing refresh tokens we can store one
  -- without a migration, and it is written whenever the field is present.
  refresh_token_encrypted TEXT,

  -- Authoritative expiry of the stored access token. Never derive this from a
  -- hardcoded TTL: Tradovate's own docs disagree about token lifetime.
  expires_at TIMESTAMPTZ NOT NULL,

  -- Tradovate's numeric user id, from GET /auth/me. Not a secret: it is how the
  -- UI can say which Tradovate account is linked without touching a token.
  tradovate_user_id BIGINT,

  --   active  — token present and believed usable
  --   expired — renewal failed or the token lapsed; the user must reconnect,
  --             because OAuth gives us no refresh token to recover with
  --   revoked — the user disconnected; the row is normally deleted, so this
  --             state exists for the window between revoking upstream and the
  --             delete landing, and for audit if the delete is ever deferred
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'revoked')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS tradovate_connections_updated_at ON tradovate_connections;
CREATE TRIGGER tradovate_connections_updated_at
  BEFORE UPDATE ON tradovate_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Lets a background job find connections due for renewal without scanning.
CREATE INDEX IF NOT EXISTS idx_tradovate_connections_status_expiry
  ON tradovate_connections (status, expires_at);


-- ---------------------------------------------------------------------------
-- Access control
--
-- Two independent mechanisms, and BOTH are required:
--
--   RLS policies decide WHICH ROWS a role may touch.
--   Column GRANTs decide WHICH COLUMNS a role may read.
--
-- RLS alone cannot hide the token columns — Postgres row security has no column
-- dimension. A select-own-row policy without the grants below would happily
-- return access_token_encrypted to the browser. So the row filter and the column
-- filter are set up separately, and the token columns are excluded from the
-- grant rather than merely "not selected" by application code.
-- ---------------------------------------------------------------------------

ALTER TABLE tradovate_connections ENABLE ROW LEVEL SECURITY;

-- Supabase's default privileges grant ALL on new public tables to anon and
-- authenticated. Take that back before granting anything deliberately;
-- otherwise every column stays readable regardless of what follows.
REVOKE ALL ON tradovate_connections FROM PUBLIC;
REVOKE ALL ON tradovate_connections FROM anon;
REVOKE ALL ON tradovate_connections FROM authenticated;

-- The only client-visible columns. access_token_encrypted and
-- refresh_token_encrypted are deliberately absent: a signed-in user cannot read
-- them even with a hand-written PostgREST query against their own row, and
-- `select *` from the browser errors instead of leaking. All token access goes
-- through the server with the service role key.
GRANT SELECT (id, user_id, status, tradovate_user_id, expires_at, created_at, updated_at)
  ON tradovate_connections TO authenticated;

-- anon gets nothing at all: an unauthenticated caller has no business knowing a
-- connection exists. Stated explicitly rather than left to the REVOKE above, so
-- a future blanket grant does not silently re-open it.
REVOKE ALL ON tradovate_connections FROM anon;

-- Row filter for reads: a user sees their own row and no one else's. Scoped TO
-- authenticated so the policy is never even considered for anon.
DROP POLICY IF EXISTS "tradovate_connections_select_own" ON tradovate_connections;
CREATE POLICY "tradovate_connections_select_own"
  ON tradovate_connections FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- There is deliberately NO insert, update or delete policy for authenticated.
-- RLS denies by default, so with no policy every client write is rejected. Rows
-- are created by /api/tradovate/callback, refreshed by the server-side token
-- helper, and removed by /api/tradovate/disconnect — all through the service
-- role, which bypasses RLS. A client must never be able to plant a row (which
-- would let it point a connection at another user) or flip status to 'active'
-- on a token the server has already given up on.

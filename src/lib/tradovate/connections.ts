/**
 * Stored Tradovate connections: the bridge between the database and a usable
 * access token.
 *
 * SERVER ONLY — see ./config.ts. This module uses the Supabase service role key,
 * which bypasses RLS, and holds decrypted tokens in memory. It must never be
 * imported from a client component.
 *
 * This is the only module that reads or writes tradovate_connections. The token
 * columns are not readable from the browser at all (see migration 017), so every
 * path to a token goes through here.
 *
 *
 * Token lifecycle, and why it differs from ./session.ts
 * ----------------------------------------------------
 *
 * ./session.ts manages ONE token — Reflect's own application session — in a
 * module-level variable. This module manages one token PER CONNECTED USER, so
 * the cache and the single-flight guard are keyed by Supabase user id. The three
 * disciplines carry over unchanged:
 *
 * 1. **Renew ahead of expiry, never on failure.** Reacting to a 401 means at
 *    least one failed request per cycle, and a burst of them under concurrency.
 *
 * 2. **Single-flight, per user.** Ten parallel requests for one user must
 *    produce one renewal, not ten. Note the key: a global lock would serialise
 *    unrelated users behind each other, and no lock at all would hammer
 *    Tradovate's rate limiter on behalf of a single account.
 *
 * 3. **Expiry comes from the server, never a hardcoded TTL.**
 *
 * What is different, and it matters:
 *
 * - **There is no fallback to full authentication.** ./session.ts can always
 *   re-authenticate with Reflect's own username and password. Here we hold only
 *   an OAuth access token — Tradovate's /auth/oauthtoken issues no refresh token
 *   — so if renewal fails there is nothing to recover with. The connection is
 *   marked 'expired' and the user must reconnect. Failing loudly is the point:
 *   silently retrying would only burn rate limit.
 *
 * - **The two-concurrent-sessions cap belongs to the USER, not to us.** A trader
 *   with our connection open plus their own Tradovate desktop or web session is
 *   already at two. If we opened a session of our own on their behalf we would
 *   evict one of theirs mid-trade. GET /auth/renewaccesstoken extends the
 *   existing session in place without opening a new one, which is why renewal is
 *   the only token operation this module performs, and why nothing here calls
 *   requestAccessToken().
 *
 * The in-memory cache is per-process — on Vercel, per lambda instance. Two
 * instances renewing the same user concurrently is safe (renewal opens no
 * session, and the last write wins on a row holding equivalent tokens), but it
 * does mean the single-flight guard is a per-instance optimisation rather than a
 * global one. If instance counts ever grow enough for that to bite, the fix is a
 * short advisory lock in Postgres, not a bigger cache.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient } from '@/lib/supabase/admin';

import { renewAccessToken } from './auth';
import { TradovateNotConnectedError, TradovateOAuthError } from './errors';
import { decryptToken, encryptToken } from './token-crypto';
import type { TradovateOAuthConfig } from './oauth-config';
import type { UserTokenSnapshot } from './types';

/** Renew once the token is within this window of expiring. Mirrors ./session.ts. */
const RENEW_MARGIN_MS = 15 * 60_000;

/** Never hand out a token this close to expiry; it would die in flight. */
const MIN_REMAINING_MS = 30_000;

/**
 * Cap on cached users, so a process serving many traders cannot grow this map
 * without bound. Eviction is oldest-inserted-first; an evicted user simply pays
 * one extra database read on their next request.
 */
const MAX_CACHED_USERS = 500;

const cache = new Map<string, UserTokenSnapshot>();
const inFlight = new Map<string, Promise<UserTokenSnapshot>>();

export type ConnectionStatus = 'active' | 'expired' | 'revoked';

/** The row as this module reads it. */
interface ConnectionRow {
  user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  expires_at: string;
  tradovate_user_id: number | null;
  status: ConnectionStatus;
}

/** Non-secret view of a connection, safe to return from a route. */
export interface ConnectionSummary {
  status: ConnectionStatus;
  tradovateUserId: number | null;
  expiresAt: string;
}

function remember(userId: string, snapshot: UserTokenSnapshot): UserTokenSnapshot {
  if (cache.size >= MAX_CACHED_USERS && !cache.has(userId)) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(userId, snapshot);
  return snapshot;
}

/**
 * Drop a user's cached token. Call after disconnecting, after a 401 on their
 * behalf, or from tests. Does not touch the database and does not close the
 * Tradovate session.
 */
export function forgetCachedToken(userId: string): void {
  cache.delete(userId);
  inFlight.delete(userId);
}

/** Reset the whole cache. Test seam. */
export function clearAllCachedTokens(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Store a freshly exchanged connection, replacing any previous one.
 *
 * Upsert on user_id rather than insert: reconnecting is routine (the token
 * lapsed, or the user relinked a different Tradovate account) and must not
 * accumulate rows — which the UNIQUE constraint would reject anyway.
 */
export async function saveConnection(params: {
  userId: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  tradovateUserId: number | null;
  admin?: SupabaseClient;
}): Promise<void> {
  const { userId, accessToken, refreshToken, expiresAt, tradovateUserId } = params;
  const admin = params.admin ?? createAdminClient();

  const { error } = await admin.from('tradovate_connections').upsert(
    {
      user_id: userId,
      access_token_encrypted: encryptToken(accessToken, 'access', userId),
      // Null unless Tradovate ever starts issuing refresh tokens. Written
      // explicitly so reconnecting clears a stale value rather than leaving one
      // behind from a previous connection.
      refresh_token_encrypted: refreshToken ? encryptToken(refreshToken, 'refresh', userId) : null,
      expires_at: new Date(expiresAt).toISOString(),
      tradovate_user_id: tradovateUserId,
      status: 'active',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );

  // A Supabase error carries the failing statement, not the values, so this
  // cannot leak a token. The row we just built is not logged either.
  if (error) throw new Error(`Failed to store the Tradovate connection: ${error.message}`);

  remember(userId, { accessToken, expiresAt, tradovateUserId });
}

/** Read a connection without touching tokens. For status checks and routes. */
export async function getConnectionSummary(
  userId: string,
  admin: SupabaseClient = createAdminClient()
): Promise<ConnectionSummary | null> {
  const { data, error } = await admin
    .from('tradovate_connections')
    .select('status, tradovate_user_id, expires_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`Failed to read the Tradovate connection: ${error.message}`);
  if (!data) return null;

  return {
    status: data.status as ConnectionStatus,
    tradovateUserId: data.tradovate_user_id,
    expiresAt: data.expires_at,
  };
}

/**
 * Record a status change. Failures are swallowed: the caller is already about to
 * throw something more useful, the token is unusable either way, and the next
 * call retries the update.
 */
async function markStatus(
  userId: string,
  status: ConnectionStatus,
  admin: SupabaseClient
): Promise<void> {
  await admin
    .from('tradovate_connections')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
}

/**
 * Return a valid access token for a user, renewing it transparently when it is
 * close to expiry.
 *
 * Throws TradovateNotConnectedError when there is nothing usable: no row, a
 * disconnected or expired connection, or a renewal that failed. That is the
 * signal to prompt the user to reconnect — there is no silent recovery, because
 * OAuth hands us no refresh token to recover with.
 */
export async function getUserAccessToken(
  userId: string,
  config: Pick<TradovateOAuthConfig, 'apiUrl'>,
  options: { admin?: SupabaseClient } = {}
): Promise<UserTokenSnapshot> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt - Date.now() > RENEW_MARGIN_MS) return cached;

  // Registered synchronously, before the first await, so two callers arriving in
  // the same tick cannot both start a renewal.
  const existing = inFlight.get(userId);
  if (existing) return existing;

  const admin = options.admin ?? createAdminClient();
  const work = loadOrRenew(userId, config, admin).finally(() => inFlight.delete(userId));
  inFlight.set(userId, work);
  return work;
}

async function loadOrRenew(
  userId: string,
  config: Pick<TradovateOAuthConfig, 'apiUrl'>,
  admin: SupabaseClient
): Promise<UserTokenSnapshot> {
  const { data, error } = await admin
    .from('tradovate_connections')
    .select(
      'user_id, access_token_encrypted, refresh_token_encrypted, expires_at, tradovate_user_id, status'
    )
    .eq('user_id', userId)
    .maybeSingle<ConnectionRow>();

  if (error) throw new Error(`Failed to read the Tradovate connection: ${error.message}`);

  if (!data) {
    cache.delete(userId);
    throw new TradovateNotConnectedError(userId, 'missing');
  }
  if (data.status !== 'active') {
    cache.delete(userId);
    throw new TradovateNotConnectedError(userId, data.status === 'revoked' ? 'revoked' : 'expired');
  }

  const storedExpiry = Date.parse(data.expires_at);
  const accessToken = decryptToken(data.access_token_encrypted, 'access', userId);
  const tradovateUserId = data.tradovate_user_id;

  // Another instance may have renewed since this one last looked; if the stored
  // token is comfortably fresh, use it rather than renewing again.
  if (Number.isFinite(storedExpiry) && storedExpiry - Date.now() > RENEW_MARGIN_MS) {
    return remember(userId, { accessToken, expiresAt: storedExpiry, tradovateUserId });
  }

  // Renewal has to present a live token, so one that has already lapsed cannot
  // be recovered here — and with no refresh token, not anywhere else either.
  if (!Number.isFinite(storedExpiry) || storedExpiry - Date.now() <= MIN_REMAINING_MS) {
    cache.delete(userId);
    await markStatus(userId, 'expired', admin);
    throw new TradovateNotConnectedError(userId, 'expired');
  }

  let renewed;
  try {
    renewed = await renewAccessToken({ apiUrl: config.apiUrl }, accessToken);
  } catch {
    // The cause is deliberately not chained: a renewal failure can carry the
    // response body, and that body can carry a token. There is no
    // re-authentication fallback here — see the header — so record the state and
    // make the caller deal with a disconnected account.
    cache.delete(userId);
    await markStatus(userId, 'expired', admin);
    throw new TradovateNotConnectedError(userId, 'expired');
  }

  const expiresAt = Date.parse(renewed.expirationTime);
  if (Number.isNaN(expiresAt)) {
    cache.delete(userId);
    await markStatus(userId, 'expired', admin);
    throw new TradovateOAuthError(
      'Tradovate renewed the token but returned an unparsable expirationTime.',
      { stage: 'exchange' }
    );
  }

  await saveConnection({
    userId,
    accessToken: renewed.accessToken,
    expiresAt,
    tradovateUserId,
    admin,
  });

  return { accessToken: renewed.accessToken, expiresAt, tradovateUserId };
}

/**
 * Disconnect a user's Tradovate account.
 *
 * Order matters: the row is marked 'revoked' before it is deleted, so that if
 * the delete fails the connection is already unusable rather than sitting there
 * looking active. The cached token is dropped first of all.
 *
 * On upstream revocation — Tradovate publishes no OAuth token-revocation
 * endpoint, and its API reference documents none. The strongest available action
 * is to destroy our copy and stop renewing, after which the access token lapses
 * on its own well inside its normal lifetime. A user who wants the grant itself
 * withdrawn immediately does that from their Tradovate account settings. If
 * Tradovate ships a revocation endpoint, this is the one function that needs to
 * call it.
 */
export async function disconnectUser(
  userId: string,
  admin: SupabaseClient = createAdminClient()
): Promise<{ existed: boolean }> {
  forgetCachedToken(userId);

  const summary = await getConnectionSummary(userId, admin);
  if (!summary) return { existed: false };

  await markStatus(userId, 'revoked', admin);

  const { error } = await admin.from('tradovate_connections').delete().eq('user_id', userId);
  if (error) throw new Error(`Failed to delete the Tradovate connection: ${error.message}`);

  return { existed: true };
}

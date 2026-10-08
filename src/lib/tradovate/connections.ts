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
 * - **There is no automatic fallback when renewal fails.** ./session.ts can
 *   always re-authenticate with Reflect's own username and password. Here the
 *   only credential this module uses is the access token itself, so a failed
 *   renewal leaves nothing to recover with in-process: the connection is marked
 *   'expired' and the user must reconnect. Failing loudly is the point; silently
 *   retrying would only burn rate limit.
 *
 *   The exchange DOES issue a refresh token — observed in production, against
 *   both migration 017's comment and this module's original one. It is stored,
 *   and `refresh_expires_at` records how long it lasts, but nothing here redeems
 *   it: sessions are extended in place with GET /auth/renewaccesstoken using the
 *   access token, which is the call that does not open a second session. The
 *   refresh token is what a returning user re-authorizes against, and wiring
 *   that up is separate work from this cache.
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

import { readApiHosts, resolveTradingApiUrl } from './api-hosts';
import { renewAccessToken } from './auth';
import { TradovateNotConnectedError, TradovateOAuthError } from './errors';
import type { TradovateEnvironment } from './hosts';
import { decryptToken, encryptToken } from './token-crypto';
import type { TradovateApiHosts, UserTokenSnapshot } from './types';

/**
 * Renew once the token is within this window of expiring. Mirrors ./session.ts.
 *
 * Sized against an observed 80-minute access-token lifetime (`expires_in` 4800),
 * not the ~26 hours NinjaTrader support stated in writing — trust the number the
 * server sent. 15 minutes out of 80 leaves a comfortable margin, and at 5,000
 * requests per hour per Tradovate user the resulting cadence costs nothing worth
 * counting.
 */
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
  environment: TradovateEnvironment;
  status: ConnectionStatus;
  // Read only so that a renewal can carry them forward. saveConnection writes
  // every one of these columns on every save, so a renewal that did not
  // re-supply them would null values the exchange had recorded — the same hazard
  // the refreshToken parameter is documented for.
  refresh_expires_at: string | null;
  token_type: string | null;
  api_hosts: TradovateApiHosts | null;
}

/** Non-secret view of a connection, safe to return from a route. */
export interface ConnectionSummary {
  status: ConnectionStatus;
  tradovateUserId: number | null;
  expiresAt: string;
  environment: TradovateEnvironment;
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
  /**
   * The refresh token to store, when there is one.
   *
   * OMITTING THIS CLEARS THE STORED VALUE. It is not a partial update: this
   * column is written on every save, so leaving the argument out writes NULL.
   * Any caller that is updating an existing connection — a renewal, say —
   * must pass the current value through, or it destroys it.
   */
  refreshToken?: string;
  /**
   * Authoritative expiry: epoch milliseconds, OR the server's own ISO string.
   *
   * Pass the string whenever the server stated one. GET /auth/renewaccesstoken
   * returns `expirationTime`, and that IS the expiry — storing it verbatim beats
   * parsing it to epoch milliseconds and formatting it back, which is our clock's
   * arithmetic applied to a value we were simply told. The OAuth exchange states
   * no such instant (only `expires_in`, in seconds), so that path has no choice
   * but to pass a computed number.
   */
  expiresAt: number | string;
  tradovateUserId: number | null;
  /**
   * `refresh_token_expires_in` from the exchange, as epoch milliseconds.
   *
   * Product-relevant rather than metadata: this is how long a user can be away
   * before they must re-authorize. CLEARED IF OMITTED, exactly like refreshToken
   * — a renewal has to pass the stored value through.
   */
  refreshExpiresAt?: number;
  /** `token_type` from the exchange. CLEARED IF OMITTED. */
  tokenType?: string;
  /**
   * `apiHosts` — this user's own API hosts, from the most recent
   * authentication or renewal.
   *
   * Both paths supply it: the exchange returns it (measured 8 Oct 2026) and
   * so does renewal, which is what the dynamic-hosts page means by resolving
   * the hosts again on every authentication and replacing what was stored.
   * Not a secret, but migration 030 deliberately withholds it from the
   * client column grant, so nothing may hand it to the browser.
   * CLEARED IF OMITTED — a caller that forgets it erases what we know, and
   * the renewal path below carries the stored value forward for exactly
   * that reason.
   */
  apiHosts?: TradovateApiHosts;
  /**
   * Which Tradovate environment minted this token. Required, with no default:
   * a demo token and a live token are indistinguishable once stored, and
   * guessing would mean reading simulated fills as though they were real ones.
   */
  environment: TradovateEnvironment;
  admin?: SupabaseClient;
}): Promise<void> {
  const { userId, accessToken, refreshToken, expiresAt, tradovateUserId, environment } = params;
  const { refreshExpiresAt, tokenType, apiHosts } = params;
  const admin = params.admin ?? createAdminClient();

  // The in-memory cache needs milliseconds whichever form arrived, and an
  // unparsable expiry has to be refused before it is written: a row whose
  // expires_at cannot be read is a connection that can never be renewed.
  const expiresAtMs = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error('Refusing to store a Tradovate connection with an unparsable expiry.');
  }

  const { error } = await admin.from('tradovate_connections').upsert(
    {
      user_id: userId,
      access_token_encrypted: encryptToken(accessToken, 'access', userId),
      // Always written, never left untouched: reconnecting must clear a stale
      // value rather than leave one behind from a previous connection. The cost
      // of that choice is that a caller which forgets to pass refreshToken
      // silently erases it — see the warning on the parameter.
      refresh_token_encrypted: refreshToken ? encryptToken(refreshToken, 'refresh', userId) : null,
      // A string here is the server's own expirationTime, stored as it was sent.
      // Only a number — the exchange path, which is given seconds and nothing
      // else — goes through our clock.
      expires_at: typeof expiresAt === 'string' ? expiresAt : new Date(expiresAt).toISOString(),
      tradovate_user_id: tradovateUserId,
      environment,
      // Always written, under the same rule as refresh_token_encrypted above and
      // with the same cost: a caller that forgets one of these erases it.
      refresh_expires_at:
        refreshExpiresAt === undefined ? null : new Date(refreshExpiresAt).toISOString(),
      token_type: tokenType ?? null,
      api_hosts: apiHosts ?? null,
      status: 'active',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );

  // A Supabase error carries the failing statement, not the values, so this
  // cannot leak a token. The row we just built is not logged either.
  if (error) throw new Error(`Failed to store the Tradovate connection: ${error.message}`);

  remember(userId, { accessToken, expiresAt: expiresAtMs, tradovateUserId });
}

/** The non-secret columns a summary needs. Never a token column. */
const SUMMARY_COLUMNS = 'status, tradovate_user_id, expires_at, environment';

/**
 * The outcome of trying to read a connection.
 *
 * Three cases, deliberately not two. "I asked and there is no connection" and
 * "I could not ask" are different facts, and collapsing them is how a UI ends up
 * telling a connected user they are not connected. Any caller that renders state
 * to a person wants this; a caller that just needs the row can use
 * getConnectionSummary() and let a failure throw.
 */
export type ConnectionRead =
  | { outcome: 'row'; summary: ConnectionSummary }
  | { outcome: 'none' }
  | { outcome: 'error'; code?: string; message: string };

function toSummary(row: Record<string, unknown>): ConnectionSummary {
  return {
    status: row.status as ConnectionStatus,
    tradovateUserId: (row.tradovate_user_id as number | null) ?? null,
    expiresAt: row.expires_at as string,
    environment: row.environment as TradovateEnvironment,
  };
}

/**
 * Read a connection, reporting failure as a value rather than an exception.
 *
 * Covers the client itself failing to build — createAdminClient() throws when
 * the service-role key is missing, and that is a read failure like any other,
 * not a crash the caller should have to anticipate separately.
 */
export async function readConnectionSummary(
  userId: string,
  adminClient?: SupabaseClient
): Promise<ConnectionRead> {
  let admin: SupabaseClient;
  try {
    admin = adminClient ?? createAdminClient();
  } catch (error) {
    return {
      outcome: 'error',
      code: 'admin_client_unavailable',
      message: error instanceof Error ? error.message : 'unknown error',
    };
  }

  const { data, error } = await admin
    .from('tradovate_connections')
    .select(SUMMARY_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();

  // A PostgREST error carries the failing statement and its own code, not the
  // row values, so none of this can carry a token — the select names four
  // non-secret columns and the token columns are not among them.
  if (error) return { outcome: 'error', code: error.code, message: error.message };
  if (!data) return { outcome: 'none' };

  return { outcome: 'row', summary: toSummary(data as Record<string, unknown>) };
}

/**
 * Read a connection without touching tokens. Throws if the read fails.
 *
 * Kept for callers that are already inside a try/catch and treat an unreadable
 * connection as fatal — disconnectUser() is the one in the repo. Anything
 * rendering state to a user should call readConnectionSummary() instead.
 */
export async function getConnectionSummary(
  userId: string,
  admin: SupabaseClient = createAdminClient()
): Promise<ConnectionSummary | null> {
  const read = await readConnectionSummary(userId, admin);
  if (read.outcome === 'error') {
    throw new Error(`Failed to read the Tradovate connection: ${read.message}`);
  }
  return read.outcome === 'row' ? read.summary : null;
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
 * signal to prompt the user to reconnect. There is no silent recovery: a refresh
 * token may be stored, but nothing here redeems one — see the header.
 */
export async function getUserAccessToken(
  userId: string,
  options: { admin?: SupabaseClient } = {}
): Promise<UserTokenSnapshot> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt - Date.now() > RENEW_MARGIN_MS) return cached;

  // Registered synchronously, before the first await, so two callers arriving in
  // the same tick cannot both start a renewal.
  const existing = inFlight.get(userId);
  if (existing) return existing;

  const admin = options.admin ?? createAdminClient();
  const work = loadOrRenew(userId, admin).finally(() => inFlight.delete(userId));
  inFlight.set(userId, work);
  return work;
}

async function loadOrRenew(
  userId: string,
  admin: SupabaseClient
): Promise<UserTokenSnapshot> {
  const { data, error } = await admin
    .from('tradovate_connections')
    .select(
      'user_id, access_token_encrypted, refresh_token_encrypted, expires_at, ' +
        'tradovate_user_id, environment, status, refresh_expires_at, token_type, api_hosts'
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

  // Renewal has to present a live token, so one that has already lapsed cannot be
  // recovered here — and no other path in this module redeems the refresh token,
  // so not anywhere else either. The user reconnects.
  if (!Number.isFinite(storedExpiry) || storedExpiry - Date.now() <= MIN_REMAINING_MS) {
    cache.delete(userId);
    await markStatus(userId, 'expired', admin);
    throw new TradovateNotConnectedError(userId, 'expired');
  }

  // The host this user's own connection resolves to, not the deployment's
  // TRADOVATE_API_URL. Hosts are a property of the user — a dedicated-
  // infrastructure organization reaches the API somewhere else entirely —
  // and sending the renewal to the shared host would 307 for exactly the
  // users the stored column exists to serve, which the catch below would
  // then record as a dead connection. Falls back to the documented shared
  // host when the row has no apiHosts, which every row written before the
  // exchange started supplying them does.
  const resolved = resolveTradingApiUrl({
    environment: data.environment,
    apiHosts: data.api_hosts,
  });
  if (resolved.rejected) {
    // A hostname, not a secret. Worth a line because it means the stored
    // value is not the bare hostname the contract promises, and the
    // fallback is now quietly standing in for a host we were given.
    console.warn(
      '[tradovate] stored api_hosts.' +
        `${data.environment} is not a usable bare hostname (${resolved.rejected}); ` +
        `using ${resolved.url} instead`
    );
  }

  let renewed;
  try {
    renewed = await renewAccessToken({ apiUrl: resolved.url }, accessToken);
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

  // The stored refresh-token expiry, carried forward: renewal never restates it.
  // A value we cannot parse is dropped rather than written back as garbage.
  const storedRefreshExpiry = data.refresh_expires_at
    ? Date.parse(data.refresh_expires_at)
    : Number.NaN;

  await saveConnection({
    userId,
    accessToken: renewed.accessToken,
    // The ISO string the server sent, not the epoch milliseconds parsed out of it
    // above. `expiresAt` exists for the validation and for the snapshot this
    // function returns; the column gets Tradovate's own words.
    expiresAt: renewed.expirationTime,
    tradovateUserId,
    // Carried from the stored row, not from the caller's config: the row
    // records which environment actually minted the token, and a renewal must
    // not be able to relabel it.
    environment: data.environment,
    // Carried forward for the same reason, and it is not optional: every
    // saveConnection writes refresh_token_encrypted, so omitting this argument
    // writes NULL rather than leaving the stored value alone. A renewal would
    // then silently destroy a refresh token the exchange had issued. Decrypted
    // and re-encrypted rather than copied as ciphertext because the AAD binds
    // each value to its user and column, and saveConnection owns that binding;
    // the fresh IV on re-encryption is expected, not a problem.
    refreshToken: data.refresh_token_encrypted
      ? decryptToken(data.refresh_token_encrypted, 'refresh', userId)
      : undefined,
    refreshExpiresAt: Number.isFinite(storedRefreshExpiry) ? storedRefreshExpiry : undefined,
    // Also carried from the row: the renewal response has no token_type.
    tokenType: data.token_type ?? undefined,
    // Re-read and replaced on every renewal, as the dynamic-hosts page
    // instructs: "A user's organization can move to dedicated infrastructure
    // between sessions, which changes the hosts they get back." Through
    // readApiHosts() rather than off renewed.apiHosts, because the renewal
    // body is typed by a cast. Falls back to the stored value so a response
    // that omits it — an error or a multi-factor step, per the same page —
    // does not erase what we already know.
    apiHosts: readApiHosts(renewed) ?? data.api_hosts ?? undefined,
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

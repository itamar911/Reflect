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
 * - **A renewal the server REFUSED is the end of the road; a refresh token is
 *   not.** ./session.ts can always re-authenticate with Reflect's own username
 *   and password. Here there is no password, but there are two stored
 *   credentials rather than one, and REF-100 put the second to use:
 *
 *   {@link redeemRefreshToken} redeems the refresh token at POST
 *   /auth/oauthtoken, which needs no live access token and therefore recovers
 *   the case renewal cannot — a user away for longer than one 80-minute access
 *   token. The refresh token lasts 26 hours and ROTATES on every redemption, so
 *   each one both issues a new access token and pushes the deadline out another
 *   26 hours. Two things keep it rolling: a daily cron
 *   (/api/cron/tradovate-keepalive) and {@link redeemRefreshTokenIfDue} on the
 *   ordinary request path. The goal is that a connected user never reconnects
 *   unless they revoke the grant themselves.
 *
 *   The rotation is also why saving a redemption is a COMPARE-AND-SWAP rather
 *   than an upsert — two concurrent redemptions hold two different new refresh
 *   tokens and only the later one works. See `expectRefreshTokenCiphertext` on
 *   {@link saveConnection} and the reconcile step in {@link redeemRefreshToken}.
 *
 *   Only a refusal by Tradovate marks a connection 'expired'. A redemption that
 *   merely failed to complete leaves the row exactly as it was.
 *
 *   A renewal that merely did not complete is a different fact, and the
 *   distinction is the whole of REF-101. /auth/renewaccesstoken is rate limited
 *   at 15 calls an hour BY IP ADDRESS, and on Vercel every lambda shares a small
 *   pool of egress addresses — so one tenant's traffic can make our renewal
 *   fail. Treating that as a dead connection wrote status='expired', after which
 *   the status gate above rejects the row immediately on every later call and a
 *   working connection is permanently dead until the user reconnects. The same
 *   went for a timeout, a reset, a 500, or a body we could not parse.
 *
 *   So the catch classifies before it writes, and {@link classifyRenewalFailure}
 *   holds the rule: only proof of refusal is treated as refusal, the default is
 *   transient, and a transient failure writes NOTHING to the database. Marking a
 *   live connection dead is the expensive mistake, because it is the one the
 *   user cannot wait out. The refresh grant goes through the same classifier,
 *   for the same reason and with a wider blast radius: it runs over every
 *   connection at once, from a cron.
 *
 *   (The per-IP limit turned out not to apply to us — 20 consecutive renewals
 *   succeeded in production on 13 Oct 2026 — but the classification it forced is
 *   right on its own merits and nothing here was loosened.)
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

import { readApiHosts, resolveTradingApiUrl, type ResolvedApiUrl } from './api-hosts';
import { renewAccessToken } from './auth';
import {
  TradovateAuthError,
  TradovateNotConnectedError,
  TradovateOAuthError,
  TradovatePenaltyError,
  TradovateRequestError,
  TradovateTransientError,
} from './errors';
import type { TradovateEnvironment } from './hosts';
import { exchangeRefreshToken } from './oauth';
import { loadOAuthConfig, type TradovateOAuthConfig } from './oauth-config';
import { redactSecrets } from './redact';
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
 * Redeem the refresh token once it is within this window of expiring.
 *
 * 12 hours against a measured 26-hour lifetime (`refresh_token_expires_in`
 * 93600, 13 Oct 2026). Deliberately not a tight margin like RENEW_MARGIN_MS:
 * the daily cron is the primary mechanism and this is its backstop, so the
 * window has to survive a cron run that was late (Vercel allows roughly an hour
 * of drift on a daily schedule) or did not happen. Anything below ~2 hours
 * would mean a single skipped run could strand a user.
 *
 * Redeeming early is close to free: the grant issues a FRESH 26-hour refresh
 * token every time, so an early redemption moves the deadline out rather than
 * consuming a budget, and — measured — it opens no second session.
 *
 * ONE POLICY, TWO NUMBERS. This and `KEEPALIVE_WINDOW_MS` (25h, ./keepalive.ts)
 * both answer "how close to expiring is close enough to redeem", and they are
 * gated in opposite directions: the cron selects everything *inside* 25h, this
 * backstop fires only *inside* 12h. A successful cron run therefore pins
 * `refresh_expires_at` ~26h out and guarantees this margin cannot fire for the
 * next ~14 hours — REF-100's 14.10 regression, where the cron working is what
 * broke the request path. Raising one silences the other, so change neither
 * without reading both. The `force` path in {@link redeemRefreshTokenIfDue} is
 * what keeps the overlap from being load-bearing.
 */
const REFRESH_REDEEM_MARGIN_MS = 12 * 60 * 60_000;

/**
 * Cap on cached users, so a process serving many traders cannot grow this map
 * without bound. Eviction is oldest-inserted-first; an evicted user simply pays
 * one extra database read on their next request.
 */
const MAX_CACHED_USERS = 500;

const cache = new Map<string, UserTokenSnapshot>();
const inFlight = new Map<string, Promise<UserTokenSnapshot>>();

export type ConnectionStatus = 'active' | 'expired' | 'revoked';

/**
 * The row as this module reads it.
 *
 * Exported as {@link StoredConnection} so that the keep-alive can hand a row it
 * got from {@link listConnectionsDueForRefresh} straight back to
 * {@link redeemRefreshToken} without reading the table itself — this is still
 * the only module that touches `tradovate_connections`. The two token fields
 * are ciphertext and nothing outside this module can decrypt them.
 */
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

export type StoredConnection = ConnectionRow;

/**
 * Every column this module needs to use or carry forward a connection.
 *
 * One constant rather than a string per query, because the hazard is not a typo:
 * saveConnection() writes every column on every save, so a read that forgets one
 * leads to a save that nulls it. See {@link carryForward}.
 */
const CONNECTION_COLUMNS =
  'user_id, access_token_encrypted, refresh_token_encrypted, expires_at, ' +
  'tradovate_user_id, environment, status, refresh_expires_at, token_type, api_hosts';

/**
 * Every argument {@link saveConnection} needs other than the access token and
 * its expiry, taken off the stored row.
 *
 * This exists because of the trap documented on saveConnection's parameters:
 * every column is written on every save, so a caller that omits `refreshToken`,
 * `refreshExpiresAt`, `tokenType` or `apiHosts` does not leave the stored value
 * alone — it writes NULL over it. Both writing paths in this module spread this
 * object and override only what their response restated, so no field can be
 * forgotten at a call site.
 *
 * Decrypts and re-encrypts the refresh token rather than copying the ciphertext
 * across, because the AAD binds each value to its user and column and
 * saveConnection owns that binding; the fresh IV on re-encryption is expected,
 * and on the keep-alive path it is load-bearing — see
 * `expectRefreshTokenCiphertext`.
 *
 * Throws if the stored ciphertext or the key is unreadable. Called before any
 * upstream request for that reason: the moment to discover an undecryptable row
 * is before a grant has been spent on it, not after, when the result would have
 * nowhere to be saved.
 */
function carryForward(row: ConnectionRow) {
  const refreshExpiresAt = row.refresh_expires_at ? Date.parse(row.refresh_expires_at) : Number.NaN;
  return {
    userId: row.user_id,
    tradovateUserId: row.tradovate_user_id,
    // From the row, never from configuration: the row records which server
    // actually minted the token, and nothing here may relabel it.
    environment: row.environment,
    refreshToken: row.refresh_token_encrypted
      ? decryptToken(row.refresh_token_encrypted, 'refresh', row.user_id)
      : undefined,
    refreshExpiresAt: Number.isFinite(refreshExpiresAt) ? refreshExpiresAt : undefined,
    tokenType: row.token_type ?? undefined,
    apiHosts: row.api_hosts ?? undefined,
  };
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
   * WHICH SERVER MINTED THIS TOKEN, AND NOTHING ELSE.
   *
   * Mint-only. Required, with no default: a demo token and a live token are
   * indistinguishable once stored, and guessing would mean sending a token to
   * an endpoint that will not honour it.
   *
   * Read by OAuth and by renewal — the authorize and token hosts differ per
   * environment, and {@link redeemRefreshToken} refuses a connection whose mint
   * environment is not this deployment's. NEVER BY A TRADING READ: it does not
   * say where the trader's accounts live, which was the first of REF-90's two
   * bugs. The day pull asks both hosts (see loadBrokerDay in ./fills.ts).
   */
  environment: TradovateEnvironment;
  /**
   * COMPARE-AND-SWAP: the `refresh_token_encrypted` ciphertext this save expects
   * to find in the row, exactly as it was read.
   *
   * When set, the write becomes a conditional UPDATE instead of an upsert, and
   * `applied: false` comes back if the stored ciphertext no longer matches —
   * nothing is written and the cache is left alone.
   *
   * This exists because the refresh grant ROTATES the refresh token (measured
   * 13 Oct 2026). Two concurrent redemptions therefore hold two different new
   * refresh tokens, only one of which Tradovate still honours, and an
   * unconditional upsert would let the loser overwrite the winner — storing a
   * refresh token that has already been spent and costing the user the
   * connection REF-100 exists to preserve. The ciphertext is the version
   * marker: the table has no version column, and it does not need one, because
   * a fresh IV per encryption means every write produces a distinct value for
   * the column that is itself the thing being swapped.
   *
   * Compared as ciphertext rather than plaintext for the same reason: this is a
   * test of "is the row still as I read it", not of what the token says.
   */
  expectRefreshTokenCiphertext?: string;
  admin?: SupabaseClient;
}): Promise<{ applied: boolean }> {
  const { userId, accessToken, refreshToken, expiresAt, tradovateUserId, environment } = params;
  const { refreshExpiresAt, tokenType, apiHosts, expectRefreshTokenCiphertext } = params;
  const admin = params.admin ?? createAdminClient();

  // The in-memory cache needs milliseconds whichever form arrived, and an
  // unparsable expiry has to be refused before it is written: a row whose
  // expires_at cannot be read is a connection that can never be renewed.
  const expiresAtMs = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error('Refusing to store a Tradovate connection with an unparsable expiry.');
  }

  const row = {
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
    status: 'active' as const,
    updated_at: new Date().toISOString(),
  };

  if (expectRefreshTokenCiphertext !== undefined) {
    // UPDATE, not upsert: an upsert has no WHERE clause to hang the condition
    // on, and this path only ever runs against a row that was just read, so
    // there is nothing to insert. `select()` is what makes the outcome
    // observable — PostgREST reports zero matched rows as an empty array, not
    // as an error, so without it a lost swap would look exactly like a win.
    //
    // NOTE THE ABSENCE OF A `status` PREDICATE, AND DO NOT ADD ONE. Filtering
    // on status='active' here looks like tightening and is the opposite: it is
    // what HEALS a row that a racing loser has just marked 'expired'. `row`
    // above carries status='active', so a save that matches an expired row
    // writes it back to active — which is the whole recovery for the
    // interleaving where the loser's status write lands before the winner's
    // save. With a status filter the save would match nothing, the row would
    // stay expired, and the connection would be dead until the user
    // reconnected. See markExpiredIfRefreshUnchanged().
    const { data, error } = await admin
      .from('tradovate_connections')
      .update(row)
      .eq('user_id', userId)
      .eq('refresh_token_encrypted', expectRefreshTokenCiphertext)
      .select('user_id');

    if (error) throw new Error(`Failed to store the Tradovate connection: ${error.message}`);

    // Zero rows means the condition did not hold: another redemption rotated
    // the refresh token between our read and this write. Nothing was written,
    // and deliberately nothing is cached either — the tokens in hand are the
    // ones that lost, and remembering them would hand a spent access token to
    // the next caller.
    if (!data || data.length === 0) return { applied: false };

    remember(userId, { accessToken, expiresAt: expiresAtMs, tradovateUserId });
    return { applied: true };
  }

  const { error } = await admin
    .from('tradovate_connections')
    .upsert(row, { onConflict: 'user_id' });

  // A Supabase error carries the failing statement, not the values, so this
  // cannot leak a token. The row we just built is not logged either.
  if (error) throw new Error(`Failed to store the Tradovate connection: ${error.message}`);

  remember(userId, { accessToken, expiresAt: expiresAtMs, tradovateUserId });
  return { applied: true };
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
 * Mark a connection 'expired', but ONLY if its refresh token is still the one
 * whose refusal we are acting on.
 *
 * This is {@link markStatus} with the compare-and-swap that every expired write
 * turns out to need, and it closes a race that cost a live connection
 * permanently.
 *
 * THE RACE IT CLOSES. Two redemptions read the same refresh token C0. A redeems
 * first and gets C1; B presents the now-spent C0 and is told `invalid_grant`.
 * B's reconcile() reads the row, still sees C0 because A's save (230–700ms in
 * production) has not landed, and concludes the refusal was real. Then:
 *
 *   B: reconcile() reads C0           → verdict stands
 *   A: conditional save lands         → C1, status='active', A is finished
 *   B: markStatus('expired')          → unconditional, overwrites A's status
 *
 * The row ends 'expired' holding A's perfectly good tokens, and nothing heals
 * it: the status gate in loadOrRenew() refuses the row on every later call, and
 * listConnectionsDueForRefresh() selects status='active' only, so the keep-alive
 * never looks at it again. The user has to reconnect — which is REF-101's
 * failure mode, reintroduced through a race.
 *
 * Reconciling harder cannot fix that. A read at T₁ and a write at T₂ with a
 * network round trip between them is check-then-act, however many times it
 * checks. The predicate has to travel WITH the write, so that Postgres
 * evaluates it atomically at commit: then no interleaving can defeat it, rather
 * than the window merely being narrower.
 *
 * `expectRefreshTokenCiphertext` is the ciphertext the CALLER read, null
 * included — a row that had no refresh token and still has none is as much a
 * match as an unchanged one, and it is the state at the lapsed-with-nothing-to-
 * recover-with call site.
 *
 * On `applied: false` the caller must NOT report the connection expired. It
 * means the row moved under us, so the refusal we hold is a verdict on a
 * credential the row no longer uses.
 *
 * Unlike markStatus(), a failure is reported rather than swallowed — but it is
 * reported as `applied: false`, which is the fail-safe direction: a write we
 * cannot confirm must not become a claim that the connection is dead.
 */
async function markExpiredIfRefreshUnchanged(params: {
  userId: string;
  expectRefreshTokenCiphertext: string | null;
  admin: SupabaseClient;
}): Promise<{ applied: boolean }> {
  const { userId, expectRefreshTokenCiphertext, admin } = params;

  const update = admin
    .from('tradovate_connections')
    .update({ status: 'expired' satisfies ConnectionStatus, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  // `.is` for null and `.eq` for a value: PostgREST will not match NULL with an
  // equality filter, so a row that legitimately has no refresh token needs the
  // IS NULL form or this would never apply.
  const filtered =
    expectRefreshTokenCiphertext === null
      ? update.is('refresh_token_encrypted', null)
      : update.eq('refresh_token_encrypted', expectRefreshTokenCiphertext);

  // select() for the same reason the save's compare-and-swap needs it: zero
  // matched rows come back as an empty array, not as an error.
  const { data, error } = await filtered.select('user_id');

  if (error) {
    console.error(
      redactSecrets(
        `[tradovate] could not record an expired connection (${error.code ?? 'no code'}); ` +
          'leaving the row as it was'
      )
    );
    return { applied: false };
  }

  return { applied: Boolean(data && data.length > 0) };
}

/**
 * Return a valid access token for a user, renewing it transparently when it is
 * close to expiry.
 *
 * Throws TradovateNotConnectedError when there is nothing usable: no row, a
 * disconnected or expired connection, or a credential Tradovate refused. That
 * is the signal to prompt the user to reconnect.
 *
 * Two things can happen on the way, in this order:
 *
 *   1. If the stored refresh token is within {@link REFRESH_REDEEM_MARGIN_MS} of
 *      expiring, it is redeemed — which yields a fresh access token as well, so
 *      the renewal below becomes unnecessary. A redemption that fails
 *      transiently does NOT fail the request: the stored access token is used
 *      instead. See {@link redeemRefreshTokenIfDue}.
 *   2. If the access token is within RENEW_MARGIN_MS, it is renewed.
 *
 * Note what the cache does to (1): a cached snapshot short-circuits this
 * function entirely, so the refresh check runs at most once per cached token —
 * roughly hourly for an active user. That is deliberate and sufficient, because
 * the margin is 12 hours wide and the daily cron covers users who are not
 * active at all.
 *
 * Throws TradovateTransientError when the renewal could not be completed —
 * rate limited, timed out, 5xx, unreadable — AND the stored token had already
 * run out. That is NOT a signal to prompt the user: nothing was written, the
 * connection is presumed intact, and the caller should retry later or degrade.
 * If the stored token is still live, such a failure is not raised at all; the
 * stored token is returned and the renewal is retried on the next call.
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

/**
 * A user's token together with the host it is addressed to (REF-90).
 *
 * The two travel as one value because ./client.ts requires them together:
 * `UserTokenRequestOptions` will not accept an `accessToken` without an
 * `apiUrl`, since a user's hosts are a property of the user and sending their
 * token to the deployment's host answers a dedicated-infrastructure trader with
 * a 307 that surfaces as a confusing 401 (REF-92). Handing callers a token and
 * leaving them to find the host would put that decision back at every call
 * site; this returns both or neither.
 */
export interface UserTradingApi {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  tradovateUserId: number | null;
  /**
   * BOTH trading hosts, resolved (REF-90 Stage 1).
   *
   * This was one `apiUrl`, keyed by `environment`, and that was the first of
   * REF-90's two bugs: `environment` records WHICH SERVER MINTED THE TOKEN, and
   * the deployment copies it from TRADOVATE_API_URL at callback time. It says
   * nothing about where the trader's accounts live — and for a prop-firm trader
   * whose evaluation account is provisioned in Demo, the answer was an empty
   * list from the wrong host. Measured in production on 14.10: live held
   * nothing, demo held the account.
   *
   * So the caller gets both and asks both. `/account/list` on each host is the
   * discovery step; the rest of the chain runs only where there was something
   * to continue with (see loadBrokerDay in ./fills.ts). Each host's reads must
   * carry THAT host's URL with the token — ./client.ts requires the pair — so
   * this is a record and not a list.
   */
  hosts: Record<TradovateEnvironment, ResolvedApiUrl>;
  /**
   * Which server minted the token. MINT-ONLY — NOT where the accounts are.
   *
   * The column's meaning is read by OAuth and by renewal, which need the
   * matching authorize and token hosts, and never by a trading read: routing
   * reads by it asked the wrong host for every trader whose accounts live in
   * the other environment, which was the first of REF-90's two bugs. Trading
   * reads go to BOTH hosts in {@link hosts}.
   *
   * It is still carried here, and the two things it decides are both
   * tie-breaks rather than routing: the mint host is the known-good one, so a
   * discovery failure HERE fails the pull while the same failure on the other
   * host only drops that host, and it wins a cross-host account-id collision.
   * Neither chooses which host a read is sent to — both are always asked.
   */
  environment: TradovateEnvironment;
}

/**
 * Everything needed to make a read on a connected user's behalf.
 *
 * Throws exactly what {@link getUserAccessToken} throws, and means the same
 * things by them: TradovateNotConnectedError when the credential was refused or
 * was never there, TradovateTransientError when nothing could be judged.
 *
 * TWO READS, IN THIS ORDER, AND THE ORDER IS THE POINT. The token is resolved
 * first because resolving it can REPLACE the row: a due refresh token is
 * redeemed on this path, and the redemption's response carries a fresh
 * `apiHosts` which is saved. Reading the hosts afterwards therefore sees the
 * newest ones. Reading them first would hand back a host from before a rotation
 * that had just moved it — rare, and exactly the class of bug that is invisible
 * until a dedicated-infrastructure user hits it.
 *
 * The second read is three columns on an indexed primary key, inside a request
 * that is about to make seven upstream calls. Caching it alongside the token
 * snapshot was the alternative and it is not worth the extra invalidation path.
 */
export async function getUserTradingApi(
  userId: string,
  options: { admin?: SupabaseClient } = {}
): Promise<UserTradingApi> {
  const admin = options.admin ?? createAdminClient();
  const token = await getUserAccessToken(userId, { admin });
  const { configured, hosts } = await readConnectionTradingHosts(userId, { admin });

  return {
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    tradovateUserId: token.tradovateUserId,
    hosts,
    environment: configured,
  };
}

/**
 * Both of a connection's trading hosts, resolved (REF-90 Stage 1).
 *
 * `environment` is the token's MINT server, so routing trading reads by it
 * asked the wrong host for every trader whose accounts live in the other
 * environment — the measured cause of REF-90. The fix is to ask both, which
 * means resolving both.
 *
 * Here rather than in ./api-hosts.ts because this module is the only one that
 * reads `tradovate_connections`, and it hands back RESOLVED URLs rather than
 * the raw `api_hosts` object, which keeps hostname handling — the bare-hostname
 * validation and the documented fallback — in ./api-hosts.ts where the rest of
 * it lives.
 *
 * `configured` is the mint environment, unchanged in meaning. Its two jobs
 * downstream are to be the host whose failure is fatal and to win a cross-host
 * account-id collision; see {@link UserTradingApi}.
 *
 * READ ONLY: two columns on an indexed primary key, no write, no token.
 */
export async function readConnectionTradingHosts(
  userId: string,
  options: { admin?: SupabaseClient } = {}
): Promise<{
  configured: TradovateEnvironment;
  hosts: Record<TradovateEnvironment, ResolvedApiUrl>;
}> {
  const admin = options.admin ?? createAdminClient();

  const { data, error } = await admin
    .from('tradovate_connections')
    .select('environment, api_hosts')
    .eq('user_id', userId)
    .maybeSingle<{ environment: TradovateEnvironment; api_hosts: TradovateApiHosts | null }>();

  // The read failed; the connection was not judged. Same rule as everywhere
  // else in this module — a failure to ask must never be reported as an answer.
  if (error) {
    throw new TradovateTransientError(
      `Could not read the connection's hosts (${error.code ?? 'no code'}).`,
      { reason: 'unknown' }
    );
  }

  // The row was there a moment ago, so it was deleted between the two reads —
  // the user disconnected mid-request. 'missing' rather than 'expired': there
  // is nothing to reconnect FROM, and the source mapping turns it into
  // 'reflect_only' rather than asking them to fix a connection they just
  // removed.
  if (!data) throw new TradovateNotConnectedError(userId, 'missing');

  // Both, by the same resolver the product path has always used — including its
  // fallback, so a row with no api_hosts still produces two askable URLs rather
  // than a gap the caller would have to treat as "not asked".
  const hosts = {
    live: resolveTradingApiUrl({ environment: 'live', apiHosts: data.api_hosts }),
    demo: resolveTradingApiUrl({ environment: 'demo', apiHosts: data.api_hosts }),
  };

  // A hostname, not a secret — see the same log on the renewal path. Through
  // redactSecrets() anyway: the value came from outside this process, and every
  // diagnostic in this integration goes through it. Both keys are reported now,
  // because both are asked: a rejected `demo` host used to be invisible here
  // and is now a host the pull actually reads.
  for (const environment of ['live', 'demo'] as const) {
    const resolved = hosts[environment];
    if (!resolved.rejected) continue;
    console.warn(
      redactSecrets(
        '[tradovate] stored api_hosts.' +
          `${environment} is not a usable bare hostname (${resolved.rejected}); ` +
          `using ${resolved.url} instead`
      )
    );
  }

  return { configured: data.environment, hosts };
}

/**
 * Whether this connection declares the broker a SOURCE OF TRADES (REF-107 E7).
 *
 * `tradovate_connections.is_trade_source`, from migration 034. The per-broker
 * declaration §C8 option ג argues for: "Tradovate is the source for this
 * account." When true, the broker's rows are canonical for closed money, a
 * manual row for the same trade is a plan waiting to be linked rather than a
 * second trade, and the import writes rows. When false, nothing is imported —
 * see lib/tradovate/import.ts for why that is the only coherent reading.
 *
 * HERE RATHER THAN IN import.ts BECAUSE THIS MODULE IS THE ONLY ONE THAT READS
 * `tradovate_connections`. That invariant is stated twice above and is worth
 * one more function to keep.
 *
 * ONLY CALL THIS BEHIND `isImportEnabled()`. The column does not exist until
 * migration 034 has been run by hand, and naming it before then is a PostgREST
 * 42703. That gate is the whole of why the deploy order is free, and it lives
 * at the call sites rather than here so that this function stays a plain read.
 *
 * TRUE IS NOT THE FALLBACK. A missing row, a read that failed, or a column that
 * answered with something other than a boolean all return FALSE, which means
 * "do not import". A connection we could not ask about must not be treated as
 * having said yes: the failure direction that writes rows into a trader's
 * journal on the strength of a read we could not make is the wrong one, and the
 * next run retries for free.
 *
 * READ ONLY: one column on an indexed primary key, no write, no token.
 */
export async function readIsTradeSource(
  userId: string,
  options: { admin?: SupabaseClient } = {}
): Promise<boolean> {
  const admin = options.admin ?? createAdminClient();

  const { data, error } = await admin
    .from('tradovate_connections')
    .select('is_trade_source')
    .eq('user_id', userId)
    .maybeSingle<{ is_trade_source: boolean | null }>();

  if (error) {
    // The code, not the message: a PostgREST message on a missing column names
    // the column and the table, which is harmless, but this is also the line
    // that would fire if the migration has not been run and it should say so
    // in one short form an operator can search for.
    console.warn(
      `[tradovate] could not read is_trade_source (${error.code ?? 'no code'}); ` +
        'treating the connection as not a trade source'
    );
    return false;
  }

  return data?.is_trade_source === true;
}

/**
 * The only HTTP statuses on the renewal endpoint that prove the token was
 * rejected.
 *
 * 429 is deliberately absent: that is the rate limiter answering, and it never
 * looked at the credential. So is every 5xx — a server that failed to answer
 * has said nothing about what it was handed.
 */
const TOKEN_REJECTED_STATUSES = new Set([401, 403]);

/**
 * Whether an `errorText` states that the credential is no good.
 *
 * Tradovate reports some failures as HTTP 200 with `errorText` set (see
 * TradovateAuthError), so the status code alone cannot settle those. Both halves
 * must match — a subject that is the credential, and a verdict against it — so
 * that "Access token is expired" counts and a bare "expired" or "Internal
 * error" does not.
 *
 * The exact strings this endpoint returns have NOT been measured; the live
 * connection expired on 9 Oct 2026 before anyone renewed against it (handoff
 * §3). Requiring both halves is what makes an unmeasured list safe to ship: text
 * we do not recognise falls through to transient, which costs a renewal retry
 * on the next call, while a loose match would cost a user their connection. If
 * a real rejection string ever shows up in the logs as transient, add it here.
 */
function statesTokenRejected(errorText: string): boolean {
  const subject = /\b(?:access[\s_-]?token|token|session|credential|authoriz\w*)\b/i;
  const verdict =
    /\b(?:invalid|expired|revoked|denied|unauthoriz\w*|rejected|not\s+(?:valid|found|authoriz\w*))\b/i;
  return subject.test(errorText) && verdict.test(errorText);
}

/**
 * OAuth `error` codes at the token endpoint that are a verdict on the grant we
 * presented rather than on the request or on our own registration.
 *
 * `invalid_grant` is the one RFC 6749 §5.2 defines for a refresh token that is
 * "invalid, expired, revoked … or was issued to another client", which is
 * exactly the claim that licenses marking a connection expired.
 *
 * `access_denied` is the user having withdrawn the authorization — the same
 * code ./oauth.ts exports as ACCESS_DENIED for the consent screen. On a refresh
 * grant it can only mean the grant is gone, so it is a verdict too.
 *
 * DELIBERATELY ABSENT, though they arrive as 400s through this same branch:
 * `invalid_client`, `invalid_request` and `unauthorized_client` are verdicts on
 * OUR credentials, OUR request shape or OUR registration, not on the user's
 * grant. Treating a rotated client secret as a dead connection would mark every
 * user expired in a single cron run — the REF-101 failure mode with a far wider
 * blast radius, and the one thing a daily job over all connections must not be
 * able to do.
 */
const GRANT_REJECTED_OAUTH_ERRORS = new Set(['invalid_grant', 'access_denied']);

/**
 * What a failed token operation licenses us to do.
 *
 * `detail` is for a log line and carries no secret: it is built from the error's
 * type, its HTTP status and its own message — never from a response body, which
 * on these endpoints can be a token.
 */
type RenewalVerdict =
  | { kind: 'rejected'; detail: string }
  | {
      kind: 'transient';
      reason: TradovateTransientError['reason'];
      detail: string;
      retryAfterSeconds?: number;
    };

/**
 * Decide whether a thrown token failure proves the stored credential is dead.
 *
 * Shared by the two operations that present a stored credential to Tradovate:
 * GET /auth/renewaccesstoken (the access token) and POST /auth/oauthtoken with
 * `grant_type=refresh_token` (the refresh token). The question is the same for
 * both — did the server judge what we handed it, or did it merely fail to
 * answer — and so is the asymmetry: the default is 'transient', and every
 * branch that cannot produce evidence of refusal falls into it. See the header
 * for why.
 *
 * REF-100 added the TradovateOAuthError branch. The rest is REF-101's and is
 * unchanged.
 */
function classifyRenewalFailure(error: unknown): RenewalVerdict {
  // Rate limited, captcha included. The limiter rejected the request before
  // anything read the token — and on this endpoint the budget is per IP, so the
  // traffic that spent it may not even be ours.
  if (error instanceof TradovatePenaltyError) {
    return {
      kind: 'transient',
      reason: 'penalty',
      detail: error.captcha ? 'rate limit penalty (captcha)' : 'rate limit penalty',
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }

  if (error instanceof TradovateRequestError) {
    // Checked before anything about the body: ./auth.ts parses the response
    // before it tests res.ok, so a 401 carrying unparsable JSON arrives here as
    // this same error. The status is evidence and the unreadable body is not,
    // so the status decides.
    if (TOKEN_REJECTED_STATUSES.has(error.status)) {
      return { kind: 'rejected', detail: `HTTP ${error.status} from ${error.path}` };
    }
    // Everything else this error covers is about the exchange rather than the
    // credential: a 5xx, a body that would not parse, or a 200 that arrived
    // without an accessToken. None of them is a verdict on the token.
    return {
      kind: 'transient',
      reason: error.status >= 500 ? 'server' : 'unknown',
      detail: `HTTP ${error.status} from ${error.path}`,
    };
  }

  if (error instanceof TradovateAuthError) {
    return statesTokenRejected(error.errorText)
      ? { kind: 'rejected', detail: 'errorText states the credential was refused' }
      : {
          kind: 'transient',
          reason: 'unknown',
          detail: 'errorText did not state a verdict on the credential',
        };
  }

  // The refresh grant's own failure shape (REF-100). ./oauth.ts raises this for
  // an `error` field in the token response, and for the two server faults that
  // are not an error field at all: a 2xx with no access_token, and an
  // unusable expires_in.
  if (error instanceof TradovateOAuthError) {
    if (error.oauthError && GRANT_REJECTED_OAUTH_ERRORS.has(error.oauthError)) {
      return { kind: 'rejected', detail: `OAuth ${error.oauthError} at the token endpoint` };
    }
    // An unrecognised `error` code is read the same way an unrecognised
    // errorText is: only on both halves of a statement about the credential.
    // The message has already been through redactSecrets() in ./oauth.ts.
    if (error.oauthError && statesTokenRejected(error.message)) {
      return {
        kind: 'rejected',
        detail: `OAuth ${error.oauthError}, described as a refusal of the credential`,
      };
    }
    // Everything else: a token issued without a readable lifetime, a 2xx with
    // no token in it, or an `error` code we do not recognise and whose
    // description claims nothing about the grant. All server faults.
    //
    // Worth knowing when this is the no-lifetime case: the refresh token HAS
    // been spent by then and its replacement could not be stored, so the
    // connection may genuinely be broken. It is still not ours to declare dead
    // — we were never told it was refused — and the next run reads the row and
    // tries again with whatever is stored.
    return {
      kind: 'transient',
      reason: 'unknown',
      detail: error.oauthError
        ? `OAuth ${error.oauthError}, no verdict on the credential`
        : `token endpoint answered unusably at stage ${error.stage}`,
    };
  }

  // Whatever is left came from the fetch itself — DNS, TLS, a reset, or an abort
  // on timeout — and the request may never have reached Tradovate at all. The
  // message is ours, not a response body, but it still goes through
  // redactSecrets() at the log site like every other diagnostic here.
  return {
    kind: 'transient',
    reason: 'network',
    detail: error instanceof Error ? `${error.name}: ${error.message}` : 'non-Error throw',
  };
}

/**
 * The outcome of trying to redeem a refresh token.
 *
 * Five cases, and the reason they are returned rather than thrown is that four
 * of the five are not failures of the caller's request: the keep-alive counts
 * them, and getUserAccessToken() carries on with the access token it already
 * has. Only the caller knows whether it has something to fall back on, so only
 * the caller decides what becomes an exception.
 *
 * No case carries a token value, a user id or a response body. `detail` is built
 * from error types and statuses and is safe to log.
 */
export type RefreshRedemption =
  /** Redeemed and stored. The snapshot holds the new access token. */
  | { outcome: 'refreshed'; snapshot: UserTokenSnapshot }
  /**
   * Another redemption rotated the refresh token first, so this one lost the
   * compare-and-swap (or found the row already moved on). The connection is
   * healthy and the snapshot is the WINNER's token, re-read from the row —
   * which is the point: a loser that reported failure would have the caller
   * prompt a reconnect for a connection that was just successfully refreshed.
   */
  | { outcome: 'superseded'; snapshot: UserTokenSnapshot }
  /** Tradovate refused the refresh token. `status` is now 'expired'. */
  | { outcome: 'expired'; detail: string }
  /** Nothing was judged and nothing was written. Try again later. */
  | {
      outcome: 'transient';
      reason: TradovateTransientError['reason'];
      retryAfterSeconds?: number;
      detail: string;
    }
  /** There was nothing to do. Nothing was sent and nothing was written. */
  | { outcome: 'skipped'; reason: 'no_refresh_token' | 'not_active' | 'environment'; detail: string };

/**
 * Redeem a connection's refresh token, storing the tokens it returns — the
 * storage half of REF-100.
 *
 * This is what makes "a connected user never has to reconnect" possible. The
 * access token lives 80 minutes and GET /auth/renewaccesstoken extends it, but
 * renewal needs a LIVE access token to present, so a user away for longer than
 * one lifetime used to come back to a dead connection with no way out. The
 * refresh token lasts 26 hours and redeeming it needs no access token at all,
 * which turns a hard expiry into a rolling one: each redemption issues a fresh
 * 26-hour refresh token, so the window never closes while anything keeps
 * redeeming it.
 *
 * It also yields a brand-new access token, which is why the renewal path does
 * not need to run afterwards.
 *
 *
 * THE RACE, AND WHY THE SAVE IS A COMPARE-AND-SWAP
 * -----------------------------------------------
 *
 * The refresh token ROTATES (measured 13 Oct 2026): the value we send is spent
 * and its replacement comes back in the response. So two concurrent redemptions
 * — the daily cron and a user request landing together, or two lambdas serving
 * the same user — each hold a different new refresh token, and only the one
 * Tradovate issued last is honoured. An unconditional save would let whichever
 * finished second write a refresh token that was already dead, which costs the
 * user exactly the reconnect this ticket exists to prevent.
 *
 * Two guards, and both are needed because they cover different halves of the
 * window:
 *
 *   1. The save is conditional on the stored refresh-token ciphertext still
 *      being the one we read (see `expectRefreshTokenCiphertext`). A loser
 *      writes nothing.
 *   2. On ANY failure — lost swap, refusal, timeout — the row is RE-READ before
 *      anything is classified. If the stored refresh token has changed since we
 *      read it, someone else redeemed successfully in the meantime, and our
 *      failure says nothing about the connection: we adopt their tokens and
 *      report 'superseded'. Without this, a redemption that failed *because*
 *      the token had just been rotated out from under it would be read as
 *      "Tradovate refused the credential" and mark a freshly refreshed
 *      connection expired.
 *
 * Nothing here opens a transaction or takes a lock. It does not need one: the
 * conditional UPDATE is itself atomic in Postgres, and the only state worth
 * protecting is that single column.
 */
export async function redeemRefreshToken(params: {
  /** The row as read from the table, by the caller. */
  connection: StoredConnection;
  config: TradovateOAuthConfig;
  admin: SupabaseClient;
  signal?: AbortSignal;
}): Promise<RefreshRedemption> {
  const { connection, config, admin, signal } = params;
  const userId = connection.user_id;

  if (connection.status !== 'active') {
    return {
      outcome: 'skipped',
      reason: 'not_active',
      detail: `connection status is ${connection.status}`,
    };
  }

  if (!connection.refresh_token_encrypted) {
    return {
      outcome: 'skipped',
      reason: 'no_refresh_token',
      detail: 'the row has no refresh token to redeem',
    };
  }

  // The refresh token was minted by one environment and the token endpoint
  // belongs to this deployment. Posting a demo grant to the live endpoint would
  // fail in a way that says nothing about the token, and classifying that noise
  // is how a working connection gets marked expired. Refuse instead.
  if (config.environment !== connection.environment) {
    return {
      outcome: 'skipped',
      reason: 'environment',
      detail:
        `the connection is ${connection.environment} but this deployment's token endpoint is ` +
        `${config.environment}`,
    };
  }

  // The ciphertext exactly as read: the compare-and-swap's expected value, and
  // the thing the re-read below compares against. Captured before any await.
  const redeemedCiphertext = connection.refresh_token_encrypted;

  /**
   * Re-read the row and decide whether our failure was really someone else's
   * success. Used by every failure path below.
   */
  const reconcile = async (): Promise<RefreshRedemption | null> => {
    const { data, error } = await admin
      .from('tradovate_connections')
      .select(CONNECTION_COLUMNS)
      .eq('user_id', userId)
      .maybeSingle<ConnectionRow>();

    // Could not re-read, so we cannot tell a lost race from a real refusal.
    // Transient is the only safe answer: it writes nothing.
    if (error) {
      return {
        outcome: 'transient',
        reason: 'unknown',
        detail: `could not re-read the connection to reconcile (${error.code ?? 'no code'})`,
      };
    }

    // The row is gone — the user disconnected while we were redeeming. Not a
    // failure to report and certainly not a status to write.
    if (!data) {
      cache.delete(userId);
      return {
        outcome: 'skipped',
        reason: 'not_active',
        detail: 'the connection was deleted while the grant was in flight',
      };
    }

    // Unchanged: nobody else won, so the caller's own verdict stands.
    if (data.refresh_token_encrypted === redeemedCiphertext) return null;

    // Changed. Someone redeemed successfully while we were failing, so their
    // tokens are the live ones. Adopt them rather than reporting a failure
    // about a connection that is demonstrably fine.
    if (data.status !== 'active' || !data.refresh_token_encrypted) {
      return {
        outcome: 'skipped',
        reason: 'not_active',
        detail: `the row changed under us and is now ${data.status}`,
      };
    }

    const winnerExpiry = Date.parse(data.expires_at);
    if (!Number.isFinite(winnerExpiry)) {
      return {
        outcome: 'transient',
        reason: 'unknown',
        detail: 'another redemption won but stored an unparsable expiry',
      };
    }

    return {
      outcome: 'superseded',
      snapshot: remember(userId, {
        accessToken: decryptToken(data.access_token_encrypted, 'access', userId),
        expiresAt: winnerExpiry,
        tradovateUserId: data.tradovate_user_id,
      }),
    };
  };

  // Decrypted BEFORE the grant, deliberately: decryptToken() throws on a bad key
  // or an altered row, and the moment to discover that is before a single-use
  // refresh token has been spent on it. See carryForward().
  let carried: ReturnType<typeof carryForward>;
  try {
    carried = carryForward(connection);
  } catch (error) {
    // Not 'expired', even though the user does have to reconnect: a key problem
    // is identical in shape for every row, so classifying it as a dead
    // connection would empty the table's worth of connections in one cron run.
    // The message names no value — see token-crypto.ts.
    const detail = error instanceof Error ? error.name : 'non-Error throw';
    console.error(
      redactSecrets(`[tradovate] could not read the stored refresh token (${detail}); nothing sent`)
    );
    return { outcome: 'transient', reason: 'unknown', detail: `unreadable stored token (${detail})` };
  }

  // Always set: carryForward() decrypts it whenever the column is non-null, and
  // the guard at the top of this function already returned if it was null.
  const refreshToken = carried.refreshToken;
  if (!refreshToken) {
    return {
      outcome: 'skipped',
      reason: 'no_refresh_token',
      detail: 'the row has no refresh token to redeem',
    };
  }

  let token;
  try {
    token = await exchangeRefreshToken(config, refreshToken, signal);
  } catch (error) {
    // No `cause` chained on anything thrown or returned from here: a grant
    // failure can carry the response body, and that body can carry a token.
    const verdict = classifyRenewalFailure(error);

    // Re-read first, whatever the verdict. A refusal that arrived *because*
    // another redemption had just rotated this token away is not a refusal of
    // the connection.
    const reconciled = await reconcile();
    if (reconciled) {
      console.warn(
        redactSecrets(
          `[tradovate] refresh redemption failed (${verdict.kind}: ${verdict.detail}) but the ` +
            `stored refresh token had changed; using the winning tokens instead`
        )
      );
      return reconciled;
    }

    if (verdict.kind === 'rejected') {
      cache.delete(userId);

      // The refusal is real as far as reconcile() could see. Still conditional:
      // reconcile() read the row a round trip ago, and the winning save can land
      // in that gap — see markExpiredIfRefreshUnchanged().
      const marked = await markExpiredIfRefreshUnchanged({
        userId,
        expectRefreshTokenCiphertext: redeemedCiphertext,
        admin,
      });

      if (marked.applied) return { outcome: 'expired', detail: verdict.detail };

      // Nothing was written: the row moved between reconcile() and the write.
      // Ask once more what it moved to — by now the winner's save has certainly
      // committed, because it is what made the predicate fail.
      const afterRace = await reconcile();
      if (afterRace) {
        console.warn(
          redactSecrets(
            `[tradovate] refresh redemption was refused (${verdict.detail}) but the row had ` +
              'already moved on; the refusal was of a credential the row no longer uses'
          )
        );
        return afterRace;
      }

      // The predicate failed and yet the refresh token reads as unchanged, so
      // the row moved in some way this function cannot name. Transient, never
      // expired: the one thing that must not happen here is declaring a
      // connection dead on evidence we can no longer attach to it.
      return {
        outcome: 'transient',
        reason: 'unknown',
        detail: 'the connection was refused but the row moved before it could be recorded',
      };
    }

    // Transient. Nothing written: not the status, not updated_at. The row still
    // describes the connection we read, and the next run tries again.
    console.warn(
      redactSecrets(
        `[tradovate] refresh redemption failed transiently (${verdict.reason}: ` +
          `${verdict.detail}); connection left untouched`
      )
    );
    return {
      outcome: 'transient',
      reason: verdict.reason,
      retryAfterSeconds: verdict.retryAfterSeconds,
      detail: verdict.detail,
    };
  }

  // Redeemed. Everything saveConnection() writes is supplied — the carried
  // values for every column the response did not restate, because omitting one
  // writes NULL over it.
  const saved = await saveConnection({
    ...carried,
    accessToken: token.accessToken,
    // Epoch milliseconds from `expires_in`: this endpoint states a number of
    // seconds and no absolute instant, so the clock reading belongs here. The
    // renewal path, which IS given an instant, stores that verbatim instead.
    expiresAt: token.expiresAt,
    // The rotated refresh token. Falls back to the one we sent for a response
    // that did not restate it — no rotation means the value we hold is still
    // the live one, and passing undefined would erase it.
    refreshToken: token.refreshToken ?? carried.refreshToken,
    refreshExpiresAt: token.refreshExpiresAt ?? carried.refreshExpiresAt,
    tokenType: token.tokenType ?? carried.tokenType,
    apiHosts: token.apiHosts ?? carried.apiHosts,
    expectRefreshTokenCiphertext: redeemedCiphertext,
    admin,
  });

  if (!saved.applied) {
    // We won the grant but lost the swap, which means another redemption landed
    // between our read and our write. Both tokens are real; theirs is the one
    // the row describes and the one Tradovate issued second, so theirs wins.
    // Ours is discarded unused — spending a grant for nothing is the cost of
    // not needing a lock.
    const reconciled = await reconcile();
    if (reconciled) return reconciled;

    // The swap failed but the refresh token is unchanged, so the condition
    // should have held. Something else moved (the row was deleted and
    // reinserted, say). Nothing was written; report it and let the next run
    // read fresh state.
    return {
      outcome: 'transient',
      reason: 'unknown',
      detail: 'the conditional save matched no row and the stored refresh token was unchanged',
    };
  }

  return {
    outcome: 'refreshed',
    snapshot: { accessToken: token.accessToken, expiresAt: token.expiresAt, tradovateUserId: carried.tradovateUserId },
  };
}

/**
 * Active connections whose refresh token expires within `withinMs`.
 *
 * For the daily keep-alive. Reads the table here rather than in the cron route
 * because this module is the only one that touches `tradovate_connections` —
 * the caller gets rows it cannot decrypt and hands them straight back to
 * {@link redeemRefreshToken}.
 *
 * `refresh_expires_at IS NULL` rows are deliberately NOT selected. A null means
 * we never recorded a lifetime — every row written before migration 030 added
 * the column — and redeeming on a guess about an unknown expiry is the kind of
 * invention this integration refuses everywhere else. Those connections behave
 * exactly as they did before this change; they recover by reconnecting once,
 * after which the column is populated.
 */
export async function listConnectionsDueForRefresh(params: {
  admin: SupabaseClient;
  withinMs: number;
}): Promise<StoredConnection[]> {
  const { admin, withinMs } = params;
  const cutoff = new Date(Date.now() + withinMs).toISOString();

  const { data, error } = await admin
    .from('tradovate_connections')
    .select(CONNECTION_COLUMNS)
    .eq('status', 'active')
    .not('refresh_token_encrypted', 'is', null)
    .not('refresh_expires_at', 'is', null)
    .lte('refresh_expires_at', cutoff)
    // Soonest to expire first, so a run that is cut off short has done the most
    // urgent work rather than an arbitrary slice of it.
    .order('refresh_expires_at', { ascending: true })
    .returns<ConnectionRow[]>();

  if (error) {
    throw new Error(`Failed to list Tradovate connections due for refresh: ${error.message}`);
  }
  return data ?? [];
}

/** One connection, as the daily import loop needs it. Two columns, no secret. */
export interface ImportCandidate {
  user_id: string;
  /** E7's declaration. False means this user's trades are not imported. */
  is_trade_source: boolean | null;
}

/**
 * Every active connection, for the daily import (REF-107 Stage 2).
 *
 * Reads the table here rather than in the cron route because this module is the
 * only one that touches `tradovate_connections` — and the two columns it
 * returns are deliberately the only two: a user id the loop needs, and the
 * declaration that decides whether that user's trades are imported at all.
 * NEITHER TOKEN COLUMN IS SELECTED. The loop never holds a credential; each
 * per-user import resolves its own through {@link getUserTradingApi}, which
 * shares the cache and the single-flight and therefore does not open a second
 * Tradovate session (§C12, and the documented cap of two).
 *
 * ONLY CALL THIS BEHIND `isImportEnabled()` — `is_trade_source` is a column
 * migration 034 adds, and naming it before that file has been run is a
 * PostgREST 42703. Same contract as {@link readIsTradeSource}.
 *
 * `status = 'active'` only, like {@link listConnectionsDueForRefresh}. An
 * expired or revoked connection has no credential to read with; the trader has
 * to reconnect, and importing on their behalf is not something a nightly job
 * can do about it.
 *
 * Ordered by `user_id` so a run cut short by the function's time budget covers
 * a stable prefix rather than an arbitrary slice — which makes a truncated run
 * diagnosable from the counts alone.
 */
export async function listConnectionsForImport(params: {
  admin: SupabaseClient;
}): Promise<ImportCandidate[]> {
  const { data, error } = await params.admin
    .from('tradovate_connections')
    .select('user_id, is_trade_source')
    .eq('status', 'active')
    .order('user_id', { ascending: true })
    .returns<ImportCandidate[]>();

  if (error) {
    throw new Error(`Failed to list Tradovate connections for import: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Redeem this connection's refresh token if it is close enough to expiring, on
 * the way to serving an ordinary request. Returns null when nothing was due.
 *
 * The threshold is {@link REFRESH_REDEEM_MARGIN_MS} — 12 hours out of a measured
 * 26-hour lifetime. Wide on purpose: this is the backstop for the daily cron,
 * which Vercel may run up to about an hour late and may not run at all, so the
 * margin has to cover a missed day rather than merely a slow one. Redeeming
 * early costs nothing, because every redemption issues a fresh 26-hour refresh
 * token and the grant does not open a session.
 *
 * Nothing happens when the lifetime is unknown (`refresh_expires_at` null or
 * unparsable) — see {@link listConnectionsDueForRefresh} for why a guess is
 * refused there too.
 *
 * A configuration failure here is not fatal and not logged per call on the
 * ordinary path: a deployment with no OAuth configuration cannot redeem
 * anything, and the renewal path below still works. The connect route is where
 * that gets reported, loudly, to someone who can fix it. On the `force` path it
 * IS logged — see the `options.force` note below.
 *
 * @param options.force Skip {@link REFRESH_REDEEM_MARGIN_MS} and redeem now.
 * Set when the access token has already lapsed: renewal is impossible then (it
 * must present a live token) and the refresh grant is the ONLY recovery. The
 * margin exists to space out redemptions against a daily cron; it was never
 * meant to decide whether a connection is recoverable at all, and leaving it in
 * charge of that is REF-100's 14.10 regression — a successful cron run pins
 * `refresh_expires_at` ~26h out, so the margin cannot fire for the ~14 hours in
 * which the access token that same run issued is already dead. The guards above
 * the margin stay unconditional: `force` must not turn a missing token or an
 * unrecorded lifetime into a guess. When the forced path declines anyway it
 * logs, because the silent `null` here is what cost REF-100 its diagnosis.
 */
async function redeemRefreshTokenIfDue(
  row: ConnectionRow,
  admin: SupabaseClient,
  options: { force?: boolean } = {}
): Promise<RefreshRedemption | null> {
  // One line, once, and only when the caller had no other recovery left. The
  // ordinary path stays silent: declining inside the margin is the design.
  const declined = (reason: string): null => {
    if (options.force) {
      console.warn(
        redactSecrets(
          `[tradovate] forced refresh redemption declined (${reason}); the access token has ` +
            'lapsed and renewal cannot run, so this request has no recovery path'
        )
      );
    }
    return null;
  };

  if (!row.refresh_token_encrypted || !row.refresh_expires_at) {
    return declined('no refresh token, or no recorded refresh lifetime');
  }

  const refreshExpiry = Date.parse(row.refresh_expires_at);
  if (!Number.isFinite(refreshExpiry)) return declined('refresh_expires_at did not parse');
  if (!options.force && refreshExpiry - Date.now() > REFRESH_REDEEM_MARGIN_MS) return null;
  // Still refused when the refresh token is itself past its deadline: there is
  // nothing to redeem, and the caller's expired write below is the answer.
  if (refreshExpiry - Date.now() <= 0) return declined('the refresh token is past its own expiry');

  const config = loadOAuthConfig();
  if (!config.ok) return declined('Tradovate OAuth is not configured');

  return redeemRefreshToken({ connection: row, config: config.config, admin });
}

async function loadOrRenew(
  userId: string,
  admin: SupabaseClient
): Promise<UserTokenSnapshot> {
  const { data, error } = await admin
    .from('tradovate_connections')
    .select(CONNECTION_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle<ConnectionRow>();

  if (error) throw new Error(`Failed to read the Tradovate connection: ${error.message}`);

  if (!data) {
    cache.delete(userId);
    throw new TradovateNotConnectedError(userId, 'missing');
  }
  // TODO(REF-100 follow-up): make this gate self-healing. A row that is
  // 'expired' but still holds a refresh token whose refresh_expires_at is in
  // the future is recoverable — one redemption would revive it — and refusing
  // it here is what makes any stray 'expired' permanent, since
  // listConnectionsDueForRefresh() also selects status='active' only. That
  // would recover rows stranded by causes this branch cannot see: REF-101
  // before its fix, the rotation race before
  // markExpiredIfRefreshUnchanged(), and any future write that gets it wrong.
  // Deliberately NOT done here — it needs a guard against redeeming in a loop
  // on a row that is expired for a good reason, which is more than this change
  // should carry.
  if (data.status !== 'active') {
    cache.delete(userId);
    throw new TradovateNotConnectedError(userId, data.status === 'revoked' ? 'revoked' : 'expired');
  }

  const storedExpiry = Date.parse(data.expires_at);
  const accessToken = decryptToken(data.access_token_encrypted, 'access', userId);
  const tradovateUserId = data.tradovate_user_id;

  // The refresh token first, because it is the one with a deadline that cannot
  // be recovered from. The access token can always be renewed while it is live;
  // a refresh token that lapses means a reconnect, and this is the path that
  // keeps that from happening between daily cron runs — a missed run, an hour
  // of Vercel drift, or a user whose connection was made just after the last
  // one. Checked even when the access token is fresh, which is why it sits
  // above the early return.
  //
  // "While it is live" is the load-bearing clause, so the code has to check it:
  // with a lapsed access token the renewal below refuses to run at all and the
  // refresh grant is the only recovery, whatever REFRESH_REDEEM_MARGIN_MS says.
  // MIN_REMAINING_MS and not RENEW_MARGIN_MS is the threshold on purpose — this
  // asks "can a renewal still be attempted at all", which is the same question
  // the lapsed-token guard below answers, not "is it time to renew".
  const accessTokenUsable =
    Number.isFinite(storedExpiry) && storedExpiry - Date.now() > MIN_REMAINING_MS;

  const refreshRedemption = await redeemRefreshTokenIfDue(data, admin, {
    force: !accessTokenUsable,
  });

  if (refreshRedemption) {
    if (refreshRedemption.outcome === 'refreshed' || refreshRedemption.outcome === 'superseded') {
      // The grant issued a new access token too, with a full lifetime ahead of
      // it, so there is nothing left for the renewal below to do.
      return remember(userId, refreshRedemption.snapshot);
    }
    if (refreshRedemption.outcome === 'expired') {
      cache.delete(userId);
      throw new TradovateNotConnectedError(userId, 'expired');
    }
    // 'transient' or 'skipped': nothing was written and the stored access token
    // is untouched. Fall through — a refresh-token problem must not cost the
    // caller a request the access token in hand can still serve.
  }

  // Another instance may have renewed since this one last looked; if the stored
  // token is comfortably fresh, use it rather than renewing again.
  if (Number.isFinite(storedExpiry) && storedExpiry - Date.now() > RENEW_MARGIN_MS) {
    return remember(userId, { accessToken, expiresAt: storedExpiry, tradovateUserId });
  }

  // Renewal has to present a live token, so one that has already lapsed cannot
  // be recovered by renewing. Reaching here means the refresh token could not
  // recover it either: either there is none, its own expiry has passed, or the
  // redemption above failed transiently.
  if (!Number.isFinite(storedExpiry) || storedExpiry - Date.now() <= MIN_REMAINING_MS) {
    cache.delete(userId);

    // A refresh token that is still in date changes what this moment means, and
    // REF-100 is why. The access token lapsing used to be the end of the
    // connection, so writing 'expired' recorded a fact. Now it is recoverable:
    // the only way to be here with a live refresh token is a redemption that
    // failed WITHOUT a verdict a moment ago (a definitive refusal returns
    // 'expired' above and never reaches this line), and a transient failure is
    // precisely what must not be written down. Marking it expired would have the
    // status gate refuse the row on every later call, so a 5xx at the wrong
    // minute would cost a user a reconnect that the next run would otherwise
    // have avoided — REF-101's mistake, reintroduced one layer down.
    const refreshExpiry = data.refresh_expires_at ? Date.parse(data.refresh_expires_at) : Number.NaN;
    if (
      data.refresh_token_encrypted &&
      Number.isFinite(refreshExpiry) &&
      refreshExpiry - Date.now() > 0
    ) {
      throw new TradovateTransientError(
        'The Tradovate access token has run out and the refresh token could not be redeemed ' +
          'just now. The refresh token is still in date, so the connection is presumed intact. ' +
          'Retry later.',
        { reason: refreshRedemption?.outcome === 'transient' ? refreshRedemption.reason : 'unknown' }
      );
    }

    // Nothing left to recover with: no refresh token, or its own lifetime has
    // run out too. This is the state the user does have to reconnect from.
    //
    // Conditional even here, where the row looked unrecoverable: this read is
    // older than the write, and a redemption committing in between would have
    // left a live connection that this call is about to declare dead. A row
    // with no refresh token matches on IS NULL, so the ordinary case is
    // unaffected.
    const marked = await markExpiredIfRefreshUnchanged({
      userId,
      expectRefreshTokenCiphertext: data.refresh_token_encrypted,
      admin,
    });
    if (!marked.applied) {
      // Someone stored a new refresh token while we were deciding, so this
      // conclusion is about a row that no longer exists in that form. Nothing
      // was written; the next call reads the row and will find the tokens that
      // replaced ours.
      throw new TradovateTransientError(
        'The Tradovate access token had run out, but the connection changed while that was ' +
          'being recorded. Nothing was written. Retry.',
        { reason: 'unknown' }
      );
    }
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
  } catch (error) {
    // No cause is chained on anything thrown from this block: a renewal failure
    // can carry the response body, and that body can carry a token. The verdict
    // is read off the error's type and status instead.
    const verdict = classifyRenewalFailure(error);

    if (verdict.kind === 'rejected') {
      // Tradovate refused the credential. There is no re-authentication
      // fallback here — see the header — so record the state and make the caller
      // deal with a disconnected account.
      cache.delete(userId);

      // Conditional, like the other two expired writes. The renewal presented
      // the access token THIS call read, and a concurrent redemption may have
      // replaced it since: a 401 on a token that has already been superseded is
      // a verdict on a credential the row no longer uses, and recording it
      // would kill a connection that was just refreshed.
      const marked = await markExpiredIfRefreshUnchanged({
        userId,
        expectRefreshTokenCiphertext: data.refresh_token_encrypted,
        admin,
      });
      if (!marked.applied) {
        throw new TradovateTransientError(
          'Tradovate refused the stored access token, but the connection had already been ' +
            'refreshed by another call. Nothing was written. Retry.',
          { reason: 'unknown' }
        );
      }
      throw new TradovateNotConnectedError(userId, 'expired');
    }

    // Transient. Nothing is written: not the status, not updated_at. The row
    // still describes a connection that was working a moment ago, and the next
    // call retries the renewal from a fresh read.
    //
    // Worth a log line because this path is otherwise invisible — it returns a
    // usable token and the caller sees an ordinary success. Through
    // redactSecrets() like every diagnostic in this integration.
    console.warn(
      redactSecrets(
        `[tradovate] renewal failed transiently (${verdict.reason}: ${verdict.detail}); ` +
          'connection left untouched'
      )
    );

    // The stored token is usually still good: this point is only reached inside
    // the renewal margin, which is 15 minutes wide, so there is normally plenty
    // left. Hand it back rather than throwing — a rate limit we may not even
    // have caused must not cost the user a request they could have served.
    //
    // Re-measured rather than trusted from the guard above, because the renewal
    // itself awaited: a request that hung until it timed out can easily have
    // spent the margin that guard saw. Deliberately not cached either, so the
    // next call reads the row and tries the renewal again — remember() would be
    // inert here anyway, since getUserAccessToken() ignores a cache entry this
    // close to expiry.
    const remainingMs = storedExpiry - Date.now();
    if (Number.isFinite(storedExpiry) && remainingMs > MIN_REMAINING_MS) {
      return { accessToken, expiresAt: storedExpiry, tradovateUserId };
    }

    // The token ran out while the renewal was failing. Still no write: the token
    // lapsing is not the same claim as the server refusing it, and the next
    // call reaches the expiry guard above, which marks the row then.
    cache.delete(userId);
    throw new TradovateTransientError(
      `Could not renew the Tradovate token (${verdict.reason}) and the stored one has ` +
        'run out. Retry later.',
      { reason: verdict.reason, retryAfterSeconds: verdict.retryAfterSeconds }
    );
  }

  const expiresAt = Date.parse(renewed.expirationTime);
  if (Number.isNaN(expiresAt)) {
    // No status write here either, for the same reason as the transient branch
    // above, and this one was the starker case: the renewal SUCCEEDED and
    // Tradovate issued a fresh token — we just cannot read the expiry it came
    // with. Recording 'expired' made the status gate refuse the row on every
    // later call, so a malformed field in one response killed a connection that
    // the exchange had just renewed. REF-90 §7.3 classes this
    // broker_unavailable, a server fault, and not the user's connection.
    cache.delete(userId);
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
    // records which server actually minted the token, and a renewal must not be
    // able to relabel it.
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

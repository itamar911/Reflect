/**
 * REF-101 and REF-100 — what a failed token operation is allowed to do to a
 * connection, and whether the refresh-token keep-alive survives a race.
 *
 *   npm run tradovate:refresh-check
 *
 * PART 1 (REF-101) — the bug: the catch around renewAccessToken() in
 * src/lib/tradovate/connections.ts caught every exception alike, wrote
 * status='expired' and threw TradovateNotConnectedError. A rate limit, a
 * timeout, a 5xx or an unreadable body — all transient — turned a working
 * connection into a permanently dead row, because the status gate earlier in the
 * same function then refuses that row immediately on every later call. The
 * renewal endpoint's 15-per-hour limit is counted per IP address, and Vercel
 * lambdas share egress addresses, so the traffic that triggers this need not
 * even be ours (REF-90 §2.4).
 *
 * Each case drives the real getUserAccessToken() and checks three things:
 *
 *   1. was a status written to the database, and which,
 *   2. which error came out, if any,
 *   3. was the still-valid stored token handed back instead.
 *
 * Run it against the pre-fix code (git stash) and the transient rows fail.
 *
 * PART 2 (REF-100) — the keep-alive. The refresh token ROTATES on redemption
 * (measured 13 Oct 2026), so the dangerous case is not a failure but a RACE:
 * two concurrent redemptions hold two different new refresh tokens and only the
 * later one works, so a loser that overwrote the winner would store a spent
 * token and cost the user the reconnect REF-100 exists to prevent. These cases
 * check that the compare-and-swap refuses the losing write, that the re-read
 * adopts the winner's tokens instead of reporting a dead connection, and that
 * the same only-on-proof rule as Part 1 governs `invalid_grant` versus a 5xx.
 *
 * PART 3 (REF-100) — the cron: that it refuses an unauthenticated caller, and
 * that one connection's failure does not stop the others.
 *
 *
 * NO DATABASE, NO NETWORK, NO CREDENTIALS
 * ---------------------------------------
 *
 * There is no unit-test harness in this repo (REF-90 §8.1), so this is a script
 * in the style of the other scripts/tradovate-*.ts, and it is self-contained:
 *
 * - The Supabase client is a stub, passed in through the `admin` option that
 *   getUserAccessToken() and runKeepAlive() already accept. It records writes
 *   instead of making them, and Part 2 needs it to be a small real
 *   implementation rather than a recorder: a compare-and-swap cannot be tested
 *   against a stub that accepts every write. Nothing reaches Supabase, which is
 *   also the rule in CLAUDE.md.
 * - globalThis.fetch is replaced per case. Nothing reaches Tradovate.
 * - TRADOVATE_TOKEN_ENCRYPTION_KEY is generated here, in memory, for this
 *   process only. The real key is neither read nor needed; the tokens it
 *   protects are the fake ones below. The OAuth config is fabricated too, so
 *   nothing reads .env.local — note that `npm run tradovate:refresh-check`
 *   deliberately has no --env-file flag, unlike the other tradovate scripts.
 *   No secret is printed, and the fake tokens are never printed either — this
 *   output gets pasted into chats.
 */

import { randomBytes } from 'node:crypto';

import { GET as keepAliveRoute } from '../src/app/api/cron/tradovate-keepalive/route';
import {
  clearAllCachedTokens,
  getUserAccessToken,
  redeemRefreshToken,
  saveConnection,
  type StoredConnection,
} from '../src/lib/tradovate/connections';
import * as tradovateErrors from '../src/lib/tradovate/errors';
import { TradovateNotConnectedError } from '../src/lib/tradovate/errors';
import { runKeepAlive } from '../src/lib/tradovate/keepalive';
import type { TradovateOAuthConfig } from '../src/lib/tradovate/oauth-config';
import { decryptToken, encryptToken } from '../src/lib/tradovate/token-crypto';

/**
 * Looked up rather than imported by name, so this script still runs against the
 * pre-fix tree, where the class does not exist yet. Importing it directly would
 * make `git stash && npx tsx scripts/tradovate-refresh-check.ts` die on a
 * missing export instead of reporting which cases regress — and reporting that
 * is the whole point of running it there.
 */
const TransientError = (tradovateErrors as Record<string, unknown>).TradovateTransientError as
  | (new (...args: never[]) => Error & { reason?: string })
  | undefined;

// Assigned at module scope, which is early enough however the imports above are
// hoisted: token-crypto.ts reads this variable lazily, inside each encrypt and
// decrypt, not when it loads. An ephemeral key also keeps the script runnable on
// a machine with no Tradovate configuration at all.
process.env.TRADOVATE_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');

/**
 * A complete but entirely fake OAuth configuration, for the same reason.
 *
 * REQUIRED, not cosmetic: the refresh redemption on the request path calls
 * loadOAuthConfig() and does nothing at all when it fails — a deployment with no
 * OAuth configuration has no token endpoint to redeem against. Without these
 * five variables every Part 2 case would pass vacuously, having sent nothing and
 * proved nothing. That is exactly what happened the first time this part was
 * run, which is why it is spelled out here.
 *
 * Every value is invented and none is read from .env.local — `npm run
 * tradovate:refresh-check` deliberately carries no --env-file flag, unlike the
 * other tradovate scripts. TRADOVATE_API_URL has to be a host detectEnvironment()
 * recognises, so it names the documented demo host; nothing is ever sent to it,
 * because globalThis.fetch is stubbed for every case.
 */
process.env.TRADOVATE_API_URL = 'https://demo.tradovateapi.com/v1';
process.env.TRADOVATE_OAUTH_CLIENT_ID = 'test-client-id';
process.env.TRADOVATE_OAUTH_CLIENT_SECRET = 'test-client-secret-not-a-real-one';
process.env.TRADOVATE_OAUTH_REDIRECT_URI = 'https://example.invalid/api/tradovate/callback';

const EXIT_OK = 0;
const EXIT_FAILED = 1;

const STORED_TOKEN = 'stored-access-token-not-a-real-one';
const RENEWED_TOKEN = 'renewed-access-token-not-a-real-one';

/** Inside RENEW_MARGIN_MS (15 min) so a renewal is attempted, and far above MIN_REMAINING_MS. */
const EXPIRES_IN_10_MIN = 10 * 60_000;

/**
 * Just over MIN_REMAINING_MS (30s). Paired with a slow failure, this is how the
 * "the token ran out while the renewal was failing" case is reached: the guard
 * before the renewal sees a live token, and the catch afterwards does not.
 */
const EXPIRES_IN_35_SEC = 35_000;
const SLOW_FAILURE_MS = 6_000;

/** What the stub client was asked to do. */
interface Writes {
  /** Status writes that actually matched a row. A refused one is NOT here. */
  statusUpdates: string[];
  upserts: number;
  /** Conditional saves whose condition held, so the row was written. */
  casApplied: number;
  /** Conditional saves that matched no row — a lost rotation race. */
  casRejected: number;
  /**
   * Conditional `expired` writes that matched no row because the refresh token
   * had moved on. The count that proves the REF-100 race fix is doing its job.
   */
  statusWritesRefused: number;
}

function noWrites(): Writes {
  return {
    statusUpdates: [],
    upserts: 0,
    casApplied: 0,
    casRejected: 0,
    statusWritesRefused: 0,
  };
}

type Row = Record<string, unknown>;

/**
 * A tiny in-memory stand-in for the one table this code touches.
 *
 * REF-101's version of this stub returned a fixed row from every select and
 * accepted every write. That cannot test REF-100: the whole mechanism is a
 * conditional UPDATE that must match ZERO rows when another redemption has
 * rotated the refresh token, so a stub that accepts every write would pass
 * whether or not the condition existed. So this one keeps rows in a Map and
 * actually applies filters.
 *
 * It implements exactly the calls this code path makes, in the shapes it makes
 * them:
 *
 *   loadOrRenew / reconcile   .select(cols).eq(…).maybeSingle()
 *   listConnectionsDueForRefresh
 *                             .select(cols).eq().not().not().lte().order()
 *                               .returns()   — awaited
 *   markStatus                .update(values).eq(…)   — awaited
 *   saveConnection (CAS)      .update(values).eq(…).eq(…).select(cols)
 *   saveConnection (upsert)   .upsert(values, …)
 *
 * The two terminal forms on an update are how the two write paths are told
 * apart: markStatus awaits the builder, the compare-and-swap calls .select().
 */
/**
 * A one-shot window for landing a competing write at an exact point.
 *
 * Fires on the first SELECT after it is armed, AFTER that select has been
 * served — which is precisely the gap the REF-100 race lives in: reconcile()
 * reads the old ciphertext, the winner commits, and only then does the loser
 * write its verdict. Armed by the stubbed token endpoint so that it cannot fire
 * on the read that precedes the grant.
 *
 * Deterministic by construction: no sleeps, no Promise.all, no reliance on
 * which continuation the event loop happens to run first.
 */
interface RaceWindow {
  armed: boolean;
  run: () => void | Promise<void>;
}

function storeAdmin(store: Map<string, Row>, writes: Writes, race?: RaceWindow) {
  const rows = () => [...store.values()];

  function selectBuilder() {
    const filters: Array<(row: Row) => boolean> = [];
    let orderBy: string | null = null;

    const builder = {
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return builder;
      },
      /**
       * Only ever called as .not(column, 'is', null), and the operator and
       * value are not declared because nothing here varies on them — an extra
       * argument to a JS function is simply ignored.
       */
      not(column: string) {
        filters.push((row) => row[column] !== null && row[column] !== undefined);
        return builder;
      },
      lte(column: string, value: string) {
        // ISO-8601 UTC strings sort lexicographically, which is why the real
        // query can compare them as text too.
        filters.push((row) => typeof row[column] === 'string' && (row[column] as string) <= value);
        return builder;
      },
      order(column: string) {
        orderBy = column;
        return builder;
      },
      returns() {
        return builder;
      },
      maybeSingle: async () => {
        const found = rows().filter((row) => filters.every((f) => f(row)));
        // A COPY, not the stored object. PostgREST hands back JSON, so a caller
        // holding a result cannot see a later write — and the race tests depend
        // on exactly that: reconcile() must keep seeing the ciphertext it was
        // served even after the winner has overwritten the row.
        const snapshot = found[0] ? { ...found[0] } : null;
        // After the read is served, before the caller acts on it.
        if (race?.armed) {
          race.armed = false;
          await race.run();
        }
        return { data: snapshot, error: null };
      },
      // Awaitable, for the list query. Returns a plain promise rather than
      // itself, so awaiting cannot recurse.
      then<T>(
        resolve: (value: { data: Row[]; error: null }) => T,
        reject?: (reason: unknown) => T
      ) {
        const found = rows().filter((row) => filters.every((f) => f(row)));
        if (orderBy) {
          found.sort((a, b) => String(a[orderBy!] ?? '').localeCompare(String(b[orderBy!] ?? '')));
        }
        // Copies, for the same reason as maybeSingle() above.
        const snapshot = found.map((row) => ({ ...row }));
        return Promise.resolve({ data: snapshot, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function updateBuilder(values: Row) {
    const filters: Array<(row: Row) => boolean> = [];

    /** Apply to every matching row and report which matched. */
    const apply = () => {
      const found = rows().filter((row) => filters.every((f) => f(row)));
      for (const row of found) Object.assign(row, values);
      return found;
    };

    const builder = {
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return builder;
      },
      /**
       * Only ever called as .is(column, null), for the expired write against a
       * row that legitimately holds no refresh token. `?? null` so a column
       * that is absent from a stub row reads as NULL, like Postgres.
       */
      is(column: string, value: unknown) {
        filters.push((row) => (row[column] ?? null) === value);
        return builder;
      },
      /**
       * The terminal call for BOTH conditional writes, told apart by shape:
       * only the full-row save carries access_token_encrypted, and only the
       * status write carries status alone.
       *
       * A write that matched no row wrote NOTHING, so it must not be recorded
       * as a status update — that distinction is the whole of the REF-100 race
       * fix, and recording it anyway would make the regression test pass
       * against the broken code.
       */
      select() {
        const found = apply();
        const isFullRowSave = 'access_token_encrypted' in values;

        if (isFullRowSave) {
          if (found.length > 0) writes.casApplied += 1;
          else writes.casRejected += 1;
        } else if (found.length > 0) {
          writes.statusUpdates.push(String(values.status));
        } else {
          writes.statusWritesRefused += 1;
        }

        return Promise.resolve({
          data: found.map((row) => ({ user_id: row.user_id })),
          error: null,
        });
      },
      /**
       * markStatus()'s terminal form: it just awaits the builder. Still used by
       * the unconditional paths — disconnectUser()'s 'revoked' write.
       */
      then<T>(resolve: (value: { data: null; error: null }) => T, reject?: (reason: unknown) => T) {
        apply();
        writes.statusUpdates.push(String(values.status));
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    from() {
      return {
        select: () => selectBuilder(),
        update: (values: Row) => updateBuilder(values),
        upsert: async (values: Row) => {
          writes.upserts += 1;
          const key = String(values.user_id);
          const existing = store.get(key);
          if (existing) Object.assign(existing, values);
          else store.set(key, { ...values });
          return { data: null, error: null };
        },
      };
    },
    // Cast at the boundary: the stub implements the calls this code path makes,
    // not the SupabaseClient interface, and widening it any other way would mean
    // importing the generated types for no gain in a script.
  } as never;
}

/** One-row store, for the REF-101 cases. */
function singleRowStore(row: Row): Map<string, Row> {
  return new Map([[String(row.user_id), row]]);
}

function connectionRow(userId: string, expiresInMs: number): Record<string, unknown> {
  return {
    user_id: userId,
    access_token_encrypted: encryptToken(STORED_TOKEN, 'access', userId),
    refresh_token_encrypted: null,
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    tradovate_user_id: 12345,
    environment: 'demo',
    status: 'active',
    refresh_expires_at: null,
    token_type: 'bearer',
    api_hosts: null,
  };
}

/** A fetch that answers once with this status and body, however malformed. */
function respondWith(status: number, body: string, delayMs = 0): typeof fetch {
  return (async () => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  }) as unknown as typeof fetch;
}

/** A fetch that fails the way an aborted or network-severed request does. */
function failWith(name: string, message: string, delayMs = 0): typeof fetch {
  return (async () => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    throw Object.assign(new Error(message), { name });
  }) as unknown as typeof fetch;
}

const okBody = JSON.stringify({
  accessToken: RENEWED_TOKEN,
  expirationTime: new Date(Date.now() + 80 * 60_000).toISOString(),
});

/** What a case expects. `token: 'stored' | 'renewed' | null`. */
interface Expectation {
  status: string | null;
  error: 'not-connected' | 'transient' | null;
  token: 'stored' | 'renewed' | null;
}

interface Case {
  name: string;
  why: string;
  fetch: typeof fetch;
  expiresInMs?: number;
  expect: Expectation;
}

const DEAD: Expectation = { status: 'expired', error: 'not-connected', token: null };
const SURVIVES: Expectation = { status: null, error: null, token: 'stored' };

const cases: Case[] = [
  {
    name: 'HTTP 401',
    why: 'the token was presented and refused — the one thing that proves it is dead',
    fetch: respondWith(401, JSON.stringify({ errorText: 'Unauthorized' })),
    expect: DEAD,
  },
  {
    name: 'HTTP 403',
    why: 'likewise a refusal of the credential',
    fetch: respondWith(403, JSON.stringify({ errorText: 'Forbidden' })),
    expect: DEAD,
  },
  {
    name: 'HTTP 401, unparsable body',
    why: 'auth.ts parses before it checks res.ok, so this arrives as a parse failure; the status still decides',
    fetch: respondWith(401, '<html>Unauthorized</html>'),
    expect: DEAD,
  },
  {
    name: 'errorText states refusal',
    why: 'HTTP 200 carrying "Access token is expired" — a refusal stated in the body',
    fetch: respondWith(200, JSON.stringify({ errorText: 'Access token is expired' })),
    expect: DEAD,
  },
  {
    name: 'rate limit penalty (p-ticket)',
    why: 'REF-101 itself: 15/hour per IP, possibly spent by another tenant. Must not touch the row',
    fetch: respondWith(200, JSON.stringify({ 'p-ticket': 'abc', 'p-time': 30 })),
    expect: SURVIVES,
  },
  {
    name: 'rate limit penalty (captcha)',
    why: 'unanswerable by an API client, but still a limiter verdict and not a token verdict',
    fetch: respondWith(200, JSON.stringify({ 'p-captcha': true })),
    expect: SURVIVES,
  },
  {
    name: 'HTTP 500',
    why: 'the server failed to answer; it has said nothing about the token',
    fetch: respondWith(500, 'Internal Server Error'),
    expect: SURVIVES,
  },
  {
    name: 'timeout / abort',
    why: 'the request may never have reached Tradovate',
    fetch: failWith('AbortError', 'The operation was aborted'),
    expect: SURVIVES,
  },
  {
    name: 'network failure',
    why: 'DNS, TLS or a reset — same reasoning as a timeout',
    fetch: failWith('TypeError', 'fetch failed'),
    expect: SURVIVES,
  },
  {
    name: 'HTTP 200, unparsable JSON',
    why: 'we could not read the answer, which is not the same as being refused',
    fetch: respondWith(200, 'not json at all {{{'),
    expect: SURVIVES,
  },
  {
    name: 'HTTP 200, no accessToken',
    why: 'a well-formed body that is not the documented one — a server fault',
    fetch: respondWith(200, JSON.stringify({ something: 'else' })),
    expect: SURVIVES,
  },
  {
    name: 'errorText states no verdict',
    why: 'unrecognised text defaults to transient; a loose match would cost a user their connection',
    fetch: respondWith(200, JSON.stringify({ errorText: 'Internal error, try again' })),
    expect: SURVIVES,
  },
  {
    name: 'transient, token ran out',
    why: `a ${SLOW_FAILURE_MS / 1000}s failure against a token with ${
      EXPIRES_IN_35_SEC / 1000
    }s left: still no write, but nothing valid to return either`,
    fetch: respondWith(500, 'Internal Server Error', SLOW_FAILURE_MS),
    expiresInMs: EXPIRES_IN_35_SEC,
    expect: { status: null, error: 'transient', token: null },
  },
  {
    name: 'renewal succeeds',
    why: 'the path that must keep working: new token stored, nothing marked',
    fetch: respondWith(200, okBody),
    expect: { status: null, error: null, token: 'renewed' },
  },
];

/** Run one case and describe what actually happened. */
async function observe(testCase: Case): Promise<{ actual: Expectation; note: string }> {
  const userId = `user-${Math.random().toString(36).slice(2, 10)}`;
  const writes = noWrites();
  const row = connectionRow(userId, testCase.expiresInMs ?? EXPIRES_IN_10_MIN);
  const store = singleRowStore(row);

  clearAllCachedTokens();
  const realFetch = globalThis.fetch;
  globalThis.fetch = testCase.fetch;

  let error: 'not-connected' | 'transient' | null = null;
  let token: 'stored' | 'renewed' | null = null;
  let note = '';

  try {
    const snapshot = await getUserAccessToken(userId, { admin: storeAdmin(store, writes) });
    token =
      snapshot.accessToken === STORED_TOKEN
        ? 'stored'
        : snapshot.accessToken === RENEWED_TOKEN
          ? 'renewed'
          : null;
    if (token === null) note = 'returned an unrecognised token';
  } catch (thrown: unknown) {
    if (thrown instanceof TradovateNotConnectedError) {
      error = 'not-connected';
      note = `TradovateNotConnectedError(${thrown.status})`;
    } else if (TransientError && thrown instanceof TransientError) {
      error = 'transient';
      note = `TradovateTransientError(${thrown.reason})`;
    } else {
      // Not one of the two, so not a pass — named rather than swallowed.
      error = null;
      note = `unexpected ${thrown instanceof Error ? thrown.name : typeof thrown}`;
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  // More than one status write would mean a second path also wrote; the join
  // keeps that visible rather than hiding it behind [0].
  const status = writes.statusUpdates.length ? writes.statusUpdates.join('+') : null;
  if (writes.upserts) note = note ? `${note}, saved` : 'saved';

  return { actual: { status, error, token }, note };
}

function describe(e: Expectation): string {
  const status = e.status ? `status=${e.status}` : 'no DB write';
  const error = e.error === 'not-connected' ? 'NotConnected' : e.error === 'transient' ? 'Transient' : 'no throw';
  const token = e.token ? `${e.token} token` : 'no token';
  return `${status.padEnd(14)} ${error.padEnd(13)} ${token}`;
}

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — REF-100: the refresh-token keep-alive
// ════════════════════════════════════════════════════════════════════════════

const ROTATED_REFRESH = 'rotated-refresh-token-not-a-real-one';
const ORIGINAL_REFRESH = 'original-refresh-token-not-a-real-one';
const REDEEMED_TOKEN = 'redeemed-access-token-not-a-real-one';
/** The tokens a competing redemption stores while ours is in flight. */
const WINNER_ACCESS = 'winner-access-token-not-a-real-one';
const WINNER_REFRESH = 'winner-refresh-token-not-a-real-one';

/** Measured lifetimes, 13 Oct 2026. */
const ACCESS_LIFETIME_SEC = 4800;
const REFRESH_LIFETIME_SEC = 93600;

/** Inside REFRESH_REDEEM_MARGIN_MS (12h), so a redemption is due. */
const REFRESH_EXPIRES_IN_6_H = 6 * 60 * 60_000;
/** Outside it, so nothing should be redeemed. */
const REFRESH_EXPIRES_IN_20_H = 20 * 60 * 60_000;
/**
 * Access token comfortably outside RENEW_MARGIN_MS (15 min), so any redemption
 * these cases observe was triggered by the REFRESH token's expiry and not by
 * the access token's. That separation is the point of the margin test.
 */
const ACCESS_EXPIRES_IN_60_MIN = 60 * 60_000;

/**
 * A fabricated OAuth configuration. Nothing here is real and nothing is read
 * from the environment: `npm run tradovate:refresh-check` runs without
 * --env-file precisely so that this script cannot pick up .env.local.
 */
const FAKE_CONFIG: TradovateOAuthConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret-not-a-real-one',
  redirectUri: 'https://example.invalid/api/tradovate/callback',
  authorizeUrl: 'https://example.invalid/oauth',
  tokenUrl: 'https://example.invalid/auth/oauthtoken',
  apiUrl: 'https://demo.example.invalid/v1',
  liveApiUrl: 'https://live.example.invalid/v1',
  environment: 'demo',
};

function keepAliveRow(params: {
  userId: string;
  accessExpiresInMs?: number;
  refreshExpiresInMs?: number;
  refreshToken?: string;
  environment?: 'demo' | 'live';
}): Row {
  const {
    userId,
    accessExpiresInMs = ACCESS_EXPIRES_IN_60_MIN,
    refreshExpiresInMs = REFRESH_EXPIRES_IN_6_H,
    refreshToken = ORIGINAL_REFRESH,
    environment = 'demo',
  } = params;

  return {
    user_id: userId,
    access_token_encrypted: encryptToken(STORED_TOKEN, 'access', userId),
    refresh_token_encrypted: encryptToken(refreshToken, 'refresh', userId),
    expires_at: new Date(Date.now() + accessExpiresInMs).toISOString(),
    tradovate_user_id: 12345,
    environment,
    status: 'active',
    refresh_expires_at: new Date(Date.now() + refreshExpiresInMs).toISOString(),
    token_type: 'bearer',
    api_hosts: null,
  };
}

/** A successful refresh-grant body, in the shape production returned. */
function grantBody(
  refreshToken: string | null = ROTATED_REFRESH,
  accessToken: string = REDEEMED_TOKEN
): string {
  return JSON.stringify({
    access_token: accessToken,
    expires_in: ACCESS_LIFETIME_SEC,
    ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
    refresh_token_expires_in: REFRESH_LIFETIME_SEC,
    token_type: 'Bearer',
  });
}

/** An `invalid_grant` body — a spent refresh token, definitively refused. */
const INVALID_GRANT_BODY = JSON.stringify({
  error: 'invalid_grant',
  error_description: 'refresh token is expired or has already been used',
});

/**
 * A fetch that answers the token endpoint and refuses everything else.
 *
 * Refusing the rest is deliberate: these cases assert that the REFRESH path ran,
 * so a renewal slipping through unnoticed would make a pass meaningless. A call
 * to /auth/renewaccesstoken here fails the case loudly instead.
 *
 * `beforeRespond` is the race: it runs after the request is made and before the
 * response is returned, which is exactly the window in which a competing
 * redemption commits.
 */
function tokenEndpointFetch(params: {
  status: number;
  body: string;
  beforeRespond?: () => void;
}): typeof fetch {
  return (async (url: unknown) => {
    const href = String(url);
    if (!href.includes('/auth/oauthtoken')) {
      throw new Error(`unexpected call to ${href} — this case expects only the token endpoint`);
    }
    params.beforeRespond?.();
    return {
      ok: params.status >= 200 && params.status < 300,
      status: params.status,
      text: async () => params.body,
    };
  }) as unknown as typeof fetch;
}

/** A fetch that fails the case if anything is called at all. */
const noCallsExpected: typeof fetch = (async (url: unknown) => {
  throw new Error(`unexpected upstream call to ${String(url)} — nothing should have been sent`);
}) as unknown as typeof fetch;

interface KeepAliveExpectation {
  status: string | null;
  error: 'not-connected' | 'transient' | null;
  /** Which access token the caller got back. */
  token: 'stored' | 'redeemed' | 'winner' | null;
  /** What the row's refresh token decrypts to afterwards. */
  storedRefresh: 'original' | 'rotated' | 'winner' | null;
}

interface KeepAliveCase {
  name: string;
  why: string;
  row: (userId: string) => Row;
  fetch: (store: Map<string, Row>, userId: string) => typeof fetch;
  expect: KeepAliveExpectation;
}

const keepAliveCases: KeepAliveCase[] = [
  {
    name: 'redemption saves both tokens',
    why: 'the path that must work: a fresh access token AND the rotated refresh token stored, nothing marked',
    row: (userId) => keepAliveRow({ userId }),
    fetch: () => tokenEndpointFetch({ status: 200, body: grantBody() }),
    expect: { status: null, error: null, token: 'redeemed', storedRefresh: 'rotated' },
  },
  {
    name: 'refresh 20h out — not redeemed',
    why: 'the margin is a threshold, not a formality: outside 12h nothing is sent and the stored token is served',
    row: (userId) => keepAliveRow({ userId, refreshExpiresInMs: REFRESH_EXPIRES_IN_20_H }),
    fetch: () => noCallsExpected,
    expect: { status: null, error: null, token: 'stored', storedRefresh: 'original' },
  },
  {
    name: 'concurrent rotation (CAS loss)',
    why: 'REF-100 itself: another redemption commits mid-flight, so our save must match no row and the winner\'s tokens must be adopted — NOT expired',
    row: (userId) => keepAliveRow({ userId }),
    // The competing redemption lands while our grant is in flight: it rotates
    // the refresh token and replaces the access token, exactly as a successful
    // redemption in another lambda would.
    fetch: (store, userId) =>
      tokenEndpointFetch({
        status: 200,
        body: grantBody(),
        beforeRespond: () => {
          const row = store.get(userId)!;
          row.access_token_encrypted = encryptToken(WINNER_ACCESS, 'access', userId);
          row.refresh_token_encrypted = encryptToken(WINNER_REFRESH, 'refresh', userId);
          row.expires_at = new Date(Date.now() + ACCESS_LIFETIME_SEC * 1000).toISOString();
          row.refresh_expires_at = new Date(
            Date.now() + REFRESH_LIFETIME_SEC * 1000
          ).toISOString();
        },
      }),
    expect: { status: null, error: null, token: 'winner', storedRefresh: 'winner' },
  },
  {
    name: 'invalid_grant — definitive',
    why: 'the one verdict that licenses marking a connection expired: RFC 6749 §5.2 says the refresh token is invalid, expired or revoked',
    row: (userId) => keepAliveRow({ userId }),
    fetch: () =>
      tokenEndpointFetch({
        status: 400,
        body: JSON.stringify({
          error: 'invalid_grant',
          error_description: 'refresh token is expired',
        }),
      }),
    expect: { status: 'expired', error: 'not-connected', token: null, storedRefresh: 'original' },
  },
  {
    name: 'HTTP 500 — transient',
    why: 'the server said nothing about the token, so the row is untouched and the still-valid access token is served',
    row: (userId) => keepAliveRow({ userId }),
    fetch: () => tokenEndpointFetch({ status: 500, body: 'Internal Server Error' }),
    expect: { status: null, error: null, token: 'stored', storedRefresh: 'original' },
  },
  {
    name: 'invalid_client — NOT definitive',
    why: 'a verdict on OUR credentials, not the user\'s grant. Marking this expired would empty every connection in one cron run',
    row: (userId) => keepAliveRow({ userId }),
    fetch: () =>
      tokenEndpointFetch({
        status: 401,
        body: JSON.stringify({
          error: 'invalid_client',
          error_description: 'client authentication failed',
        }),
      }),
    expect: { status: null, error: null, token: 'stored', storedRefresh: 'original' },
  },
  {
    name: 'no rotation in response',
    why: 'a response that restates no refresh_token means the one we hold is still live; passing undefined would NULL the column',
    row: (userId) => keepAliveRow({ userId }),
    fetch: () => tokenEndpointFetch({ status: 200, body: grantBody(null) }),
    expect: { status: null, error: null, token: 'redeemed', storedRefresh: 'original' },
  },
  {
    name: 'dead access token, live refresh',
    why: 'the case REF-100 exists for: the access token lapsed, so renewal is impossible, and the refresh grant recovers the connection with no reconnect',
    row: (userId) => keepAliveRow({ userId, accessExpiresInMs: -60_000 }),
    fetch: () => tokenEndpointFetch({ status: 200, body: grantBody() }),
    expect: { status: null, error: null, token: 'redeemed', storedRefresh: 'rotated' },
  },
  {
    name: 'dead access token, 5xx on refresh',
    why: 'must NOT write expired: the refresh token is still in date, so the connection is recoverable and a transient failure is not a verdict to record',
    row: (userId) => keepAliveRow({ userId, accessExpiresInMs: -60_000 }),
    fetch: () => tokenEndpointFetch({ status: 503, body: 'Service Unavailable' }),
    expect: { status: null, error: 'transient', token: null, storedRefresh: 'original' },
  },
  // The fourth cell of {access live, dead} × {refresh inside, outside 12h}.
  // The other three were covered and this one was production: ACCESS_EXPIRES_IN_60_MIN
  // keeps the margin case above honest about what triggered a redemption, and
  // that same isolation is what kept the pair below from ever being combined.
  {
    name: 'dead access token, refresh 20h out',
    why: 'the 14.10 regression: renewal is impossible with a lapsed access token, so the refresh grant is the ONLY recovery and the 12h margin must not gate it — a successful cron run keeps every refresh token outside that margin all day',
    row: (userId) =>
      keepAliveRow({
        userId,
        accessExpiresInMs: -60_000,
        refreshExpiresInMs: REFRESH_EXPIRES_IN_20_H,
      }),
    fetch: () => tokenEndpointFetch({ status: 200, body: grantBody() }),
    expect: { status: null, error: null, token: 'redeemed', storedRefresh: 'rotated' },
  },
  {
    name: 'dead access token, refresh 20h out, 5xx',
    why: 'the forced path must keep REF-101\'s rule: a 5xx is no verdict on the token, so nothing is written and the caller gets Transient — the same guard the inside-the-margin 5xx case gives, now for the forced one',
    row: (userId) =>
      keepAliveRow({
        userId,
        accessExpiresInMs: -60_000,
        refreshExpiresInMs: REFRESH_EXPIRES_IN_20_H,
      }),
    fetch: () => tokenEndpointFetch({ status: 503, body: 'Service Unavailable' }),
    expect: { status: null, error: 'transient', token: null, storedRefresh: 'original' },
  },
  {
    name: 'dead access token, dead refresh',
    why: 'nothing left to recover with, so this is the one state that legitimately marks the row expired',
    row: (userId) =>
      keepAliveRow({ userId, accessExpiresInMs: -60_000, refreshExpiresInMs: -60_000 }),
    fetch: () => noCallsExpected,
    expect: { status: 'expired', error: 'not-connected', token: null, storedRefresh: 'original' },
  },
];

/**
 * Drive one keep-alive case through getUserAccessToken().
 *
 * Through the real entry point rather than redeemRefreshToken() directly,
 * because "a refresh token inside 12 hours triggers a redemption on the ordinary
 * request path" is itself one of the things being tested.
 */
async function observeKeepAlive(
  testCase: KeepAliveCase
): Promise<{ actual: KeepAliveExpectation; note: string }> {
  const userId = `user-${Math.random().toString(36).slice(2, 10)}`;
  const writes = noWrites();
  const store = singleRowStore(testCase.row(userId));

  clearAllCachedTokens();
  const realFetch = globalThis.fetch;
  globalThis.fetch = testCase.fetch(store, userId);

  let error: 'not-connected' | 'transient' | null = null;
  let token: KeepAliveExpectation['token'] = null;
  let note = '';

  try {
    const snapshot = await getUserAccessToken(userId, { admin: storeAdmin(store, writes) });
    token =
      snapshot.accessToken === STORED_TOKEN
        ? 'stored'
        : snapshot.accessToken === REDEEMED_TOKEN
          ? 'redeemed'
          : snapshot.accessToken === WINNER_ACCESS
            ? 'winner'
            : null;
    if (token === null) note = 'returned an unrecognised token';
  } catch (thrown: unknown) {
    if (thrown instanceof TradovateNotConnectedError) {
      error = 'not-connected';
      note = `TradovateNotConnectedError(${thrown.status})`;
    } else if (TransientError && thrown instanceof TransientError) {
      error = 'transient';
      note = `TradovateTransientError(${thrown.reason})`;
    } else {
      error = null;
      note = `unexpected ${thrown instanceof Error ? thrown.name : typeof thrown}`;
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  // Read the row back and decrypt it — the assertion that matters for a
  // rotating credential is what is now STORED, not what was returned.
  const row = store.get(userId);
  let storedRefresh: KeepAliveExpectation['storedRefresh'] = null;
  if (row?.refresh_token_encrypted) {
    const plaintext = decryptToken(String(row.refresh_token_encrypted), 'refresh', userId);
    storedRefresh =
      plaintext === ORIGINAL_REFRESH
        ? 'original'
        : plaintext === ROTATED_REFRESH
          ? 'rotated'
          : plaintext === WINNER_REFRESH
            ? 'winner'
            : null;
    if (storedRefresh === null) note = note ? `${note}, unknown stored refresh` : 'unknown stored refresh';
  }

  const status = writes.statusUpdates.length ? writes.statusUpdates.join('+') : null;
  const swaps: string[] = [];
  if (writes.casApplied) swaps.push(`cas:applied×${writes.casApplied}`);
  if (writes.casRejected) swaps.push(`cas:rejected×${writes.casRejected}`);
  if (writes.upserts) swaps.push(`upsert×${writes.upserts}`);
  if (swaps.length) note = note ? `${note}, ${swaps.join(', ')}` : swaps.join(', ');

  return { actual: { status, error, token, storedRefresh }, note };
}

function describeKeepAlive(e: KeepAliveExpectation): string {
  const status = e.status ? `status=${e.status}` : 'no DB write';
  const error =
    e.error === 'not-connected' ? 'NotConnected' : e.error === 'transient' ? 'Transient' : 'no throw';
  const token = e.token ? `${e.token} token` : 'no token';
  const stored = e.storedRefresh ? `refresh=${e.storedRefresh}` : 'refresh=none';
  return `${status.padEnd(14)} ${error.padEnd(13)} ${token.padEnd(14)} ${stored}`;
}

// ════════════════════════════════════════════════════════════════════════════
// PART 2b — REF-100: the rotation race itself
//
// The three cases that pin the race fix. They are separate from the table above
// because each needs its own orchestration rather than one stubbed response,
// and because what they assert is not "which token came back" but "what was
// written, and what was REFUSED".
// ════════════════════════════════════════════════════════════════════════════

/**
 * TEST 1 — a successful save HEALS a row that a racing loser marked expired.
 *
 * Pins the deliberate absence of a `status` predicate on the save's
 * compare-and-swap. Driven through saveConnection() directly rather than
 * getUserAccessToken(), because the status gate in loadOrRenew() refuses an
 * expired row before any of this is reached — which is itself the reason the
 * healing has to happen inside the save.
 *
 * Fails the moment someone "tightens" the save with .eq('status','active').
 */
async function observeCasHealsExpiredRow(): Promise<{
  actual: string;
  expected: string;
  note: string;
}> {
  const userId = 'bbbb2222-0000-4000-8000-000000000001';
  const row = keepAliveRow({ userId });
  // A racing loser's expired write already landed.
  row.status = 'expired';
  const c0 = String(row.refresh_token_encrypted);

  const store = singleRowStore(row);
  const writes = noWrites();

  const saved = await saveConnection({
    userId,
    accessToken: REDEEMED_TOKEN,
    expiresAt: Date.now() + ACCESS_LIFETIME_SEC * 1000,
    refreshToken: ROTATED_REFRESH,
    refreshExpiresAt: Date.now() + REFRESH_LIFETIME_SEC * 1000,
    tradovateUserId: 12345,
    environment: 'demo',
    tokenType: 'Bearer',
    expectRefreshTokenCiphertext: c0,
    admin: storeAdmin(store, writes),
  });

  const after = store.get(userId);
  return {
    actual: `applied=${saved.applied} status=${String(after?.status)}`,
    expected: 'applied=true status=active',
    note: `cas:applied×${writes.casApplied}`,
  };
}

/**
 * TEST 2 — the expired write is REFUSED when the row moved under it.
 *
 * The interleaving that cost a live connection permanently:
 *
 *   B: grant → invalid_grant (B presented the refresh token A had just spent)
 *   B: reconcile() reads     → still C0, because A's save has not landed
 *   A: full real redemption  → commits C1, status='active', A is finished
 *   B: expired write         → must match NOTHING
 *
 * A is a REAL redemption — redeemRefreshToken() with its own stubbed endpoint —
 * not a hand-written row mutation, so both code paths are the shipped ones. It
 * is injected through the race window, so the ordering is exact rather than
 * lucky.
 *
 * Before the fix: B's markStatus() was unconditional on user_id, so it wrote
 * status='expired' over A's healthy row and nothing ever healed it.
 */
async function observeExpiredWriteRefused(): Promise<{
  actual: string;
  expected: string;
  note: string;
}> {
  const userId = 'bbbb2222-0000-4000-8000-000000000002';
  const row = keepAliveRow({ userId });
  const store = singleRowStore(row);
  const writes = noWrites();

  // The row exactly as B read it, which is also what A read — both start from
  // the same ciphertext, which is what makes this a race rather than a sequence.
  const asBothRead = { ...row } as unknown as StoredConnection;

  const race: RaceWindow = { armed: false, run: () => {} };
  const winnerWrites = noWrites();

  race.run = async () => {
    // A's grant succeeds and returns its own rotated token.
    const duringRace = globalThis.fetch;
    globalThis.fetch = tokenEndpointFetch({
      status: 200,
      body: grantBody(WINNER_REFRESH, WINNER_ACCESS),
    });
    try {
      await redeemRefreshToken({
        connection: asBothRead,
        config: FAKE_CONFIG,
        admin: storeAdmin(store, winnerWrites),
      });
    } finally {
      globalThis.fetch = duringRace;
    }
  };

  const realFetch = globalThis.fetch;
  // B's grant is refused, and responding arms the window so that A lands on
  // B's next select — which is reconcile().
  globalThis.fetch = tokenEndpointFetch({
    status: 400,
    body: INVALID_GRANT_BODY,
    beforeRespond: () => {
      race.armed = true;
    },
  });

  clearAllCachedTokens();
  let outcome: string;
  try {
    const result = await redeemRefreshToken({
      connection: asBothRead,
      config: FAKE_CONFIG,
      admin: storeAdmin(store, writes, race),
    });
    outcome = result.outcome;
  } catch (thrown: unknown) {
    outcome = `threw ${thrown instanceof Error ? thrown.name : typeof thrown}`;
  } finally {
    globalThis.fetch = realFetch;
  }

  const after = store.get(userId);
  const storedRefresh =
    after?.refresh_token_encrypted &&
    decryptToken(String(after.refresh_token_encrypted), 'refresh', userId) === WINNER_REFRESH
      ? 'winner'
      : 'other';

  return {
    actual:
      `outcome=${outcome} statusWrites=${writes.statusUpdates.length} ` +
      `refused=${writes.statusWritesRefused} row=${String(after?.status)} refresh=${storedRefresh}`,
    expected: 'outcome=superseded statusWrites=0 refused=1 row=active refresh=winner',
    note: `winner cas:applied×${winnerWrites.casApplied}`,
  };
}

/**
 * TEST 5 — the cron must not report a death that did not happen.
 *
 * Two connections: one healthy, one whose grant is refused while its row moves
 * underneath. The counts must say refreshed=1 superseded=1 expired=0 — a run
 * that claimed expired=1 would be reporting a live connection as dead, which is
 * the observability half of the same bug.
 *
 * The competing write here is a direct row mutation rather than a second real
 * redemption: TEST 2 already covers the real-code-path version, and keeping
 * this one simple keeps the assertion about the COUNTS.
 */
async function observeCronNoFalseDeath(): Promise<{
  actual: string;
  expected: string;
  note: string;
}> {
  const healthy = 'cccc3333-0000-4000-8000-000000000001';
  const racing = 'cccc3333-0000-4000-8000-000000000002';

  const refreshTokens: Record<string, string> = {
    [healthy]: 'refresh-for-healthy',
    [racing]: 'refresh-for-racing',
  };

  const store = new Map<string, Row>();
  for (const userId of [healthy, racing]) {
    store.set(userId, keepAliveRow({ userId, refreshToken: refreshTokens[userId] }));
  }

  const writes = noWrites();
  const race: RaceWindow = {
    armed: false,
    run: () => {
      // The winner commits: a new refresh token and a fresh access token.
      const row = store.get(racing)!;
      row.refresh_token_encrypted = encryptToken(WINNER_REFRESH, 'refresh', racing);
      row.access_token_encrypted = encryptToken(WINNER_ACCESS, 'access', racing);
      row.expires_at = new Date(Date.now() + ACCESS_LIFETIME_SEC * 1000).toISOString();
      row.refresh_expires_at = new Date(Date.now() + REFRESH_LIFETIME_SEC * 1000).toISOString();
      row.status = 'active';
    },
  };

  const previousAllowlist = process.env.TRADOVATE_OAUTH_ALLOWED_USER_IDS;
  process.env.TRADOVATE_OAUTH_ALLOWED_USER_IDS = [healthy, racing].join(',');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const href = String(url);
    if (!href.includes('/auth/oauthtoken')) throw new Error(`unexpected call to ${href}`);
    const sent = new URLSearchParams(
      String((init as { body?: unknown } | undefined)?.body ?? '')
    ).get('refresh_token');

    if (sent === refreshTokens[healthy]) {
      return { ok: true, status: 200, text: async () => grantBody() };
    }
    // The racing one: refused, and responding arms the winner's commit for the
    // reconcile read that follows.
    race.armed = true;
    return { ok: false, status: 400, text: async () => INVALID_GRANT_BODY };
  }) as unknown as typeof fetch;

  clearAllCachedTokens();
  let actual: string;
  try {
    const counts = await runKeepAlive({
      admin: storeAdmin(store, writes, race),
      config: FAKE_CONFIG,
    });
    actual =
      `checked=${counts.checked} refreshed=${counts.refreshed} ` +
      `superseded=${counts.superseded} transient=${counts.transient} ` +
      `expired=${counts.expired} statusWrites=${writes.statusUpdates.length}`;
  } catch (thrown: unknown) {
    actual = `threw ${thrown instanceof Error ? thrown.message : String(thrown)}`;
  } finally {
    globalThis.fetch = realFetch;
    if (previousAllowlist === undefined) delete process.env.TRADOVATE_OAUTH_ALLOWED_USER_IDS;
    else process.env.TRADOVATE_OAUTH_ALLOWED_USER_IDS = previousAllowlist;
  }

  return {
    actual,
    expected: 'checked=2 refreshed=1 superseded=1 transient=0 expired=0 statusWrites=0',
    note: `expired writes refused: ${writes.statusWritesRefused}`,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PART 3 — REF-100: the cron
// ════════════════════════════════════════════════════════════════════════════

/** Generated per run, never printed. Not a real secret and never reaches a log. */
const TEST_CRON_SECRET = randomBytes(24).toString('base64url');

const KEEPALIVE_URL = 'https://example.invalid/api/cron/tradovate-keepalive';

/**
 * The route's authorization gate.
 *
 * Only the refusals are driven through the route itself: the authorized path
 * calls createAdminClient(), which needs real Supabase credentials this script
 * must not have. The work behind the gate is tested through runKeepAlive()
 * below, which is why that function is separate from the route in the first
 * place.
 */
async function observeCronAuth(headers: Record<string, string>): Promise<string> {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  try {
    const response = await keepAliveRoute(new Request(KEEPALIVE_URL, { headers }));
    const body = await response.text();
    return `${response.status}${body === '' ? ' empty' : ' with-body'}`;
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
}

/** The same gate with CRON_SECRET unset: must fail closed, not skip the check. */
async function observeCronUnconfigured(): Promise<string> {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const response = await keepAliveRoute(
      new Request(KEEPALIVE_URL, { headers: { authorization: 'Bearer anything' } })
    );
    const body = await response.text();
    return `${response.status}${body === '' ? ' empty' : ' with-body'}`;
  } finally {
    if (previous !== undefined) process.env.CRON_SECRET = previous;
  }
}

/**
 * One run of the loop over five connections, four of which are problems.
 *
 * The point is the counts AND the ordering: the refusal and the 5xx come before
 * the connection that redeems cleanly, so a loop that abandoned the rest after a
 * failure would report refreshed=0 and fail this case.
 */
async function observeCronCounts(): Promise<{ actual: string; expected: string; note: string }> {
  const ids = {
    rejected: 'aaaa1111-0000-4000-8000-000000000001',
    transient: 'aaaa1111-0000-4000-8000-000000000002',
    refreshed: 'aaaa1111-0000-4000-8000-000000000003',
    notAllowed: 'aaaa1111-0000-4000-8000-000000000004',
    wrongEnv: 'aaaa1111-0000-4000-8000-000000000005',
  };

  // A distinct refresh token per connection, so the stubbed endpoint can answer
  // each one differently by reading the grant it was sent.
  const refreshTokens: Record<string, string> = {
    [ids.rejected]: 'refresh-for-rejected',
    [ids.transient]: 'refresh-for-transient',
    [ids.refreshed]: 'refresh-for-refreshed',
    [ids.notAllowed]: 'refresh-for-not-allowed',
    [ids.wrongEnv]: 'refresh-for-wrong-env',
  };

  const store = new Map<string, Row>();
  // Insertion order is the order listConnectionsDueForRefresh returns them in
  // (all five share an expiry), so the two failures really do precede the
  // success.
  for (const [key, userId] of Object.entries(ids)) {
    store.set(
      userId,
      keepAliveRow({
        userId,
        refreshToken: refreshTokens[userId],
        environment: key === 'wrongEnv' ? 'live' : 'demo',
      })
    );
  }

  const writes = noWrites();
  const previousAllowlist = process.env.TRADOVATE_OAUTH_ALLOWED_USER_IDS;
  // Everyone but `notAllowed`, and the list has to be NON-EMPTY for this
  // fixture to mean anything now (REF-112-C item 1). The variable used to fail
  // closed, so an empty value skipped all five and the mere presence of a skip
  // proved the loop read it; after the inversion an empty value ALLOWS all
  // five, so a deliberate restriction is the whole of what is exercised here.
  process.env.TRADOVATE_OAUTH_ALLOWED_USER_IDS = [
    ids.rejected,
    ids.transient,
    ids.refreshed,
    ids.wrongEnv,
  ].join(',');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const href = String(url);
    if (!href.includes('/auth/oauthtoken')) {
      throw new Error(`unexpected call to ${href}`);
    }
    const body = String((init as { body?: unknown } | undefined)?.body ?? '');
    const sent = new URLSearchParams(body).get('refresh_token');

    if (sent === refreshTokens[ids.rejected]) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'revoked' }),
      };
    }
    if (sent === refreshTokens[ids.transient]) {
      return { ok: false, status: 503, text: async () => 'Service Unavailable' };
    }
    if (sent === refreshTokens[ids.refreshed]) {
      return { ok: true, status: 200, text: async () => grantBody() };
    }
    // Neither the skipped user nor the wrong-environment one may reach here.
    throw new Error(`a connection that should have been skipped sent a grant`);
  }) as unknown as typeof fetch;

  clearAllCachedTokens();
  let note = '';
  let actual = '';
  try {
    const counts = await runKeepAlive({ admin: storeAdmin(store, writes), config: FAKE_CONFIG });
    actual =
      `checked=${counts.checked} refreshed=${counts.refreshed} ` +
      `superseded=${counts.superseded} transient=${counts.transient} ` +
      `expired=${counts.expired} skipped=${counts.skipped} ` +
      // REF-112 §5.4. SPLIT OUT OF `skipped`, and the split IS the assertion:
      // this fixture holds one allowlist miss and one wrong-environment
      // connection, and at `skipped=2` they were indistinguishable. The second
      // one is a connection that will expire and can never refresh its way
      // back — at a cutover it is every pre-existing connection at once.
      `stranded=${counts.strandedByEnvironment}`;
    note = `statuses=[${writes.statusUpdates.join(',') || 'none'}] cas:applied×${writes.casApplied}`;
  } catch (thrown: unknown) {
    actual = `threw ${thrown instanceof Error ? thrown.message : String(thrown)}`;
  } finally {
    globalThis.fetch = realFetch;
    if (previousAllowlist === undefined) delete process.env.TRADOVATE_OAUTH_ALLOWED_USER_IDS;
    else process.env.TRADOVATE_OAUTH_ALLOWED_USER_IDS = previousAllowlist;
  }

  return {
    actual,
    expected:
      'checked=3 refreshed=1 superseded=0 transient=1 expired=1 skipped=1 stranded=1',
    note,
  };
}

async function main(): Promise<number> {
  let failures = 0;
  let total = 0;
  const notes: string[] = [];

  // ── Part 1 ────────────────────────────────────────────────────────────────
  console.log('REF-101 — renewal failure classification\n');
  console.log('  Each case drives getUserAccessToken() with a stubbed Supabase client');
  console.log('  and a stubbed fetch. Nothing reaches Supabase or Tradovate.\n');
  console.log(`  ${'case'.padEnd(36)} ${'expected'.padEnd(42)} actual`);
  console.log(`  ${'-'.repeat(36)} ${'-'.repeat(42)} ${'-'.repeat(42)}`);

  for (const testCase of cases) {
    const { actual, note } = await observe(testCase);
    const ok =
      actual.status === testCase.expect.status &&
      actual.error === testCase.expect.error &&
      actual.token === testCase.expect.token;

    total += 1;
    if (!ok) failures += 1;
    console.log(
      `  ${(ok ? 'PASS ' : 'FAIL ') + testCase.name.padEnd(31)} ${describe(testCase.expect).padEnd(42)} ${describe(actual)}`
    );
    notes.push(`    ${testCase.name} — ${testCase.why}${note ? ` [${note}]` : ''}`);
  }

  // ── Part 2 ────────────────────────────────────────────────────────────────
  console.log('\n\nREF-100 — refresh-token keep-alive\n');
  console.log('  Same harness, driving the refresh grant. The last column is what the ROW');
  console.log('  holds afterwards: with a rotating credential, what was stored matters more');
  console.log('  than what was returned.\n');
  console.log(`  ${'case'.padEnd(36)} ${'expected'.padEnd(58)} actual`);
  console.log(`  ${'-'.repeat(36)} ${'-'.repeat(58)} ${'-'.repeat(58)}`);

  for (const testCase of keepAliveCases) {
    const { actual, note } = await observeKeepAlive(testCase);
    const ok =
      actual.status === testCase.expect.status &&
      actual.error === testCase.expect.error &&
      actual.token === testCase.expect.token &&
      actual.storedRefresh === testCase.expect.storedRefresh;

    total += 1;
    if (!ok) failures += 1;
    console.log(
      `  ${(ok ? 'PASS ' : 'FAIL ') + testCase.name.padEnd(31)} ` +
        `${describeKeepAlive(testCase.expect).padEnd(58)} ${describeKeepAlive(actual)}`
    );
    notes.push(`    ${testCase.name} — ${testCase.why}${note ? ` [${note}]` : ''}`);
  }

  // ── Part 2b ───────────────────────────────────────────────────────────────
  console.log('\n\nREF-100 — the rotation race\n');
  console.log('  Each case lands a competing write at an exact point through a one-shot race');
  console.log('  window. No sleeps and no Promise.all: the ordering is constructed, not hoped\n');
  console.log('  for. What is asserted is what was WRITTEN and what was REFUSED.\n');
  console.log(`  ${'case'.padEnd(36)} ${'expected'.padEnd(66)} actual`);
  console.log(`  ${'-'.repeat(36)} ${'-'.repeat(66)} ${'-'.repeat(66)}`);

  const raceCases: Array<{
    name: string;
    why: string;
    run: () => Promise<{ actual: string; expected: string; note: string }>;
  }> = [
    {
      name: 'save heals an expired row',
      why: "the save's CAS deliberately has NO status predicate — that is what revives a row a racing loser marked expired",
      run: observeCasHealsExpiredRow,
    },
    {
      name: 'expired write refused (row moved)',
      why: 'the fix: a real competing redemption commits between reconcile() and the verdict, so the expired write must match nothing',
      run: observeExpiredWriteRefused,
    },
    {
      name: 'cron reports no false death',
      why: 'a connection that merely lost the race must count as superseded, never as expired',
      run: observeCronNoFalseDeath,
    },
  ];

  for (const raceCase of raceCases) {
    const { actual, expected, note } = await raceCase.run();
    const ok = actual === expected;
    total += 1;
    if (!ok) failures += 1;
    console.log(
      `  ${(ok ? 'PASS ' : 'FAIL ') + raceCase.name.padEnd(31)} ${expected.padEnd(66)} ${actual}`
    );
    notes.push(`    ${raceCase.name} — ${raceCase.why}${note ? ` [${note}]` : ''}`);
  }

  // ── Part 3 ────────────────────────────────────────────────────────────────
  console.log('\n\nREF-100 — the cron\n');
  console.log(`  ${'case'.padEnd(36)} ${'expected'.padEnd(58)} actual`);
  console.log(`  ${'-'.repeat(36)} ${'-'.repeat(58)} ${'-'.repeat(58)}`);

  const authCases: Array<{ name: string; why: string; run: () => Promise<string>; expect: string }> = [
    {
      name: 'no Authorization header',
      why: 'an unauthenticated caller must get 401 and an EMPTY body — it should not learn it found a cron endpoint',
      run: () => observeCronAuth({}),
      expect: '401 empty',
    },
    {
      name: 'wrong bearer token',
      why: 'the comparison is on the whole header value, so a plausible guess fails the same way',
      run: () => observeCronAuth({ authorization: 'Bearer not-the-secret' }),
      expect: '401 empty',
    },
    {
      name: 'CRON_SECRET unset',
      why: 'fail closed: an unset or renamed variable must reject, not wave the request through on a vacuous comparison',
      run: () => observeCronUnconfigured(),
      expect: '401 empty',
    },
  ];

  for (const authCase of authCases) {
    const actual = await authCase.run();
    const ok = actual === authCase.expect;
    total += 1;
    if (!ok) failures += 1;
    console.log(
      `  ${(ok ? 'PASS ' : 'FAIL ') + authCase.name.padEnd(31)} ${authCase.expect.padEnd(58)} ${actual}`
    );
    notes.push(`    ${authCase.name} — ${authCase.why}`);
  }

  const counts = await observeCronCounts();
  const countsOk = counts.actual === counts.expected;
  total += 1;
  if (!countsOk) failures += 1;
  console.log(
    `  ${(countsOk ? 'PASS ' : 'FAIL ') + 'counts over five connections'.padEnd(31)} ` +
      `${counts.expected.padEnd(58)} ${counts.actual}`
  );
  notes.push(
    '    counts over five connections — a refusal and a 5xx come BEFORE the healthy ' +
      `connection, so a loop that stopped on failure would report refreshed=0${counts.note ? ` [${counts.note}]` : ''}`
  );

  // ── Why ───────────────────────────────────────────────────────────────────
  console.log('\n  Why each case is classified the way it is:\n');
  for (const line of notes) console.log(line);

  if (failures) {
    console.log(`\n  ${failures} of ${total} cases FAILED.`);
    console.log('  A transient failure that writes status=expired is REF-101: the row is');
    console.log('  refused by the status gate on every later call, so the connection is');
    console.log('  dead until the user reconnects.');
    console.log('  A lost rotation race that writes anything is REF-100: the refresh token');
    console.log('  rotates, so the loser would store a token Tradovate has already spent.');
    return EXIT_FAILED;
  }

  console.log(`\n  All ${total} cases passed.`);
  console.log('  Only 401, 403, a stated refusal and invalid_grant/access_denied mark a');
  console.log('  connection expired. A lost rotation race adopts the winner\'s tokens and');
  console.log('  writes nothing.');
  return EXIT_OK;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\n  HARNESS ERROR — ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(EXIT_FAILED);
  });

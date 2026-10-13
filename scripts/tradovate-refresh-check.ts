/**
 * REF-101 — what a failed token renewal is allowed to do to a connection.
 *
 *   npm run tradovate:refresh-check
 *
 * The bug: the catch around renewAccessToken() in src/lib/tradovate/connections.ts
 * caught every exception alike, wrote status='expired' and threw
 * TradovateNotConnectedError. A rate limit, a timeout, a 5xx or an unreadable
 * body — all transient — turned a working connection into a permanently dead
 * row, because the status gate earlier in the same function then refuses that
 * row immediately on every later call. The renewal endpoint's 15-per-hour limit
 * is counted per IP address, and Vercel lambdas share egress addresses, so the
 * traffic that triggers this need not even be ours (REF-90 §2.4).
 *
 * This drives the real getUserAccessToken() for each failure mode and checks the
 * three things that matter per case:
 *
 *   1. was a status written to the database, and which,
 *   2. which error came out, if any,
 *   3. was the still-valid stored token handed back instead.
 *
 * Run it against the pre-fix code (git stash) and the transient rows fail.
 *
 *
 * NO DATABASE, NO NETWORK, NO CREDENTIALS
 * ---------------------------------------
 *
 * There is no unit-test harness in this repo (REF-90 §8.1), so this is a script
 * in the style of the other scripts/tradovate-*.ts, and it is self-contained:
 *
 * - The Supabase client is a stub, passed in through the `admin` option that
 *   getUserAccessToken() already accepts. It records writes instead of making
 *   them. Nothing reaches Supabase, which is also the rule in CLAUDE.md.
 * - globalThis.fetch is replaced per case. Nothing reaches Tradovate.
 * - TRADOVATE_TOKEN_ENCRYPTION_KEY is generated here, in memory, for this
 *   process only. The real key is neither read nor needed; the tokens it
 *   protects are the fake ones below. No secret is printed, and the fake tokens
 *   are never printed either — this output gets pasted into chats.
 */

import { randomBytes } from 'node:crypto';

import { clearAllCachedTokens, getUserAccessToken } from '../src/lib/tradovate/connections';
import * as tradovateErrors from '../src/lib/tradovate/errors';
import { TradovateNotConnectedError } from '../src/lib/tradovate/errors';
import { encryptToken } from '../src/lib/tradovate/token-crypto';

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
  statusUpdates: string[];
  upserts: number;
}

/**
 * The slice of the Supabase client this path touches, and nothing else.
 *
 * Shapes matter: loadOrRenew() does `.select().eq().maybeSingle()`, markStatus()
 * does `.update().eq()` and awaits it, saveConnection() awaits `.upsert()`. So
 * the object returned by `.eq()` has to be both awaitable and carry
 * maybeSingle().
 */
function stubAdmin(row: Record<string, unknown>, writes: Writes) {
  const result = { data: null, error: null };

  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: row, error: null }),
              };
            },
          };
        },
        update(values: Record<string, unknown>) {
          return {
            eq: () => {
              writes.statusUpdates.push(String(values.status));
              return Promise.resolve(result);
            },
          };
        },
        upsert: async () => {
          writes.upserts += 1;
          return result;
        },
      };
    },
    // Cast at the boundary: the stub implements the four calls this code path
    // makes, not the SupabaseClient interface, and widening it any other way
    // would mean importing the generated types for no gain in a script.
  } as never;
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
  const writes: Writes = { statusUpdates: [], upserts: 0 };
  const row = connectionRow(userId, testCase.expiresInMs ?? EXPIRES_IN_10_MIN);

  clearAllCachedTokens();
  const realFetch = globalThis.fetch;
  globalThis.fetch = testCase.fetch;

  let error: 'not-connected' | 'transient' | null = null;
  let token: 'stored' | 'renewed' | null = null;
  let note = '';

  try {
    const snapshot = await getUserAccessToken(userId, { admin: stubAdmin(row, writes) });
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

async function main(): Promise<number> {
  console.log('REF-101 — renewal failure classification\n');
  console.log('  Each case drives getUserAccessToken() with a stubbed Supabase client');
  console.log('  and a stubbed fetch. Nothing reaches Supabase or Tradovate.\n');
  console.log(`  ${'case'.padEnd(36)} ${'expected'.padEnd(42)} actual`);
  console.log(`  ${'-'.repeat(36)} ${'-'.repeat(42)} ${'-'.repeat(42)}`);

  let failures = 0;
  const notes: string[] = [];

  for (const testCase of cases) {
    const { actual, note } = await observe(testCase);
    const ok =
      actual.status === testCase.expect.status &&
      actual.error === testCase.expect.error &&
      actual.token === testCase.expect.token;

    if (!ok) failures += 1;
    console.log(
      `  ${(ok ? 'PASS ' : 'FAIL ') + testCase.name.padEnd(31)} ${describe(testCase.expect).padEnd(42)} ${describe(actual)}`
    );
    notes.push(`    ${testCase.name} — ${testCase.why}${note ? ` [${note}]` : ''}`);
  }

  console.log('\n  Why each case is classified the way it is:\n');
  for (const line of notes) console.log(line);

  if (failures) {
    console.log(`\n  ${failures} of ${cases.length} cases FAILED.`);
    console.log('  A transient failure that writes status=expired is REF-101: the row is');
    console.log('  refused by the status gate on every later call, so the connection is');
    console.log('  dead until the user reconnects.');
    return EXIT_FAILED;
  }

  console.log(`\n  All ${cases.length} cases passed.`);
  console.log('  Only 401, 403 and a stated refusal mark the connection expired.');
  return EXIT_OK;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`\n  HARNESS ERROR — ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(EXIT_FAILED);
  });

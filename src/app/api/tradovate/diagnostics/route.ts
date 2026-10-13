/**
 * ╔════════════════════════════════════════════════════════════════════════════╗
 * ║  TEMPORARY — REF-100 measurement. Delete after use.      13 October 2026   ║
 * ╚════════════════════════════════════════════════════════════════════════════╝
 *
 * This file is not product code and nothing may come to depend on it. It exists
 * to answer two questions that block REF-100 and cannot be answered from the
 * documentation, and it has to run from a Vercel production function because
 * one of the two limits in dispute is counted PER EGRESS IP — a measurement
 * taken from a laptop says nothing about the address Vercel's lambdas leave by.
 *
 *   (a) GET /auth/renewaccesstoken — 15 per hour per IP (partner.tradovate.com)
 *       or 5,000 per hour per user (NinjaTrader API Support, in writing, 24–25
 *       Sep)? The two sources disagree and REF-90 §2.4 shows the hourly cron
 *       REF-100 describes is unbuildable if the per-IP number is the real one.
 *       ?action=rate renews up to 20 times in a row and stops at the first
 *       refusal. If call 16 is refused, 15/hour/IP is real; if 20 pass, it is
 *       not.
 *
 *   (b) POST /auth/oauthtoken with grant_type=refresh_token — does it work, is
 *       a new refresh token issued (rotation), and is the PREVIOUS access token
 *       still valid afterwards? That last one is the question that matters:
 *       REF-90 §2.6 notes that nothing documents whether redeeming a refresh
 *       token opens a NEW session, and a new session counts against the
 *       two-concurrent-session cap — which would evict the user's own trading
 *       terminal mid-trade. If the old access token still answers GET /auth/me,
 *       the old session survived. ?action=refresh measures exactly that.
 *
 * Now is the cheapest moment to measure: there are no users but the owner and
 * Imri. After launch this measurement cannot be taken at all.
 *
 *
 * WHY THIS IS SAFE TO HAVE IN THE TREE, AND STILL MUST BE DELETED
 * --------------------------------------------------------------
 *
 * Three gates, in this order, and the first two answer 404 with an empty body
 * so that a prober cannot tell this path from one that was never deployed:
 *
 *   1. TRADOVATE_DIAGNOSTICS_ENABLED must be exactly '1'. Off by default, so
 *      merging this changes nothing anywhere until that variable is set.
 *   2. A signed-in Reflect user who passes isUserAllowed() — the same
 *      fail-closed allowlist the connect and callback routes use.
 *   3. ?action=refresh additionally demands confirm=not-in-trade, because that
 *      action may close a session the user has open in their trading platform.
 *
 * It must still be deleted, for two reasons beyond tidiness:
 *
 *   - It imports decryptToken from ./token-crypto, which lib/tradovate/index.ts
 *     deliberately does not export: "Encryption and decryption stay private to
 *     ./connections.ts, which is the only module that should hold a raw token
 *     alongside the key." Measurement (b) cannot be taken without the plaintext
 *     refresh token, and measurement (a) cannot save its result without it
 *     either (see carryForward below), so the boundary is crossed knowingly,
 *     once, in a file with a delete-by date. scripts/tradovate-refresh-check.ts
 *     reaches for encryptToken the same way.
 *   - It spends the renewal rate-limit budget on purpose. Leaving a route that
 *     burns 20 renewals per call reachable in production is a liability even
 *     behind an allowlist.
 *
 * THE ONE RESIDUAL RISK, STATED RATHER THAN HIDDEN
 * ------------------------------------------------
 *
 * ?action=rate saves the newest token ONCE, after the loop. Between a renewal
 * and that save, the stored access token is older than the one Tradovate last
 * issued. renewAccessToken() takes no AbortSignal and Node's fetch has no
 * default timeout, so a socket that hangs can in principle run past
 * maxDuration and the save never happens — {@link LOOP_BUDGET_MS} leaves 35
 * seconds of headroom for exactly that, and the loop checks the clock between
 * calls, but it cannot interrupt one call.
 *
 * Whether that loses the connection depends on something nobody has measured:
 * whether renewal invalidates the token it replaces. The documentation says
 * renewal "extends the current session without creating a new one", which
 * suggests the previous token lives out its own 80 minutes — and ?action=refresh
 * measures the equivalent question for the refresh grant. If that turns out to
 * be wrong, make the loop save after every success instead; it costs one upsert
 * per call and removes the window entirely.
 *
 * NO SECRET LEAVES THIS FILE. No token value, no client secret, no encryption
 * key appears in a response, in a log line, or in the report. Every upstream
 * string is passed through redactSecrets() first, and the fields that describe
 * a token describe only its shape: whether one was issued, whether it changed,
 * and how many seconds it lasts.
 */

import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { isAllowlistConfigured, isUserAllowed } from '@/lib/tradovate/allowlist';
import { readApiHosts, resolveTradingApiUrl } from '@/lib/tradovate/api-hosts';
import { renewAccessToken } from '@/lib/tradovate/auth';
import { tradovateGet } from '@/lib/tradovate/client';
import { describeConfigError } from '@/lib/tradovate/config';
import { getUserAccessToken, saveConnection } from '@/lib/tradovate/connections';
import {
  TradovateAuthError,
  TradovateNotConnectedError,
  TradovatePenaltyError,
  TradovateRequestError,
  TradovateTransientError,
} from '@/lib/tradovate/errors';
import type { TradovateEnvironment } from '@/lib/tradovate/hosts';
import { loadOAuthConfig, type TradovateOAuthConfig } from '@/lib/tradovate/oauth-config';
import { redactSecrets } from '@/lib/tradovate/redact';
import { decryptToken } from '@/lib/tradovate/token-crypto';
import {
  isPenaltyResponse,
  type OAuthTokenResponse,
  type TradovateApiHosts,
  type TradovateMeResponse,
} from '@/lib/tradovate/types';

// node:crypto in token-crypto.ts; not available on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The renewal loop makes up to 20 sequential upstream calls. The default
// 10-second budget would cut it off mid-loop, and a loop cut off before its
// final save is a loop that leaves the stored access token behind the one
// Tradovate last issued.
export const maxDuration = 60;

/** Exactly '1' enables the route. Anything else, including unset, is 404. */
const ENABLE_ENV_VAR = 'TRADOVATE_DIAGNOSTICS_ENABLED';

/**
 * How many renewals to attempt. 20 is the number REF-90 §2.4 asks for and it is
 * sufficient either way: a refusal on call 16 confirms 15/hour/IP, and 20 clean
 * calls refute it.
 */
const MAX_RENEWALS = 20;

/**
 * Stop renewing with this much of {@link maxDuration} left, so the final
 * saveConnection() always runs. Losing the connection is a worse outcome than a
 * short run — the owner would have to re-authorize before anything else in
 * REF-90 or REF-100 can be tested.
 */
const LOOP_BUDGET_MS = 25_000;

/** The literal ?confirm= value ?action=refresh demands. */
const REFRESH_CONFIRM = 'not-in-trade';

/** Where the egress IP is read from, so a reader knows it is not our claim. */
const IP_LOOKUP_URL = 'https://api.ipify.org?format=json';

/**
 * What ?action=rate cannot see, stated in the response so the measurement is
 * not read as saying more than it does.
 *
 * The loop deliberately goes through the shipped renewAccessToken() rather than
 * its own fetch — reimplementing the penalty detection would measure the copy
 * instead of the code — and that function surfaces only what its callers need.
 */
const RATE_BLIND_SPOTS = [
  'httpStatus is null on success: renewAccessToken() returns only on res.ok, so the ' +
    'exact 2xx is not surfaced. outcome "ok" means 2xx.',
  'p-ticket is not reported. readPenalty() in lib/tradovate/auth.ts reads it, but ' +
    'renewAccessToken() does not carry it onto TradovatePenaltyError. p-time is ' +
    'reported, as pTimeSeconds.',
  'A penalty arrives with an ordinary 2xx status and the payload replaced, so ' +
    'outcome "penalty" has no HTTP status to report either.',
  'Call 1 is preceded by getUserAccessToken(), which renews on its own if the ' +
    'stored token was inside the 15-minute margin. See priming.',
];

/** 404 with nothing in it. Used for both silent gates. */
function notFound(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

/** The columns this file reads. Token columns included — see the header. */
const DIAGNOSTIC_COLUMNS =
  'access_token_encrypted, refresh_token_encrypted, expires_at, refresh_expires_at, ' +
  'token_type, api_hosts, environment, tradovate_user_id, status';

interface DiagnosticRow {
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  expires_at: string;
  refresh_expires_at: string | null;
  token_type: string | null;
  api_hosts: TradovateApiHosts | null;
  environment: TradovateEnvironment;
  tradovate_user_id: number | null;
  status: string;
}

/**
 * Every argument saveConnection() needs other than the token and its expiry,
 * taken off the stored row.
 *
 * This exists because of the trap documented three times in connections.ts:
 * saveConnection() writes EVERY column on every save, so a caller that omits
 * refreshToken, refreshExpiresAt, tokenType or apiHosts does not leave the
 * stored value alone — it writes NULL over it. Both actions below spread this
 * object, so no field can be forgotten at a call site.
 *
 * Called BEFORE any upstream request, deliberately: decryptToken() throws if
 * the stored ciphertext or the key is wrong, and the moment to find that out is
 * before 20 renewals have been spent, not after, when the result would have
 * nowhere to be saved.
 */
function carryForward(row: DiagnosticRow, userId: string) {
  const refreshExpiresAt = row.refresh_expires_at ? Date.parse(row.refresh_expires_at) : Number.NaN;
  return {
    userId,
    tradovateUserId: row.tradovate_user_id,
    // From the row, never from configuration: the row records which environment
    // actually minted the token, and nothing here may relabel it.
    environment: row.environment,
    refreshToken: row.refresh_token_encrypted
      ? decryptToken(row.refresh_token_encrypted, 'refresh', userId)
      : undefined,
    refreshExpiresAt: Number.isFinite(refreshExpiresAt) ? refreshExpiresAt : undefined,
    tokenType: row.token_type ?? undefined,
    apiHosts: row.api_hosts ?? undefined,
  };
}

/** A redacted, length-capped rendering of anything thrown. Never a value. */
function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : 'non-Error throw';
  return redactSecrets(raw).slice(0, 300);
}

/**
 * The function's egress address, as a third party sees it.
 *
 * The whole per-IP question turns on this: if two runs report different
 * addresses, a 15-per-hour-per-IP budget is being spread over a pool and the
 * measurement below has to be read in that light.
 */
async function readEgressIp(): Promise<{ ip: string | null; error: string | null }> {
  try {
    const res = await fetch(IP_LOOKUP_URL, {
      cache: 'no-store',
      // A third-party lookup must not be able to spend the function's budget;
      // the measurement below is the point and this is context for it.
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json()) as { ip?: unknown };
    return { ip: typeof body.ip === 'string' ? body.ip : null, error: null };
  } catch (error) {
    return { ip: null, error: safeMessage(error) };
  }
}

// ── ?action=rate ────────────────────────────────────────────────────────────

interface RenewalAttempt {
  call: number;
  /**
   * 'ok' is a 2xx carrying a token. The rest are the four shapes
   * renewAccessToken() can fail in: a rate-limit penalty, a non-2xx, a 2xx
   * carrying errorText, and anything thrown by fetch itself.
   */
  outcome: 'ok' | 'penalty' | 'http' | 'errorText' | 'exception';
  /** Null unless a non-2xx was seen; see RATE_BLIND_SPOTS. */
  httpStatus: number | null;
  durationMs: number;
  penalty: boolean;
  /** `p-time`, in seconds, as Tradovate asked us to wait. */
  pTimeSeconds: number | null;
  captcha: boolean | null;
  /** Redacted. From the error's own message, never from a response body. */
  errorText: string | null;
  /** Which host the call went to, and whether it came from the stored apiHosts. */
  hostSource: 'stored' | 'fallback';
}

function describeFailure(
  call: number,
  durationMs: number,
  hostSource: 'stored' | 'fallback',
  error: unknown
): RenewalAttempt {
  const base = {
    call,
    durationMs,
    hostSource,
    httpStatus: null as number | null,
    penalty: false,
    pTimeSeconds: null as number | null,
    captcha: null as boolean | null,
    errorText: safeMessage(error),
  };

  if (error instanceof TradovatePenaltyError) {
    // The answer to question (a), when it comes. The limiter replied before
    // anything read the token.
    return {
      ...base,
      outcome: 'penalty',
      penalty: true,
      pTimeSeconds: error.retryAfterSeconds ?? null,
      captcha: error.captcha,
    };
  }
  if (error instanceof TradovateRequestError) {
    return { ...base, outcome: 'http', httpStatus: error.status };
  }
  if (error instanceof TradovateAuthError) {
    // Deliberately not classified as a refusal here. classifyRenewalFailure()
    // in connections.ts owns that judgement and is not exported; this reports
    // the string so the real strings can be read off a real response, which
    // REF-101 notes have never been measured.
    return { ...base, outcome: 'errorText', errorText: redactSecrets(error.errorText).slice(0, 300) };
  }
  return { ...base, outcome: 'exception' };
}

async function measureRenewalRate(params: {
  row: DiagnosticRow;
  carried: ReturnType<typeof carryForward>;
  startingToken: string;
  admin: SupabaseClient;
}) {
  const { row, carried, startingToken, admin } = params;

  const attempts: RenewalAttempt[] = [];
  let token = startingToken;
  let apiHosts: TradovateApiHosts | undefined = row.api_hosts ?? undefined;
  /** The newest token Tradovate issued, and the expiry it stated for it. */
  let latest: { accessToken: string; expirationTime: string } | null = null;
  let stoppedBecause: 'completed' | 'failure' | 'unparsable-expiry' | 'time-budget' = 'completed';

  const loopStarted = Date.now();

  for (let call = 1; call <= MAX_RENEWALS; call++) {
    if (Date.now() - loopStarted > LOOP_BUDGET_MS) {
      stoppedBecause = 'time-budget';
      break;
    }

    // Re-resolved every iteration: a successful renewal can restate apiHosts,
    // and the dynamic-hosts page says to replace what was stored when it does.
    const resolved = resolveTradingApiUrl({ environment: row.environment, apiHosts });
    const started = Date.now();

    try {
      const renewed = await renewAccessToken({ apiUrl: resolved.url }, token);
      const durationMs = Date.now() - started;

      // Same refusal as saveConnection's: a token whose expiry we cannot read
      // is a token we must not store. Stop rather than adopt it, and keep the
      // previous success as the one to save.
      if (!Number.isFinite(Date.parse(renewed.expirationTime))) {
        attempts.push({
          call,
          outcome: 'errorText',
          httpStatus: null,
          durationMs,
          penalty: false,
          pTimeSeconds: null,
          captcha: null,
          errorText: 'renewal succeeded but expirationTime was unparsable',
          hostSource: resolved.source,
        });
        stoppedBecause = 'unparsable-expiry';
        break;
      }

      // Each success feeds the next call, which is what makes this a measurement
      // of the renewal budget rather than 20 calls with one stale token.
      token = renewed.accessToken;
      latest = { accessToken: renewed.accessToken, expirationTime: renewed.expirationTime };
      apiHosts = readApiHosts(renewed) ?? apiHosts;

      attempts.push({
        call,
        outcome: 'ok',
        httpStatus: null,
        durationMs,
        penalty: false,
        pTimeSeconds: null,
        captcha: null,
        errorText: null,
        hostSource: resolved.source,
      });
    } catch (error) {
      attempts.push(describeFailure(call, Date.now() - started, resolved.source, error));
      stoppedBecause = 'failure';
      break;
    }
  }

  // The part that must not be skipped. Every field saveConnection() writes is
  // supplied: the token and its expiry from the last success, everything else
  // carried off the row. Omitting any one of them would null a column — see
  // carryForward.
  let save: { attempted: boolean; ok: boolean; error: string | null };
  if (latest) {
    try {
      await saveConnection({
        ...carried,
        accessToken: latest.accessToken,
        // The server's own expirationTime string, stored verbatim, exactly as
        // the renewal path in connections.ts does it.
        expiresAt: latest.expirationTime,
        apiHosts: apiHosts ?? carried.apiHosts,
        admin,
      });
      save = { attempted: true, ok: true, error: null };
    } catch (error) {
      save = { attempted: true, ok: false, error: safeMessage(error) };
      console.error(
        '[tradovate][diag] FAILED to save the renewed token; the stored access token is now ' +
          `older than the one Tradovate last issued: ${save.error}`
      );
    }
  } else {
    // Nothing was renewed, so nothing is stored. The row is untouched.
    save = { attempted: false, ok: false, error: null };
  }

  const successes = attempts.filter((attempt) => attempt.outcome === 'ok').length;

  return {
    attempts,
    successes,
    firstFailureAtCall: attempts.find((attempt) => attempt.outcome !== 'ok')?.call ?? null,
    stoppedBecause,
    /** The whole point: 15/hour/IP predicts a refusal on call 16. */
    verdict:
      successes >= MAX_RENEWALS
        ? `${MAX_RENEWALS} consecutive renewals succeeded — 15/hour/IP is not what this IP is subject to`
        : successes === 15
          ? 'stopped after exactly 15 — consistent with 15/hour/IP'
          : `stopped after ${successes} — read the attempt that failed before concluding anything`,
    save,
  };
}

// ── ?action=refresh ─────────────────────────────────────────────────────────

/**
 * Redeem a refresh token at POST /auth/oauthtoken.
 *
 * Written here rather than reused because the repo has no refresh-grant path —
 * that absence IS REF-100 (REF-90 §2.3: "the refresh token sits in the table
 * unused"). Form-encoded with the same field names and the same content type as
 * exchangeCodeForToken(), because the endpoint rejects a JSON body.
 *
 * Returns the parsed body and the status. Nothing derived from the body escapes
 * this function unredacted; the refresh token is passed to redactSecrets() as an
 * extra literal because Tradovate echoes grant values back inside free-form
 * error_description prose, where no key=value pattern would find them.
 */
async function redeemRefreshToken(config: TradovateOAuthConfig, refreshToken: string) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
    cache: 'no-store',
  });

  const text = await res.text();
  const safe = (value: string) => redactSecrets(value, [refreshToken]).slice(0, 300);

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    return { status: res.status, parsed: null, body: null, unparsable: safe(text) };
  }

  return {
    status: res.status,
    parsed,
    body: (parsed ?? {}) as OAuthTokenResponse,
    unparsable: null as string | null,
  };
}

/**
 * Is the PREVIOUS access token still accepted?
 *
 * This is the measurement, not a formality. If the old token still answers,
 * redeeming the refresh token extended the user's existing session; if it is
 * refused, a new session was opened — and the two-concurrent-session cap means
 * that can evict the trading terminal the user has open. REF-90 §2.6 lists this
 * as undocumented either way.
 *
 * Against the Live host whatever the environment, because /auth/me is Live-only
 * (see LIVE_API_URL in lib/tradovate/hosts.ts). Nothing from the response is
 * reported but the shape: the body also carries email and fullName.
 */
async function probePreviousToken(
  config: TradovateOAuthConfig,
  previousAccessToken: string,
  storedTradovateUserId: number | null
) {
  try {
    const me = await tradovateGet<TradovateMeResponse>('/auth/me', undefined, {
      apiUrl: config.liveApiUrl,
      accessToken: previousAccessToken,
      // Bounded on purpose. tradovateRequest() absorbs up to two rate-limit
      // penalties with waits of up to a minute each, and the tokens have
      // already been saved by the time this runs — so an unbounded probe could
      // spend maxDuration and cost us the whole response, which is the one
      // thing that cannot be recovered from a retry.
      signal: AbortSignal.timeout(15_000),
    });
    return {
      outcome: 'ok' as const,
      httpStatus: null as number | null,
      /** True only on a 2xx. Every other value of `outcome` means "not known". */
      stillValid: true as boolean | null,
      returnedUserId: typeof me?.userId === 'number',
      userIdMatchesStored:
        typeof me?.userId === 'number' && storedTradovateUserId !== null
          ? me.userId === storedTradovateUserId
          : null,
      errorText: null as string | null,
    };
  } catch (error) {
    const shape = {
      httpStatus: null as number | null,
      // null, not false: "I could not ask" is not "the token was refused". Only
      // a 401 or 403 below turns this into a definite false.
      stillValid: null as boolean | null,
      returnedUserId: false,
      userIdMatchesStored: null,
      errorText: safeMessage(error),
    };
    if (error instanceof TradovatePenaltyError) {
      // Inconclusive, not a refusal: /auth/me is limited to 10 per hour and
      // counts failures only, so a run of failed connects can have spent it.
      return { ...shape, outcome: 'penalty' as const };
    }
    if (error instanceof TradovateRequestError) {
      return {
        ...shape,
        outcome: 'http' as const,
        httpStatus: error.status,
        // The same evidence rule as classifyRenewalFailure(): only these two
        // statuses are a verdict on the credential. A 5xx or an unreadable body
        // says nothing about the token, and reading it as a refusal here would
        // manufacture the very conclusion this route exists to test.
        stillValid: error.status === 401 || error.status === 403 ? false : null,
      };
    }
    return { ...shape, outcome: 'exception' as const };
  }
}

async function measureRefreshRedemption(params: {
  row: DiagnosticRow;
  carried: ReturnType<typeof carryForward>;
  config: TradovateOAuthConfig;
  previousAccessToken: string;
  admin: SupabaseClient;
}) {
  const { row, carried, config, previousAccessToken, admin } = params;

  if (!carried.refreshToken) {
    return {
      ok: false,
      reason: 'no_refresh_token_stored',
      detail: 'refresh_token_encrypted is NULL on this row; there is nothing to redeem.',
    };
  }

  const result = await redeemRefreshToken(config, carried.refreshToken);
  const body = result.body;

  if (result.unparsable !== null) {
    return {
      ok: false,
      reason: 'unparsable_body',
      httpStatus: result.status,
      detail: result.unparsable,
    };
  }

  // The trap that is everywhere in this API: a penalty arrives with an ordinary
  // status and the payload replaced.
  if (isPenaltyResponse(result.parsed)) {
    const penalty = result.parsed as Record<string, unknown>;
    return {
      ok: false,
      reason: 'rate_limited',
      httpStatus: result.status,
      pTimeSeconds: typeof penalty['p-time'] === 'number' ? penalty['p-time'] : null,
      captcha: Boolean(penalty['p-captcha']),
      detail: 'the grant was rate limited; nothing was redeemed and nothing was written',
    };
  }

  if (body?.error) {
    return {
      ok: false,
      reason: 'oauth_error',
      httpStatus: result.status,
      oauthError: body.error,
      detail: redactSecrets(body.error_description ?? 'no description', [
        carried.refreshToken,
      ]).slice(0, 300),
    };
  }

  if (!body?.access_token) {
    return {
      ok: false,
      reason: 'no_access_token',
      httpStatus: result.status,
      detail: 'the response carried no access_token',
    };
  }

  // Lifetimes, not credentials. These two numbers are most of the answer to
  // REF-90 §2.6: refresh_token_expires_in has never had a documented value, and
  // the only place that knows it is a live response.
  const expiresIn =
    typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0
      ? body.expires_in
      : null;
  const refreshExpiresIn =
    typeof body.refresh_token_expires_in === 'number' &&
    Number.isFinite(body.refresh_token_expires_in) &&
    body.refresh_token_expires_in > 0
      ? body.refresh_token_expires_in
      : null;

  const rotated = typeof body.refresh_token === 'string' && body.refresh_token.length > 0;
  const refreshTokenChanged = rotated ? body.refresh_token !== carried.refreshToken : false;

  const measured = {
    httpStatus: result.status,
    issuedAccessToken: true,
    /** Whether a refresh_token field came back at all. */
    issuedRefreshToken: rotated,
    /** Whether that value differs from the one we sent. Rotation, if true. */
    refreshTokenChanged,
    expiresIn,
    refreshTokenExpiresIn: refreshExpiresIn,
    tokenType: body.token_type ?? null,
    apiHostsReturned: readApiHosts(result.parsed) !== undefined,
  };

  if (expiresIn === null) {
    // Nothing can be stored: saveConnection() refuses an unparsable expiry, and
    // inventing a lifetime is what ./oauth.ts and ./auth.ts both refuse to do.
    // The refresh token has been spent, so say so loudly.
    console.error(
      '[tradovate][diag] refresh grant returned a token with an unusable expires_in; ' +
        'nothing was stored and the refresh token has been spent. The owner may need to ' +
        'reconnect.'
    );
    return {
      ok: false,
      reason: 'unusable_expires_in',
      ...measured,
      saved: false,
      detail:
        'a token was issued but expires_in was missing or nonsensical, so it could not be ' +
        'stored. The refresh token has been consumed. Reconnect if the connection is broken.',
    };
  }

  // Stored BEFORE the /auth/me probe, so a failure in the probe cannot cost us
  // the tokens we just obtained. Every column saveConnection() writes is
  // supplied; the stored refresh token and its expiry are carried forward when
  // the response did not restate them, because omitting them writes NULL.
  let saved: { ok: boolean; error: string | null; refreshTokenStored: 'new' | 'carried-forward' };
  const storedRefreshSource = rotated ? ('new' as const) : ('carried-forward' as const);
  try {
    await saveConnection({
      ...carried,
      accessToken: body.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
      refreshToken: rotated ? body.refresh_token : carried.refreshToken,
      refreshExpiresAt:
        refreshExpiresIn !== null ? Date.now() + refreshExpiresIn * 1000 : carried.refreshExpiresAt,
      tokenType: body.token_type ?? carried.tokenType,
      apiHosts: readApiHosts(result.parsed) ?? carried.apiHosts,
      admin,
    });
    saved = { ok: true, error: null, refreshTokenStored: storedRefreshSource };
  } catch (error) {
    saved = { ok: false, error: safeMessage(error), refreshTokenStored: storedRefreshSource };
    console.error(`[tradovate][diag] FAILED to save the refreshed tokens: ${saved.error}`);
  }

  const previousToken = await probePreviousToken(config, previousAccessToken, row.tradovate_user_id);

  return {
    ok: true,
    ...measured,
    saved,
    previousAccessToken: previousToken,
    verdict:
      previousToken.stillValid === true
        ? 'the previous access token still answers /auth/me — the existing session survived, so ' +
          'the refresh grant did not open a second one'
        : previousToken.stillValid === false
          ? `the previous access token was refused (HTTP ${previousToken.httpStatus}) — ` +
            'redeeming the refresh token appears to have replaced the session, which counts ' +
            'against the two-session cap and can evict a trading terminal'
          : 'INCONCLUSIVE — the probe neither succeeded nor produced a 401/403, so it says ' +
            'nothing either way. Read previousAccessToken.outcome and errorText, then re-run.',
  };
}

// ── the route ───────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  // Gate 1. Before anything else, including reading the session: a disabled
  // route must not be distinguishable from a route that does not exist.
  if (process.env[ENABLE_ENV_VAR] !== '1') return notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return notFound();

  // Gate 2. The same fail-closed allowlist as connect and callback. 404, not
  // 403: a user who is not on the list learns nothing about what is here.
  if (!isUserAllowed(user.id)) {
    if (!isAllowlistConfigured()) {
      console.warn(
        `[tradovate][diag] refused: ${ENABLE_ENV_VAR} is set but ` +
          'TRADOVATE_OAUTH_ALLOWED_USER_IDS is unset or empty, so nobody is allowed.'
      );
    }
    return notFound();
  }

  const action = new URL(request.url).searchParams.get('action');
  if (action !== 'rate' && action !== 'refresh') {
    return NextResponse.json(
      { error: 'Unknown action. Use ?action=rate or ?action=refresh&confirm=not-in-trade.' },
      { status: 400 }
    );
  }

  // Gate 3. ?action=refresh may close a session the user has open in their
  // trading platform — that is the very thing it measures — so it does not run
  // on a bare URL that could have been followed by accident.
  if (action === 'refresh' && new URL(request.url).searchParams.get('confirm') !== REFRESH_CONFIRM) {
    return NextResponse.json(
      {
        error: `Refusing to redeem a refresh token without confirm=${REFRESH_CONFIRM}.`,
        why:
          'Nothing documents whether redeeming a refresh token opens a NEW Tradovate ' +
          'session. If it does, the two-concurrent-session cap closes the oldest — which ' +
          'can be the session in your own trading platform, mid-trade. Run this only when ' +
          'you hold no position and have no order working.',
        retry: `?action=refresh&confirm=${REFRESH_CONFIRM}`,
      },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: row, error: readError } = await admin
    .from('tradovate_connections')
    .select(DIAGNOSTIC_COLUMNS)
    .eq('user_id', user.id)
    .maybeSingle<DiagnosticRow>();

  // A PostgREST error carries the failing statement and its code, not the row.
  if (readError) {
    return NextResponse.json(
      { error: 'Failed to read the connection', code: readError.code },
      { status: 500 }
    );
  }
  if (!row) {
    return NextResponse.json({ error: 'No Tradovate connection for this user' }, { status: 409 });
  }

  const connection = {
    status: row.status,
    environment: row.environment,
    expiresAt: row.expires_at,
    /** The column REF-90 §2.4 found nothing in the code ever reads. */
    refreshExpiresAt: row.refresh_expires_at,
    hasRefreshToken: row.refresh_token_encrypted !== null,
    hasStoredApiHosts: row.api_hosts !== null,
    tokenType: row.token_type,
    msUntilAccessTokenExpiry: Date.parse(row.expires_at) - Date.now(),
    msUntilRefreshTokenExpiry: row.refresh_expires_at
      ? Date.parse(row.refresh_expires_at) - Date.now()
      : null,
  };

  // Before any upstream call, so a bad key or bad ciphertext fails here rather
  // than after the budget has been spent. See carryForward.
  let carried: ReturnType<typeof carryForward>;
  try {
    carried = carryForward(row, user.id);
  } catch (error) {
    console.error(`[tradovate][diag] could not read the stored tokens: ${safeMessage(error)}`);
    return NextResponse.json(
      { error: 'Could not read the stored tokens', connection },
      { status: 500 }
    );
  }

  const measuredAt = new Date().toISOString();

  if (action === 'rate') {
    // Read first so the address is known even if the loop dies, and because it
    // is the only field that makes two separate runs comparable.
    const egress = await readEgressIp();

    // Through the shipped path, including its cache and single-flight guard, so
    // the starting token is the one the app itself would use. This call renews
    // on its own if the stored token was inside the 15-minute margin, which is
    // why `priming` reports the margin it saw.
    let startingToken: string;
    try {
      startingToken = (await getUserAccessToken(user.id, { admin })).accessToken;
    } catch (error) {
      const kind =
        error instanceof TradovateNotConnectedError
          ? `not_connected:${error.status}`
          : error instanceof TradovateTransientError
            ? `transient:${error.reason}`
            : 'unknown';
      return NextResponse.json(
        {
          error: 'Could not obtain a starting access token',
          kind,
          detail: safeMessage(error),
          connection,
          egressIp: egress.ip,
        },
        { status: 409 }
      );
    }

    const measurement = await measureRenewalRate({ row, carried, startingToken, admin });

    return NextResponse.json({
      action: 'rate',
      measuredAt,
      question:
        'Is GET /auth/renewaccesstoken limited to 15 per hour per IP, or 5,000 per hour per user?',
      egressIp: egress.ip,
      egressIpError: egress.error,
      egressIpSource: IP_LOOKUP_URL,
      maxRenewals: MAX_RENEWALS,
      connection,
      priming: {
        via: 'getUserAccessToken()',
        msUntilExpiryWhenAsked: connection.msUntilAccessTokenExpiry,
        renewMarginMs: 15 * 60_000,
        mayHaveRenewedBeforeCall1: connection.msUntilAccessTokenExpiry <= 15 * 60_000,
      },
      ...measurement,
      notObservable: RATE_BLIND_SPOTS,
    });
  }

  // action === 'refresh'
  const oauth = loadOAuthConfig();
  if (!oauth.ok) {
    // Names variables, never values — but it goes to the server console only.
    console.error(describeConfigError(oauth));
    return NextResponse.json({ error: 'Tradovate OAuth is not configured' }, { status: 500 });
  }

  // The refresh token was minted by one environment and the token endpoint is
  // this deployment's. Posting a demo grant to the live endpoint would fail in
  // a way that says nothing about the question, so refuse rather than measure
  // noise.
  if (oauth.config.environment !== row.environment) {
    return NextResponse.json(
      {
        error: 'Environment mismatch',
        detail:
          `the stored connection is ${row.environment} but this deployment's ` +
          `TRADOVATE_API_URL declares ${oauth.config.environment}; the refresh grant would ` +
          'go to the wrong token endpoint',
        connection,
      },
      { status: 409 }
    );
  }

  const previousAccessToken = decryptToken(row.access_token_encrypted, 'access', user.id);
  const measurement = await measureRefreshRedemption({
    row,
    carried,
    config: oauth.config,
    previousAccessToken,
    admin,
  });

  return NextResponse.json({
    action: 'refresh',
    measuredAt,
    question:
      'Does the refresh grant work, does it rotate the refresh token, and does the previous ' +
      'access token survive it?',
    tokenEndpoint: oauth.config.tokenUrl,
    connectionBefore: connection,
    ...measurement,
  });
}

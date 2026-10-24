/**
 * Authenticated Tradovate requests.
 *
 * SERVER ONLY — see ./config.ts.
 *
 * The one place that knows how to attach a token, so callers never touch
 * credentials:
 *
 *   const accounts = await tradovateGet<Account[]>('/account/list');
 *
 * READ-ONLY BY DESIGN. This groundwork covers authentication and reading; there
 * is no order entry or trade management here, and adding one should be a
 * deliberate decision rather than a side effect of needing a POST.
 *
 *
 * TWO KINDS OF REQUEST, AND ONE INVARIANT THE COMPILER ENFORCES
 * ------------------------------------------------------------
 *
 * A request is made either with the application's own password-grant session
 * or with a connected user's OAuth token, and the two differ in where the host
 * comes from:
 *
 *   - The application's session resolves its base URL from configuration, as
 *     it always has. There is one deployment, so there is one host.
 *   - A user's token does not. Hosts are a property of the user: an
 *     organization on dedicated infrastructure reaches the API on its own
 *     hostnames, which arrive with the token and are stored per connection.
 *     See ./api-hosts.ts.
 *
 * So {@link UserTokenRequestOptions} requires `apiUrl` alongside
 * `accessToken`: passing a user's token without saying which host it belongs
 * to does not type-check. That is REF-92's bug class — a per-user call
 * silently addressed to the deployment's host, which answers a
 * dedicated-infrastructure user with a 307 that surfaces as a confusing 401 —
 * and it is the kind of omission that is invisible in review and impossible
 * to find later. It is a type error here instead of a comment telling the
 * next author to remember.
 *
 * IT REQUIRES `userId` TOO, SINCE REF-112, and it is the same invariant rather
 * than a second one: a user's token travels with the host it is addressed to
 * AND with whose it is. Both are facts about "this request is on one
 * particular trader's behalf", and the second is what makes the request
 * countable — see {@link UserTokenRequestOptions.userId} and ./call-meter.ts.
 * The id is never sent: it reaches the meter and nothing else.
 */

import { noteUserCall } from './call-meter';
import { getAccessToken, clearToken } from './session';
import { describeConfigError, loadConfig } from './config';
import {
  TradovateConfigError,
  TradovateError,
  TradovatePenaltyError,
  TradovateRequestError,
} from './errors';
import { isPenaltyResponse, type TradovateConfig } from './types';

/** What both kinds of request share. */
interface CommonRequestOptions {
  /** Query parameters. Values are stringified; undefined entries are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body. Presence switches the default method to POST. */
  body?: unknown;
  method?: 'GET' | 'POST';
  signal?: AbortSignal;
}

/**
 * A request made with the application's own session — the default.
 *
 * The base URL is resolved from configuration, so `apiUrl` is an optional
 * override rather than a requirement: there is one deployment and therefore
 * one host, and ./session.ts owns the token.
 */
export interface AppSessionRequestOptions extends CommonRequestOptions {
  /**
   * Not available here. A user's token belongs with
   * {@link UserTokenRequestOptions}, which also demands the host it belongs
   * to — see the invariant in the header. Declared rather than merely absent
   * so that reading `options.accessToken` still type-checks across the union.
   */
  accessToken?: never;
  /**
   * Not available here either, and the absence is the point: a request made
   * with the APPLICATION'S own password-grant session is not made on anybody's
   * behalf, so there is nobody to attribute it to and ./call-meter.ts does not
   * count it. Declared for the same reason `accessToken` is — so that reading
   * `options.userId` type-checks across the union.
   */
  userId?: never;
  /** Override just the REST base URL. Optional: configuration supplies one. */
  apiUrl?: string;
  /** Override the resolved configuration; mainly for tests and the CLI. */
  config?: TradovateConfig;
}

/**
 * A request made with a connected user's OAuth token.
 *
 * `apiUrl` IS REQUIRED, and that is the whole point of this type. A user's
 * hosts are their own — build the value with resolveTradingApiUrl() from
 * ./api-hosts.ts, which reads them off the connection and falls back to the
 * documented shared hosts. Never reach for TRADOVATE_API_URL or
 * TRADING_API_URLS to fill it in; both describe this deployment, not the
 * user, and for a dedicated-infrastructure trader they are simply wrong.
 *
 * The token is theirs, not the app's, so it must not come from — or be
 * invalidated in — the module-level cache in ./session.ts. When it is set the
 * 401 retry is skipped too: this layer has no way to renew someone else's
 * token, and ./connections.ts owns that decision.
 */
export interface UserTokenRequestOptions extends CommonRequestOptions {
  accessToken: string;
  apiUrl: string;
  /**
   * WHOSE token this is — the Supabase user id (REF-112 §4.5 item 1).
   *
   * REQUIRED, FOR EXACTLY THE REASON `apiUrl` IS. The invariant above says a
   * user's token must travel with the host it is addressed to; this says it
   * must also travel with whose it is. Both are properties of the same fact —
   * this request is being made on one particular trader's behalf — and both
   * are enforced by the compiler rather than by a comment asking the next
   * author to remember.
   *
   * WHAT IT IS FOR: counting. REF-112 §4.5's first finding is that nothing in
   * this product can answer "how many calls did user X make yesterday", and
   * that §4.3's whole table of per-user call volumes was derived by READING THE
   * CODE rather than by measuring. {@link tradovateRequest} is the one function
   * every per-user request passes through, so it is the only place where "a
   * request happened" is a fact instead of an arithmetic estimate — and a
   * request that cannot say whose it was cannot be counted.
   *
   * It is NOT sent anywhere. It never reaches a URL, a header or a body; it is
   * handed to ./call-meter.ts and nothing else. Tradovate has its own numeric
   * user id (`tradovate_user_id`) and this is not it.
   *
   * Making it required is a deliberate cost: five call sites had to name the
   * trader, one of them by growing a parameter (`fetchTradovateUser`). An
   * optional field would have been free and would have been forgotten, and a
   * counter that is silently missing a caller is worse than no counter — it
   * reads as a measurement.
   */
  userId: string;
  /**
   * Not available here, for the same reason `apiUrl` is mandatory: a
   * TradovateConfig carries the deployment's host and the application's own
   * credentials, neither of which has anything to do with this request.
   */
  config?: never;
}

export type RequestOptions = AppSessionRequestOptions | UserTokenRequestOptions;

/**
 * `Omit` that distributes over a union.
 *
 * Not a nicety: the built-in `Omit<A | B, K>` collapses the union into one
 * object type built from the keys A and B have in common, which would turn
 * `accessToken: string` and `apiUrl: string` back into independent optionals
 * and silently throw the invariant away. {@link tradovateGet} is where that
 * would have happened.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Retries after a rate-limit penalty. Kept small: the caller is waiting. */
const MAX_PENALTY_RETRIES = 2;
const MAX_PENALTY_WAIT_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The retried request's body, carrying the penalty ticket (REF-112 §4.5 item 4).
 *
 * THE PROTOCOL, VERBATIM, FROM THE ONE PLACE IT IS WRITTEN DOWN —
 * docs/tradovate-measurements.md §6, quoting the vendor FAQ:
 *
 *     p-ticket | include in the body of the retried request, alongside the
 *              | original fields
 *
 * "ALONGSIDE THE ORIGINAL FIELDS" is why this merges rather than replaces. A
 * retry that sent `{ 'p-ticket': … }` alone would be a different request from
 * the one being retried, and the endpoint would answer a complaint about the
 * parameters it is now missing rather than the payload.
 *
 *
 * A GET HAS NO BODY, AND THAT IS NOT SOMETHING THIS FUNCTION CAN FIX
 * -----------------------------------------------------------------
 *
 * **The ticket is only replayable on a request that already has a body**, and
 * that has to be said plainly because almost every call in this integration is
 * a GET. `/account/list`, `/fill/list`, `/fillPair/list`, `/position/list`,
 * `/order/list`, the three pricing items, `/currency/list` and `/auth/me` are
 * all GETs with their arguments in the query string. For those, the FAQ
 * prescribes a field in a body that does not exist, and NOTHING DOCUMENTS A
 * QUERY PARAMETER OR A HEADER AS AN ALTERNATIVE — not the FAQ, not the REST
 * reference, and not the measurements doc.
 *
 * So a GET retries without the ticket, exactly as it did before this change.
 * Inventing `?p-ticket=` or an `X-P-Ticket` header would be a guess sent to a
 * limiter we cannot afford to annoy, and a guess that LOOKS like compliance in
 * review is worse than a documented gap.
 *
 * MANUFACTURING A BODY WAS THE OTHER TEMPTING WRONG ANSWER, and the deleted
 * spike shows why. `scripts/spike/tradovate-spike.mjs`' `rest()` (recoverable
 * at commit ad45b36) retried with `body: { ...(body ?? {}), 'p-ticket': … }`
 * and recomputed its verb as `body ? 'POST' : 'GET'` — so a penalised GET came
 * back as a **POST**, silently, to a read endpoint. Here the verb is computed
 * ONCE before the loop, which means the same move would instead hand `fetch` a
 * GET with a body and throw a TypeError on top of a rate limit.
 *
 * WHAT THIS IS WORTH TODAY, honestly: one endpoint.
 * `/cashBalance/getcashbalancesnapshot` is the only body-carrying call that
 * reaches this function ({@link tradovatePost}, from the live route) — the two
 * auth POSTs in ./auth.ts and ./oauth.ts use `fetch` directly and do not come
 * through here. That one endpoint is on the fifteen-second poll, which is the
 * highest-frequency caller in the product and therefore the likeliest to be
 * penalised, so it is the one that matters most.
 *
 * Non-objects pass through untouched. A body that is an array or a string
 * cannot have a field added to it, and spreading one would reshape the request.
 */
function withPenaltyTicket(body: unknown, ticket: string | null): unknown {
  if (ticket === null || body === undefined) return body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), 'p-ticket': ticket };
}

function buildUrl(apiUrl: string, path: string, query: RequestOptions['query']): string {
  const url = new URL(apiUrl + (path.startsWith('/') ? path : `/${path}`));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Perform an authenticated request and parse the JSON response.
 *
 * Handles three things callers should not each reimplement:
 *
 * - **Token attachment and renewal**, via ./session.ts.
 * - **Time penalties.** Tradovate signals rate limiting in the body with
 *   `p-ticket`/`p-time` and an ordinary status code, so a plain `res.ok` check
 *   would parse a penalty as a successful payload. We wait `p-time` and retry
 *   with the `p-ticket` in the body, which is the handling the FAQ prescribes —
 *   see {@link withPenaltyTicket}, including the honest limit on how far that
 *   can be taken for a GET.
 * - **A stale token.** On a 401 the cache is dropped and the request retried
 *   once, which covers a session evicted by the two-session cap.
 */
export async function tradovateRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    query,
    body,
    method,
    config,
    accessToken,
    apiUrl: apiUrlOverride,
    signal,
    userId,
  } = options;
  const verb = method ?? (body !== undefined ? 'POST' : 'GET');

  // The invariant again, at runtime. UserTokenRequestOptions already makes
  // this unreachable from TypeScript; this catches a caller that arrived
  // through `any`, a JSON-shaped options object, or a cast — because the cost
  // of being wrong is a user's token sent to the wrong organization's host,
  // and a defence that rests on everyone's build being clean is not one.
  if (accessToken && !apiUrlOverride) {
    throw new TradovateError(
      `Refusing to send a connected user's token to ${path} without an explicit ` +
        'apiUrl: hosts are per-user. Build one with resolveTradingApiUrl() from ' +
        './api-hosts.ts.'
    );
  }

  const apiUrl = apiUrlOverride?.replace(/\/+$/, '') ?? resolveApiUrl(config);
  const url = buildUrl(apiUrl, path, query);

  // Two independent budgets: a stale token is worth exactly one re-auth, and a
  // rate-limit penalty is worth a few waits. Sharing one counter would let a
  // 401 silently eat a penalty retry.
  let retriedAfter401 = false;
  let penaltyAttempts = 0;

  // The ticket from the penalty we are retrying, replayed in the next body as
  // the FAQ prescribes (REF-112 §4.5 item 4). Null on the first attempt and on
  // every retry of a request that has no body to put it in — see
  // {@link withPenaltyTicket}, which is where that limitation is argued.
  let penaltyTicket: string | null = null;

  for (;;) {
    const bearer = accessToken ?? (await getAccessToken({ config })).accessToken;

    // Rebuilt per attempt rather than hoisted, because the ticket changes
    // between attempts. `verb` deliberately does NOT move with it: the method
    // is a property of the CALL, and recomputing it from the body is what
    // turned the deleted spike's penalised GETs into POSTs.
    const sent = withPenaltyTicket(body, penaltyTicket);

    // COUNTED HERE, AND A RETRY COUNTS AGAIN (REF-112 §4.5 item 1). This is
    // immediately before the `fetch` rather than after it, and per attempt
    // rather than per call, because what the limiter sees is REQUESTS SENT —
    // a penalty retry and a 401 re-auth are each another request against the
    // same quota, and a counter that only counted successful round trips would
    // under-report exactly the user who is in trouble.
    //
    // Synchronous and cannot throw; nothing is written to the database here.
    // See ./call-meter.ts on why the count is buffered and when it lands.
    if (userId !== undefined) noteUserCall(userId);

    const res = await fetch(url, {
      method: verb,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(sent !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: sent !== undefined ? JSON.stringify(sent) : undefined,
      cache: 'no-store',
      signal,
    });

    const text = await res.text();

    // A session closed by the two-session cap shows up here. Re-authenticate
    // once; a second 401 is a real failure, not a stale token. Skipped for a
    // caller-supplied token: clearToken() would evict the *application's*
    // session, which has nothing to do with this request.
    if (res.status === 401 && !retriedAfter401 && !accessToken) {
      retriedAfter401 = true;
      clearToken();
      continue;
    }

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new TradovateRequestError(path, res.status, text);
    }

    if (!res.ok) throw new TradovateRequestError(path, res.status, text);

    if (isPenaltyResponse(parsed)) {
      const p = parsed as Record<string, unknown>;
      const captcha = Boolean(p['p-captcha']);
      const seconds = typeof p['p-time'] === 'number' ? p['p-time'] : 1;
      const waitMs = Math.min(Math.max(seconds, 0) * 1000, MAX_PENALTY_WAIT_MS);

      if (captcha) {
        throw new TradovatePenaltyError(
          `Tradovate returned a captcha challenge on ${path}; wait about an hour.`,
          { captcha: true }
        );
      }
      if (penaltyAttempts >= MAX_PENALTY_RETRIES) {
        throw new TradovatePenaltyError(
          `Rate limited on ${path} after ${MAX_PENALTY_RETRIES} retries; retry in ${seconds}s.`,
          { retryAfterSeconds: seconds }
        );
      }
      penaltyAttempts++;
      // CARRY THE TICKET INTO THE NEXT ATTEMPT (REF-112 §4.5 item 4). Until
      // this stage the retry was a bare `continue`, which re-sent the original
      // request and therefore spent another attempt against the same limiter
      // with nothing to show it had been told to wait. A non-string ticket, or
      // none at all, leaves this null and the retry is the one we always sent.
      penaltyTicket = typeof p['p-ticket'] === 'string' ? p['p-ticket'] : null;
      await sleep(waitMs);
      continue;
    }

    return parsed as T;
  }
}

/** Resolve the base URL without forcing every caller to load configuration. */
function resolveApiUrl(override?: TradovateConfig): string {
  if (override) return override.apiUrl;
  const result = loadConfig();
  if (!result.ok) {
    throw new TradovateConfigError(describeConfigError(result), [
      ...result.missing,
      ...result.invalid.map((i) => i.name),
    ]);
  }
  return result.config.apiUrl;
}

/** GET an entity or list, e.g. `tradovateGet<Account[]>('/account/list')`. */
export function tradovateGet<T>(
  path: string,
  query?: CommonRequestOptions['query'],
  options: DistributiveOmit<RequestOptions, 'query' | 'body' | 'method'> = {}
): Promise<T> {
  // The cast restores exactly the three keys the Omit removed, which is the
  // one thing TypeScript cannot follow through a spread of a union. The
  // invariant is already enforced on `options` above, where a caller writes it.
  return tradovateRequest<T>(path, { ...options, query, method: 'GET' } as RequestOptions);
}

/**
 * POST a READ that takes a body (REF-108 Stage 4a).
 *
 * ONE CALLER, AND THE VERB IS NOT THE POINT. Tradovate exposes
 * `/cashBalance/getcashbalancesnapshot` as a POST taking `{ accountId }`, and it
 * reads — it is the only non-auth POST anywhere in this integration.
 *
 * **THIS MUST NOT BECOME A PRECEDENT FOR "IT WENT THROUGH `tradovatePost`, SO
 * IT MUST BE A READ".** A verb says nothing about what an endpoint does, and
 * this is now the only place that sentence is written down: the probe's
 * read-only guard said it first, about the same endpoint passing the same
 * mutation denylist, and that route was deleted on 21.10 (REF-107 small fixes).
 * An endpoint added here is read because somebody checked the vendor
 * documentation, and for no other reason.
 *
 * The only reason this helper exists rather than a bare `tradovateRequest` call
 * at the one call site is that the cast below is subtle and should live in
 * exactly one place — the same argument {@link tradovateGet} makes.
 *
 * A caller that wants to MUTATE trading state does not belong in this file at
 * all; nothing in this product places, modifies or cancels an order, and that is
 * a property worth keeping visible rather than one guard away.
 */
export function tradovatePost<T>(
  path: string,
  body: unknown,
  options: DistributiveOmit<RequestOptions, 'query' | 'body' | 'method'> = {}
): Promise<T> {
  // The same cast, for the same reason, with `body` in place of `query`.
  return tradovateRequest<T>(path, { ...options, body, method: 'POST' } as RequestOptions);
}

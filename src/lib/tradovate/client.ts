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
 */

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
 *   would parse a penalty as a successful payload. We wait and retry.
 * - **A stale token.** On a 401 the cache is dropped and the request retried
 *   once, which covers a session evicted by the two-session cap.
 */
export async function tradovateRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { query, body, method, config, accessToken, apiUrl: apiUrlOverride, signal } = options;
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

  for (;;) {
    const bearer = accessToken ?? (await getAccessToken({ config })).accessToken;

    const res = await fetch(url, {
      method: verb,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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

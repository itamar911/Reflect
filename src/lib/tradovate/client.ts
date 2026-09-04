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
 */

import { getAccessToken, clearToken } from './session';
import { describeConfigError, loadConfig } from './config';
import { TradovateConfigError, TradovatePenaltyError, TradovateRequestError } from './errors';
import { isPenaltyResponse, type TradovateConfig } from './types';

export interface RequestOptions {
  /** Query parameters. Values are stringified; undefined entries are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body. Presence switches the default method to POST. */
  body?: unknown;
  method?: 'GET' | 'POST';
  /** Override the resolved configuration; mainly for tests and the CLI. */
  config?: TradovateConfig;
  /**
   * Use this token instead of the shared application session.
   *
   * For OAuth: a connected user's token is theirs, not the app's, so it must not
   * come from — or be invalidated in — the module-level cache in ./session.ts.
   * When set, the 401 retry is also skipped: this layer has no way to renew
   * someone else's token, and ./connections.ts owns that decision.
   */
  accessToken?: string;
  /**
   * Override just the REST base URL. Lets an OAuth caller supply the apiUrl from
   * loadOAuthConfig() without also having to satisfy the password-grant
   * variables that a full TradovateConfig requires.
   */
  apiUrl?: string;
  signal?: AbortSignal;
}

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
  query?: RequestOptions['query'],
  options: Omit<RequestOptions, 'query' | 'body' | 'method'> = {}
): Promise<T> {
  return tradovateRequest<T>(path, { ...options, query, method: 'GET' });
}

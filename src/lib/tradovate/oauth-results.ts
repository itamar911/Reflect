/**
 * Where the OAuth flow sends the user when it finishes, and what it tells them.
 *
 * Shared by /api/tradovate/connect and /api/tradovate/callback so the two cannot
 * drift, and kept out of the route files so the eventual settings UI can import
 * the result codes without importing a route handler.
 *
 * The codes are deliberately coarse. A query parameter is visible to the user
 * and to anything that logs URLs, so it says what happened in terms the user can
 * act on and nothing more — no upstream error text, no identifiers, and above
 * all nothing derived from a token or an authorization code.
 */

/** Result page. The UI for this is not built yet; the codes are stable. */
export const TRADOVATE_RESULT_PATH = '/settings';

/** Query parameter carrying the outcome. */
export const TRADOVATE_RESULT_PARAM = 'tradovate';

export const TradovateResult = {
  /** Connected successfully. */
  Connected: 'connected',
  /**
   * The user declined on Tradovate's consent screen. A normal outcome — the
   * callback route treats this as a completed flow, not an error.
   */
  Denied: 'denied',
  /** State was absent, stale, or bound to a different account. */
  StateInvalid: 'state_invalid',
  /** The code exchange or the follow-up identification failed. */
  Failed: 'failed',
  /** Tradovate rate-limited the exchange. Retrying shortly usually works. */
  RateLimited: 'rate_limited',
  /** OAuth environment variables are missing or malformed on the server. */
  NotConfigured: 'not_configured',
} as const;

export type TradovateResultCode = (typeof TradovateResult)[keyof typeof TradovateResult];

/** Absolute URL of the result page, resolved against the incoming request. */
export function resultUrl(request: Request, code: TradovateResultCode): URL {
  const url = new URL(TRADOVATE_RESULT_PATH, request.url);
  url.searchParams.set(TRADOVATE_RESULT_PARAM, code);
  return url;
}

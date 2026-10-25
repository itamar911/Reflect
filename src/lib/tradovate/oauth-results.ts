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

/**
 * Result page.
 *
 * TWO OF THE EIGHT CODES NOW HAVE READERS — `connected_no_live` (REF-112 item
 * 5) and `not_available` (REF-112-C item 2), both in app/(app)/settings/page.tsx.
 * The other six still have none, which §2 of the investigation lists as a
 * defect of its own: a code nobody translates is a code the trader cannot act
 * on. The mechanism is built now, so wiring the rest is small and
 * self-contained.
 */
export const TRADOVATE_RESULT_PATH = '/settings';

/** Query parameter carrying the outcome. */
export const TRADOVATE_RESULT_PARAM = 'tradovate';

export const TradovateResult = {
  /** Connected successfully. */
  Connected: 'connected',
  /**
   * Connected, and the broker says there is no live or funded entitlement
   * (REF-112 §5.17, item 5).
   *
   * A SUCCESS, NOT A FAILURE, and the code sits next to `Connected` to say
   * so: the tokens are stored, the connection is live, and nothing was
   * refused. What it adds is the one sentence that separates "connected and
   * flat" from "connected to an account with nothing to pull" — two states
   * that were identical on every screen in the product, and which a trader
   * who has just finished a consent screen has no other way to tell apart.
   *
   * SAFE IN A URL, like the rest of them: it names a capability the trader
   * already knows about and no identifier.
   */
  ConnectedNoLive: 'connected_no_live',
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
  /**
   * The connection is not open to this user yet.
   *
   * Deliberately says nothing about why, so probing the route reveals neither
   * who is on a list nor whether one exists.
   *
   * ONE PRODUCER AND NOT TWO ANY MORE. It used to cover "you are not on the
   * list" and "no list is configured" alike, because the allowlist failed
   * closed and both meant the same refusal. After REF-112-C item 1 an
   * unconfigured list is the OPEN state, so the only way to produce this code
   * is a deliberately restricted deployment that excludes this user — which is
   * a rollback in force, not a configuration accident.
   *
   * READ BY app/(app)/settings/page.tsx, which turns it into
   * NOT_AVAILABLE_NOTE (lib/tradovate/notices.ts). Before REF-112-C item 2 it
   * was read by nothing and the refusal was effectively silent.
   */
  NotAvailable: 'not_available',
} as const;

export type TradovateResultCode = (typeof TradovateResult)[keyof typeof TradovateResult];

/** Absolute URL of the result page, resolved against the incoming request. */
export function resultUrl(request: Request, code: TradovateResultCode): URL {
  const url = new URL(TRADOVATE_RESULT_PATH, request.url);
  url.searchParams.set(TRADOVATE_RESULT_PARAM, code);
  return url;
}

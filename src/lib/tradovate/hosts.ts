/**
 * Documented Tradovate OAuth hosts, per environment.
 *
 * SERVER ONLY — see ./config.ts.
 *
 * Every value in this file is copied verbatim from NinjaTrader's official
 * documentation. Nothing here is inferred from the password-grant flow, and
 * nothing is derived by string-munging one host into another — the docs
 * explicitly warn against that:
 *
 *   "Assumes the Demo and Live hosts share a domain, or derives one host from
 *    the other."  — listed under "Who Needs to Change"
 *   https://docs.ninjatrader.com/api/dynamic-api-hosts
 *
 * which is exactly what the previous `${apiUrl.origin}/auth/oauthtoken`
 * derivation did. On Demo it produced a host that appears in neither doc.
 *
 *
 * The token-endpoint disagreement
 * -------------------------------
 *
 * The two official pages disagree about the token endpoint, in both host and
 * path. This is unresolved in the documentation, so both are encoded below and
 * {@link TOKEN_URL_SOURCE} selects between them in one place.
 *
 *   GUIDE — https://docs.ninjatrader.com/api/oauth (Step 3), a runnable
 *   Node/Express example:
 *       live  https://live.tradovateapi.com/auth/oauthtoken
 *       demo  https://live-api-d.tradovate.com/auth/oauthtoken
 *   Note the absence of /v1, and that Demo exchanges against a *different
 *   domain* than it trades on.
 *
 *   REFERENCE — https://docs.ninjatrader.com/api/rest-api-endpoints/authentication/o-auth-token
 *   (the "Servers" block):
 *       live  https://live.tradovateapi.com/v1/auth/oauthtoken
 *       demo  https://demo.tradovateapi.com/v1/auth/oauthtoken
 *
 * The guide is primary because it is the runnable example — it is the one that
 * has demonstrably been executed against a live server. If Phase 2 comes back
 * with `invalid_client` or a 404 on the exchange, flip TOKEN_URL_SOURCE to
 * 'reference' and nothing else changes.
 */

/** Which Tradovate environment a connection belongs to. */
export type TradovateEnvironment = 'demo' | 'live';

/**
 * Which of the two conflicting documented token endpoints to use.
 *
 * ── THE ONE SWITCH ────────────────────────────────────────────────────────
 * Change this single value to move between the guide's endpoint and the API
 * reference's endpoint. See the header for why they differ.
 * ──────────────────────────────────────────────────────────────────────────
 */
export const TOKEN_URL_SOURCE: 'guide' | 'reference' = 'guide';

/**
 * Authorization endpoint — where the user is sent to approve the connection.
 *
 *   "const AUTH_URL = 'https://trader.tradovate.com/oauth'"
 *   "For the Demo environment, use https://trader.devel.ninjatrader.dev/oauth."
 *   — https://docs.ninjatrader.com/api/oauth, Step 1
 */
export const AUTHORIZE_URLS: Record<TradovateEnvironment, string> = {
  live: 'https://trader.tradovate.com/oauth',
  demo: 'https://trader.devel.ninjatrader.dev/oauth',
};

/** Token endpoints as given by the OAuth guide's runnable example. */
const TOKEN_URLS_GUIDE: Record<TradovateEnvironment, string> = {
  live: 'https://live.tradovateapi.com/auth/oauthtoken',
  demo: 'https://live-api-d.tradovate.com/auth/oauthtoken',
};

/** Token endpoints as given by the REST reference's "Servers" block. */
const TOKEN_URLS_REFERENCE: Record<TradovateEnvironment, string> = {
  live: 'https://live.tradovateapi.com/v1/auth/oauthtoken',
  demo: 'https://demo.tradovateapi.com/v1/auth/oauthtoken',
};

export const TOKEN_URLS: Record<TradovateEnvironment, string> =
  TOKEN_URL_SOURCE === 'guide' ? TOKEN_URLS_GUIDE : TOKEN_URLS_REFERENCE;

/** The alternative, for a check script to display alongside the active one. */
export const TOKEN_URLS_ALTERNATIVE: Record<TradovateEnvironment, string> =
  TOKEN_URL_SOURCE === 'guide' ? TOKEN_URLS_REFERENCE : TOKEN_URLS_GUIDE;

/**
 * REST base for GET /v1/auth/me.
 *
 * Deliberately NOT the connection's own environment host. The endpoint is
 * Live-only:
 *
 *   "Environments: Live"
 *   "This endpoint operates against Live. On Demo it returns an error
 *    indicating the request must be sent to the Live server."
 *   — https://docs.ninjatrader.com/api/rest-api-endpoints/authentication/me
 *
 * and the guide's own example calls it on the Live host while describing a
 * flow that can be run against either environment:
 *
 *   "const me = await fetch('https://live.tradovateapi.com/v1/auth/me', …)"
 *   — https://docs.ninjatrader.com/api/oauth, "Using the Token"
 *
 * Hardcoding a host is normally wrong here (see the dynamic-hosts warning in
 * the header), but the same page says the Live host is currently uniform:
 *
 *   "Treat all hosts as authoritative, including live, mdLive, and replay.
 *    Those are currently the same for every organization…"
 *
 * and a pure-OAuth client has no documented way to learn apiHosts at connect
 * time — OAuthTokenResponse has no such field. That gap is Q4 in the plan; the
 * Phase 2 diagnostics report whether the exchange returns one after all.
 */
export const LIVE_API_URL = 'https://live.tradovateapi.com/v1';

/**
 * Trading REST bases, for reference and for the check script's report.
 *
 *   live.tradovateapi.com   Live trading
 *   demo.tradovateapi.com   Demo (simulation) environment
 *   — https://docs.ninjatrader.com/api/authentication, "Servers"
 */
export const TRADING_API_URLS: Record<TradovateEnvironment, string> = {
  live: 'https://live.tradovateapi.com/v1',
  demo: 'https://demo.tradovateapi.com/v1',
};

/**
 * Identify the environment from the configured trading REST base.
 *
 * Matched on the exact hostname rather than a substring: 'live-api-d' and
 * 'md-demo' both contain a substring that would misclassify, and guessing an
 * environment wrong means minting a token against one server and storing it
 * as if it belonged to the other.
 *
 * Returns null for anything unrecognised — notably the dedicated-infrastructure
 * hosts the dynamic-hosts page describes, which a pure-OAuth client cannot
 * discover at connect time. The caller reports that as a configuration problem
 * naming TRADOVATE_API_URL rather than assuming a default.
 */
export function detectEnvironment(apiUrl: string): TradovateEnvironment | null {
  let host: string;
  try {
    host = new URL(apiUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'demo.tradovateapi.com') return 'demo';
  if (host === 'live.tradovateapi.com') return 'live';
  return null;
}

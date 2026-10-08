/**
 * Per-user API hosts, resolved from what the server told us.
 *
 * SERVER ONLY — see ./config.ts.
 *
 * Some organizations run on dedicated, isolated infrastructure, so the host a
 * user reaches the API on is a property of that user and not of our deployment:
 *
 *   "Some organizations run on dedicated, isolated infrastructure rather than
 *    the shared NinjaTrader environment. Users in those organizations reach the
 *    API on different hostnames, so a client that hard-codes
 *    demo.tradovateapi.com can't serve them."
 *   — https://docs.ninjatrader.com/api/dynamic-api-hosts
 *
 * ./hosts.ts holds the documented shared hosts and is now the FALLBACK, not the
 * mechanism. This module is the mechanism: it reads `apiHosts` off an
 * authentication response, and builds a base URL from the one host that matches
 * the purpose of the request.
 *
 *
 * WHERE apiHosts COMES FROM
 * -------------------------
 *
 * The token exchange. Measured in production on 8 Oct 2026: POST
 * /auth/oauthtoken returns a complete `apiHosts` object, which settles a
 * disagreement between the two documentation sets in favour of the one
 * NinjaTrader named as authoritative:
 *
 *   - api.tradovate.com documents `apiHosts` on OAuthTokenResponse, the 200 of
 *     POST /auth/oauthtoken, and references its ApiHosts schema from nowhere
 *     else in the document. CORRECT.
 *   - https://docs.ninjatrader.com/api/dynamic-api-hosts lists the carriers as
 *     accessTokenRequest, the social login token request, renewAccessToken,
 *     modifyCredentials, modifyPassword and setSocialCredentials, and never
 *     mentions /auth/oauthtoken. WRONG, or at least incomplete, for a
 *     pure-OAuth client.
 *
 * GET /auth/me does not return it, as its OAuthMeResponse schema says. Renewal
 * does, which is what ./connections.ts had been storing since 1 Oct.
 *
 * So a connection knows its hosts from the moment it is made, and the
 * timing problem that made Option 2 — one renewal immediately after the
 * exchange, purely to learn the hosts — necessary does not exist.
 *
 *
 * WHY A FALLBACK IS STILL REQUIRED
 * --------------------------------
 *
 *   "apiHosts is optional, and it's omitted when the response carries an error
 *    and when the response asks for a multi-factor authentication step. Keep
 *    your existing host resolution as a fallback for those cases"
 *   — the same page
 *
 * A connection can therefore legitimately exist with api_hosts NULL, and every
 * row written before this change does. {@link resolveTradingApiUrl} never
 * fails: it answers with the stored host when there is a usable one and with
 * ./hosts.ts otherwise, and says which it used.
 *
 *
 * WHAT IS NOT DERIVED FROM apiHosts
 * ---------------------------------
 *
 * The authorize URL and the token URL. Neither appears in the object and no
 * document says to derive them, so they stay hard-coded in ./hosts.ts. The same
 * page is explicit that one host must not be derived from another:
 *
 *   "Assumes the Demo and Live hosts share a domain, or derives one host from
 *    the other."  — listed under "Who Needs to Change"
 *
 * which is why nothing here does string surgery on a hostname. A value is
 * either used as the server gave it, or not used at all.
 */

import { TRADING_API_URLS, type TradovateEnvironment } from './hosts';
import type { TradovateApiHosts } from './types';

/**
 * The version segment every REST path sits under.
 *
 *   "Build the URL from the stored host, for example
 *    https://<demo>/v1/account/list for a REST call"
 *   — https://docs.ninjatrader.com/api/dynamic-api-hosts
 */
const API_VERSION_PATH = '/v1';

/**
 * A bare hostname, optionally with a port.
 *
 * Observed on 8 Oct 2026: every value is a bare hostname — no scheme, no port,
 * no path — which is what the documentation claims:
 *
 *   "Every host is a bare hostname with no scheme. Your client adds https://
 *    for REST calls and wss:// for WebSocket connections."
 *
 * A port is tolerated because accepting one costs nothing and refusing it would
 * break a user over a detail the schema does not forbid (`{type: "string",
 * maxLength: 64}`, with no pattern). Anything else — a scheme, a path, a query,
 * whitespace, an empty string — is refused rather than repaired: prepending
 * `https://` to a value that already carries one produces a URL that resolves
 * nowhere, and quietly "fixing" it would hide a change in a contract we depend
 * on. A refused value falls back and is reported, not swallowed.
 */
const BARE_HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;

/**
 * Lift an `apiHosts` object off a parsed authentication response.
 *
 * Takes the whole body rather than the field so that callers never have to
 * assert their way into it: both authentication paths type the body with a
 * plain cast, so `body.apiHosts` is `TradovateApiHosts` by assertion and
 * `unknown` in fact.
 *
 * Returns undefined for a missing field, an explicit null, an array, and any
 * non-object. All of them mean the same thing to a caller — no hosts here, use
 * the fallback.
 */
export function readApiHosts(body: unknown): TradovateApiHosts | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const hosts = (body as Record<string, unknown>).apiHosts;
  if (typeof hosts !== 'object' || hosts === null || Array.isArray(hosts)) return undefined;
  return hosts as TradovateApiHosts;
}

/**
 * Read one host out of an apiHosts object, or null if it is not usable.
 *
 * Unrecognised keys are not an error anywhere in this module:
 *
 *   "Ignore fields you don't recognize. The response may carry additional hosts
 *    used by NinjaTrader tooling, and more can be added over time."
 *
 * — which is also why api_hosts is JSONB and {@link TradovateApiHosts} is an
 * open record. The production response already carries `riskMonitorLive`,
 * `riskMonitorDemo` and `userContext`, three keys the dynamic-hosts page's
 * field table does not list.
 */
export function readHostname(hosts: TradovateApiHosts | null | undefined, key: string): string | null {
  const value = hosts?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !BARE_HOSTNAME.test(trimmed)) return null;
  return trimmed;
}

/** Where a resolved base URL came from, so a caller can say so. */
export interface ResolvedApiUrl {
  /** REST base including the version segment, e.g. https://demo.tradovateapi.com/v1 */
  url: string;
  /** 'stored' when it came from apiHosts, 'fallback' when from ./hosts.ts. */
  source: 'stored' | 'fallback';
  /**
   * The apiHosts value that was refused, when one was present but unusable.
   * Set only in that case — absent both when a usable host was found and when
   * there was no value at all. A caller that logs it is logging a hostname,
   * which is not a secret.
   */
  rejected?: string;
}

/**
 * The trading REST base for one connection.
 *
 * Routed by purpose, not by a single environment setting, as the page instructs:
 * a Demo connection trades against `demo` and a Live connection against `live`.
 * `demo` is the host that actually varies —
 *
 *   "demo — Always — Demo (simulation) trading REST and WebSocket host. This is
 *    the host that varies by organization."
 *
 * — but `live` is resolved the same way rather than assumed, because the page
 * says to:
 *
 *   "Treat all hosts as authoritative, including live, mdLive, and replay.
 *    Those are currently the same for every organization, but they're returned
 *    so that your client keeps working if that changes."
 *
 * The environment comes from the stored connection, never from a hostname and
 * never from the deployment's configuration: the row records which environment
 * actually minted the token.
 *
 * Market data (`mdLive`, `mdDemo`) is deliberately not resolvable here. Market
 * Data is Denied in our OAuth registration and the feed needs CME sub-vendor
 * registration Reflect does not have, so there is no caller — and adding one
 * should be a deliberate decision rather than a side effect of this function
 * being general. Same for `replay` and the reporting hosts.
 */
export function resolveTradingApiUrl(params: {
  environment: TradovateEnvironment;
  apiHosts: TradovateApiHosts | null | undefined;
}): ResolvedApiUrl {
  const { environment, apiHosts } = params;

  // The key happens to equal the environment name for trading, which is a fact
  // about the documented field table and not an identity worth relying on
  // elsewhere: market data uses mdDemo/mdLive and reporting uses
  // reportingDemo/reportingLive, neither of which is the environment name.
  const host = readHostname(apiHosts, environment);
  if (host) return { url: `https://${host}${API_VERSION_PATH}`, source: 'stored' };

  const raw = apiHosts?.[environment];
  const fallback: ResolvedApiUrl = { url: TRADING_API_URLS[environment], source: 'fallback' };
  if (typeof raw === 'string' && raw.trim()) fallback.rejected = raw.trim();
  return fallback;
}

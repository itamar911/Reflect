/**
 * Types for the Tradovate REST API.
 *
 * Field names and shapes follow the official documentation at
 * https://api.tradovate.com/ and Tradovate's own example code
 * (github.com/tradovate/example-api-js, github.com/tradovate/example-api-faq).
 * There is no dedicated technical support on the vendor trial, so the docs are
 * the only authority — do not widen these types from guesswork.
 */

export interface TradovateConfig {
  /** Base URL including the version segment, e.g. https://demo.tradovateapi.com/v1 */
  apiUrl: string;
  username: string;
  password: string;
  appId: string;
  appVersion: string;
  /** Numeric application id. Tradovate rejects this as a string. */
  cid: number;
  sec: string;
  deviceId: string;
}

/** Request body for POST /auth/accesstokenrequest. */
export interface AccessTokenRequestBody {
  name: string;
  password: string;
  appId: string;
  appVersion: string;
  cid: number;
  sec: string;
  deviceId: string;
  /** Present only when retrying after a time-penalty response. */
  'p-ticket'?: string;
}

/**
 * The `apiHosts` map: which hosts to use for this user's subsequent calls.
 *
 * Bare hostnames, no scheme — the caller prefixes https:// or wss://. Left as
 * an open record on purpose: the dynamic-API-hosts page says to ignore
 * unrecognised fields and that more hosts may be added, so narrowing this to
 * the keys seen once would make a future addition a type error instead of data.
 *   https://docs.ninjatrader.com/api/dynamic-api-hosts
 */
export type TradovateApiHosts = Record<string, unknown>;

/**
 * Successful response from /auth/accesstokenrequest.
 *
 * /auth/renewaccesstoken returns the same shape. It was documented here as
 * returning it minus `mdAccessToken`; a production renewal showed otherwise —
 * renewal DOES carry mdAccessToken, and it also carries `apiHosts`. Neither
 * changes what we store: see the field comments below.
 */
export interface AccessTokenResponse {
  accessToken: string;
  /**
   * Market Data API token. We do NOT use it, and must not: Market Data is
   * Denied in our OAuth registration, and the Market Data WebSocket needs CME
   * sub-vendor registration Reflect does not have. It is typed here only
   * because the endpoint returns it — including on renewal, despite the denial.
   * Never stored, never sent anywhere, never logged.
   */
  mdAccessToken?: string;
  /** ISO datetime. The authoritative expiry — never hardcode a token lifetime. */
  expirationTime: string;
  userId: number;
  name?: string;
  userStatus?: 'Active' | 'Closed' | 'Initiated' | 'TemporaryLocked' | 'UnconfirmedEmail';
  passwordExpirationTime?: string;
  hasLive?: boolean;
  hasFunded?: boolean;
  hasMarketData?: boolean;
  hasSimPlus?: boolean;
  outdatedTaC?: boolean;
  outdatedLiquidationPolicy?: boolean;
  showKIDs?: boolean;
  /** Present when authentication failed; the HTTP status is still 200. */
  errorText?: string;
  /**
   * Dynamic API hosts for this user, returned by authentication and renewal.
   * Answers Q4: a pure-OAuth client learns them from the renewal response,
   * since the token exchange returns none.
   */
  apiHosts?: TradovateApiHosts;
  hibpHint?: 'EmailAndPasswordCompromised' | 'PasswordCompromised';
}

/**
 * Time-penalty response. Tradovate applies variable rate limits at the second,
 * minute and hour intervals and answers an over-limit request with these fields
 * *in place of* the normal payload — the HTTP status is not 429, so code that
 * only checks `response.ok` will parse a penalty as success.
 */
export interface PenaltyResponse {
  /** Seconds to wait before retrying. */
  'p-time'?: number;
  /** Echo back in the body of the retried request, alongside the original fields. */
  'p-ticket'?: string;
  /**
   * A third-party application cannot satisfy the challenge. Per Tradovate's FAQ
   * the client must stop and try again in about an hour — retrying sooner just
   * deepens the penalty.
   */
  'p-captcha'?: string | boolean;
}

export function isPenaltyResponse(body: unknown): body is PenaltyResponse {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return b['p-ticket'] !== undefined || b['p-time'] !== undefined || b['p-captcha'] !== undefined;
}

/** A live token plus everything needed to decide when to renew it. */
export interface TokenSnapshot {
  accessToken: string;
  mdAccessToken?: string;
  userId: number;
  /** Epoch milliseconds, parsed from `expirationTime`. */
  expiresAt: number;
  expirationTime: string;
  name?: string;
  userStatus?: AccessTokenResponse['userStatus'];
}

/**
 * Response from POST /auth/oauthtoken.
 *
 * `refresh_token` IS issued, together with `refresh_token_expires_in` —
 * observed on a production exchange. This comment, and migration 017's, used
 * to assert the opposite (the OAuth guide mentions neither field; only the REST
 * reference lists them). Sessions are still extended in place with GET
 * /auth/renewaccesstoken using the access token itself, so the refresh token is
 * not on the renewal path; it is what a returning user re-authorizes against.
 * Both fields stay optional: nothing documents them as guaranteed.
 *
 * `expires_in` is seconds, unlike the ISO `expirationTime` on the password-grant
 * response — the two auth paths report expiry in different units. Observed value
 * is 4800 (80 minutes), not the ~26 hours NinjaTrader support stated in writing.
 */
export interface OAuthTokenResponse {
  access_token?: string;
  /** Seconds until the access token expires. Observed: 4800. */
  expires_in?: number;
  token_type?: string;
  refresh_token?: string;
  /** Seconds until the refresh token expires. */
  refresh_token_expires_in?: number;
  /** OAuth 2.0 error code, e.g. 'access_denied', 'invalid_grant'. */
  error?: string;
  error_description?: string;
}

/**
 * Response from GET /auth/me — who a token belongs to.
 *
 * Used once, right after the exchange, to record `tradovate_user_id`. Only
 * `userId` is relied on; the rest is typed because the endpoint returns it.
 */
export interface TradovateMeResponse {
  userId: number;
  name?: string;
  fullName?: string;
  email?: string;
  emailVerified?: boolean;
  isTrial?: boolean;
}

/** A connected user's token, as ./connections.ts hands it out. */
export interface UserTokenSnapshot {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  tradovateUserId: number | null;
}

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
 * Successful response from /auth/accesstokenrequest.
 *
 * /auth/renewaccesstoken returns the same shape minus `mdAccessToken` — renewal
 * does not reissue the market-data token.
 */
export interface AccessTokenResponse {
  accessToken: string;
  /**
   * Market Data API token. We do NOT use it: the Market Data WebSocket requires
   * CME sub-vendor registration, which Reflect does not have. It is typed here
   * only because the endpoint returns it.
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
 * Note what is NOT here: `refresh_token`. Tradovate's OAuth token endpoint
 * issues an access token and nothing else — sessions are extended in place with
 * GET /auth/renewaccesstoken, using the access token itself as the credential.
 * The field is typed as optional only so that we store one if Tradovate ever
 * starts returning it; do not write code that assumes it will be there.
 *
 * `expires_in` is seconds, unlike the ISO `expirationTime` on the password-grant
 * response — the two auth paths report expiry in different units.
 */
export interface OAuthTokenResponse {
  access_token?: string;
  /** Seconds until the access token expires. */
  expires_in?: number;
  token_type?: string;
  /** Not currently issued by Tradovate. See above. */
  refresh_token?: string;
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

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
 * Bare hostnames, no scheme — the caller prefixes https:// or wss://. Read it
 * through ./api-hosts.ts, which owns the validation and the fallback; this
 * type is only the shape it arrives in.
 *
 * Left as an open record on purpose: the dynamic-API-hosts page says to ignore
 * unrecognised fields and that more hosts may be added, so narrowing this to
 * the keys seen once would make a future addition a type error instead of data.
 * That is not hypothetical — the production response measured on 8 Oct 2026
 * carried riskMonitorLive, riskMonitorDemo and userContext, none of which
 * appear in that page's field table, alongside the seven it does list:
 * live, demo, mdLive, mdDemo, replay, reportingLive, reportingDemo.
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
   * Dynamic API hosts for this user. Returned by renewal, which is where
   * ./connections.ts had been picking them up since 1 Oct. Not the only
   * source: the OAuth token exchange returns them too, measured 8 Oct 2026,
   * so a connection knows its hosts from the moment it is made. See
   * OAuthTokenResponse below and ./api-hosts.ts.
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
  /**
   * Dynamic API hosts for this user.
   *
   * MEASURED IN PRODUCTION, 8 Oct 2026: the exchange returns a complete
   * apiHosts object. api.tradovate.com documents the field here and is
   * right; https://docs.ninjatrader.com/api/dynamic-api-hosts omits
   * /auth/oauthtoken from its list of carriers and is wrong, at least for a
   * pure-OAuth client. Read it with readApiHosts() from ./api-hosts.ts
   * rather than off this field: the body is typed by a plain cast, so this
   * declaration is a claim about the server and not a guarantee about the
   * value in hand.
   */
  apiHosts?: TradovateApiHosts;
  /**
   * An OpenID Connect ID token.
   *
   * Neither documentation set mentions that the exchange issues one; it
   * does. We have no use for it — a connection's identity comes from GET
   * /auth/me — so it is typed for the same reason mdAccessToken is, because
   * the endpoint returns it and a field nobody has written down is a field
   * someone later mistakes for a discovery. Never stored, never read, never
   * logged; ./redact.ts lists it among the secret-bearing keys.
   */
  id_token?: string;
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

// ── Trading entities (REF-90) ────────────────────────────────────────────────
//
// The entities the day pull reads, and nothing more. Every field below appears
// in the schema on partner.tradovate.com for its endpoint; optional here means
// optional there, not "we are not sure". The response bodies are typed by a
// plain cast like every other body in this module, so these are claims about
// the server rather than guarantees about the value in hand — ./fills.ts
// validates what it depends on before doing arithmetic with it.
//
// WHAT IS NOT HERE, AND WHY. `/<entity>/list` takes no filter parameters at
// all ("Fetches all Fill entities", and the cheat sheet's "all of the entities
// that are within the logged on user's visible scope"), so there is no query
// shape to model: the filtering is ours and it happens after the response
// lands. That is the finding that makes a day pull a chain of calls rather
// than one.
//   https://partner.tradovate.com/resources/reference/api-cheat-sheet

/**
 * A `{year, month, day}` session label.
 *
 * READ BY NOTHING IN REF-90, and typed anyway because three of the entities
 * below carry it and a field nobody wrote down is a field someone later
 * mistakes for a day boundary. The hour at which it rolls over is NOT
 * documented — I looked at the endpoint pages, the architecture overview and
 * the cheat sheet — and the trading-hours article that would settle it is not
 * fetchable. So the day pull dates every trade by `Fill.timestamp`, a real
 * instant, and converts that to the trader's day itself. See ./trading-day.ts.
 */
export interface TradovateTradeDate {
  year: number;
  month: number;
  day: number;
}

/**
 * One execution. GET /v1/fill/list.
 *
 * NOT a trade: a single order can fill in several pieces, so counting these
 * would inflate "how many trades today", sometimes several-fold.
 * `finallyPaired` is the hint that it happened.
 *
 * Carries no accountId and no P&L — which is why the chain needs
 * /position/list for the account and /fillPair/list for the round trip.
 *   https://partner.tradovate.com/api/rest-api-endpoints/orders/fill-list
 */
export interface TradovateFill {
  id: number;
  orderId: number;
  contractId: number;
  /** ISO 8601 instant. The only field in this family that is one. */
  timestamp: string;
  tradeDate: TradovateTradeDate;
  action: 'Buy' | 'Sell';
  qty: number;
  price: number;
  active?: boolean;
  finallyPaired?: boolean;
}

/**
 * A round trip: an entry fill matched against the exit fill that closed it.
 * GET /v1/fillPair/list.
 *
 * The closest thing the API has to "a trade" in the sense a discipline rule
 * means, and the reason the P&L arithmetic is possible at all: both legs'
 * prices are here. It carries no date, no account and no currency, so each
 * pair is dated through its fills and attributed through its position.
 *
 * `active` is documented only as "Whether the fill pair is currently active";
 * what it says about a pair that has closed is not stated anywhere, so nothing
 * here branches on it.
 *   https://partner.tradovate.com/api/rest-api-endpoints/positions/fill-pair-list
 */
export interface TradovateFillPair {
  id: number;
  positionId: number;
  buyFillId: number;
  sellFillId: number;
  qty: number;
  buyPrice: number;
  sellPrice: number;
  active?: boolean;
}

/**
 * A position, per contract per trading day. GET /v1/position/list.
 *
 * Read for one thing: `accountId`. It is the only link from a fill pair to an
 * account, and therefore the only way to answer "is this trade mine" — see
 * ./accounts.ts.
 *   https://partner.tradovate.com/api/rest-api-endpoints/positions/position-list
 */
export interface TradovatePosition {
  id: number;
  accountId: number;
  contractId: number;
  timestamp: string;
  tradeDate: TradovateTradeDate;
  netPos: number;
}

/**
 * A trading account. GET /v1/account/list.
 *
 * The list is everything in the user's visible scope, which for a funded or
 * prop trader can include accounts they did not trade — hence `userId`, which
 * is matched against the connection's stored `tradovate_user_id`.
 *
 * There is no "primary" flag and no currency field. Account selection is
 * therefore a product decision rather than a lookup; ./accounts.ts holds it.
 *   https://partner.tradovate.com/api/rest-api-endpoints/accounting/account-list
 */
export interface TradovateAccount {
  id: number;
  name: string;
  userId: number;
  accountType: 'Customer' | 'Employee' | 'Giveup' | 'House' | 'Omnibus' | 'Wash';
  active?: boolean;
  closed?: boolean;
  restricted?: boolean;
  readonly?: boolean;
  futuresDisabled?: boolean;
}

/**
 * A contract. GET /v1/contract/item?id=…
 *
 * Read for `productId`, the step towards a value per point.
 *   https://partner.tradovate.com/api/rest-api-endpoints/contract-library/contract-item
 */
export interface TradovateContract {
  id: number;
  name: string;
  productId: number;
}

/**
 * A product. GET /v1/product/item?id=…
 *
 * The two fields that decide whether a round trip can be priced at all:
 *
 * - `valuePerPoint` — what one point of price movement is worth. Without it
 *   `(sellPrice − buyPrice) × qty` is a number of points, not money, and
 *   comparing it to a dollar threshold is the unit bug the rule context
 *   module's header records having already been made once.
 * - `currencyId` — resolved against /currency/list. REF-99 made every amount
 *   in this product US dollars, so a product denominated in anything else
 *   cannot be added to that total. Checked rather than assumed: no endpoint
 *   states that an account's realised P&L is in USD.
 *   https://partner.tradovate.com/api/rest-api-endpoints/contract-library/product-item
 */
export interface TradovateProduct {
  id: number;
  name: string;
  currencyId: number;
  valuePerPoint?: number;
  priceFormatType?: string;
  tickSize?: number;
}

/**
 * A currency. GET /v1/currency/list.
 *
 * `name` is the ISO code ('USD'). The only place in the API where a numeric
 * currencyId can be turned into something a person — or a threshold — can
 * compare.
 *   https://partner.tradovate.com/api/rest-api-endpoints/contract-library/currency-list
 */
export interface TradovateCurrency {
  id: number;
  name: string;
}

/**
 * Tradovate integration.
 *
 * SERVER ONLY. Never import this from a client component; it reads the
 * Tradovate password and API secret from the environment.
 *
 * Scope: authentication, token lifecycle, an authenticated request helper, and
 * — since REF-90 — reading a connected user's closed trades for the day.
 * Read-only by design: there is no order entry or trade management here, and
 * adding one should be a deliberate decision rather than a side effect of
 * needing a POST.
 *
 * Market data is deliberately absent: the Market Data WebSocket requires CME
 * sub-vendor registration, which Reflect does not have. Everything the app
 * needs (fills, positions, order status) comes over REST and the main
 * WebSocket instead.
 *
 * Usage:
 *
 *   import { tradovateGet } from '@/lib/tradovate';
 *   const accounts = await tradovateGet<Account[]>('/account/list');
 */

export { loadConfig, describeConfigError, TRADOVATE_ENV_VARS } from './config';
export type { ConfigFailure, ConfigResult, TradovateEnvVar } from './config';

export {
  loadOAuthConfig,
  TRADOVATE_OAUTH_ENV_VARS,
  TRADOVATE_OAUTH_OPTIONAL_ENV_VARS,
} from './oauth-config';
export type {
  OAuthConfigResult,
  TradovateOAuthConfig,
  TradovateOAuthEnvVar,
} from './oauth-config';

export { requestAccessToken, renewAccessToken, snapshotFromResponse } from './auth';

export { getAccessToken, peekToken, clearToken, timeUntilExpiry } from './session';

export { tradovateRequest, tradovateGet } from './client';
export type {
  AppSessionRequestOptions,
  RequestOptions,
  UserTokenRequestOptions,
} from './client';

export {
  TradovateError,
  TradovateConfigError,
  TradovateAuthError,
  TradovatePenaltyError,
  TradovateRequestError,
  TradovateOAuthError,
  TradovateNotConnectedError,
  TradovateTransientError,
  TradovateUnpriceableError,
} from './errors';

// --- OAuth: connecting an end user's Tradovate account ----------------------
//
// Read-only, like the rest of this module. The flow is driven by the routes
// under src/app/api/tradovate/; what follows is what they and any future
// execution-import job need.
//
// Note what is NOT exported: token-crypto.ts. Encryption and decryption stay
// private to ./connections.ts, which is the only module that should hold a raw
// token alongside the key.

export {
  ACCESS_DENIED,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  exchangeRefreshToken,
  fetchTradovateUser,
} from './oauth';
export type { ExchangedToken } from './oauth';

export {
  getUserAccessToken,
  getUserTradingApi,
  getConnectionSummary,
  saveConnection,
  disconnectUser,
  forgetCachedToken,
  clearAllCachedTokens,
  redeemRefreshToken,
  listConnectionsDueForRefresh,
} from './connections';
export type {
  ConnectionStatus,
  ConnectionSummary,
  RefreshRedemption,
  StoredConnection,
  UserTradingApi,
} from './connections';

// The day pull (REF-90) — the first thing here that reads trading data rather
// than authenticating. Driven by src/app/api/tradovate/today/route.ts; see
// src/lib/rules/brokerDayContext.ts for how its answer reaches the rules.
export { loadBrokerDay } from './fills';
export type {
  BrokerDayContext,
  BrokerDayRequest,
  BrokerDayResult,
  DayPullCounts,
  TradovateReader,
} from './fills';

// Owned OR permitted (REF-90 Stage 2). `permittedAccountIds` is the only thing
// that reads the TradingPermission entity, and a set of ids is all it returns —
// see the PII note in ./accounts.ts.
export {
  partitionAccounts,
  permissionsCouldHelp,
  permittedAccountIds,
  selectTradingAccounts,
} from './accounts';
export type { AccountFilterCounts } from './accounts';

export { closedToday, minutesSince, parseDayStart, DAY_START_PARAM } from './trading-day';
export type { DayStartParse } from './trading-day';

// The keep-alive loop (REF-100). The cron route is its only caller in the app;
// scripts/tradovate-refresh-check.ts drives it against a stubbed client.
export { runKeepAlive, KEEPALIVE_WINDOW_MS } from './keepalive';
export type { KeepAliveCounts } from './keepalive';

export {
  isAllowlistConfigured,
  isUserAllowed,
  parseAllowlist,
  TRADOVATE_ALLOWLIST_ENV_VAR,
} from './allowlist';

export { readApiHosts, readHostname, resolveTradingApiUrl } from './api-hosts';
export type { ResolvedApiUrl } from './api-hosts';

export {
  AUTHORIZE_URLS,
  LIVE_API_URL,
  TOKEN_URLS,
  TOKEN_URLS_ALTERNATIVE,
  TOKEN_URL_SOURCE,
  TRADING_API_URLS,
  detectEnvironment,
} from './hosts';
export type { TradovateEnvironment } from './hosts';

export { redactSecrets, redactUrl } from './redact';

export { isPenaltyResponse } from './types';
export type {
  AccessTokenRequestBody,
  AccessTokenResponse,
  OAuthTokenResponse,
  PenaltyResponse,
  TokenSnapshot,
  TradovateMeResponse,
  TradovateConfig,
  UserTokenSnapshot,
  TradovateAccount,
  TradovateContract,
  TradovateCurrency,
  TradovateFill,
  TradovateFillPair,
  TradovatePosition,
  TradovateProduct,
  TradovateTradeDate,
  TradovateTradingPermission,
} from './types';

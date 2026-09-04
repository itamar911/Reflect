/**
 * Tradovate integration — authentication groundwork.
 *
 * SERVER ONLY. Never import this from a client component; it reads the
 * Tradovate password and API secret from the environment.
 *
 * Scope: authentication, token lifecycle, and an authenticated request helper.
 * Read-only by design — there is no order entry or trade management here.
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
export type { RequestOptions } from './client';

export {
  TradovateError,
  TradovateConfigError,
  TradovateAuthError,
  TradovatePenaltyError,
  TradovateRequestError,
  TradovateOAuthError,
  TradovateNotConnectedError,
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

export { ACCESS_DENIED, buildAuthorizeUrl, exchangeCodeForToken, fetchTradovateUser } from './oauth';
export type { ExchangedToken } from './oauth';

export {
  getUserAccessToken,
  getConnectionSummary,
  saveConnection,
  disconnectUser,
  forgetCachedToken,
  clearAllCachedTokens,
} from './connections';
export type { ConnectionStatus, ConnectionSummary } from './connections';

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
} from './types';

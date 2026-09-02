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
export type { ConfigResult, TradovateEnvVar } from './config';

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
} from './errors';

export { isPenaltyResponse } from './types';
export type {
  AccessTokenRequestBody,
  AccessTokenResponse,
  PenaltyResponse,
  TokenSnapshot,
  TradovateConfig,
} from './types';

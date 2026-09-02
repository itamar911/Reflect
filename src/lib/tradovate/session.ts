/**
 * Token lifecycle: one cached token, renewed before it lapses.
 *
 * SERVER ONLY — see ./config.ts.
 *
 * Design notes, because the constraints here are not obvious:
 *
 * 1. **One token, not one per caller.** Tradovate allows two concurrent
 *    sessions per user. Authenticating per request would blow through that cap
 *    and start returning 408/429/500 on the tokens it silently evicted. So the
 *    token is module-level state and every caller shares it.
 *
 * 2. **Renew ahead of expiry, never on failure.** Tradovate's guidance is to
 *    renew about 15 minutes before `expirationTime`. Reacting to a 401 instead
 *    would mean at least one failed request per cycle, and under concurrency a
 *    burst of them.
 *
 * 3. **Single-flight.** Concurrent callers arriving on a cold or stale cache
 *    share one in-flight promise. Without this, ten parallel requests would
 *    fire ten authentications and trip the session cap immediately.
 *
 * 4. **Never trust a hardcoded TTL.** Tradovate's own docs disagree about
 *    whether tokens last 80 or 90 minutes, so expiry comes from
 *    `expirationTime` on the response and nowhere else.
 *
 * The cache is per-process and in memory. On Vercel that means per lambda
 * instance: a cold start re-authenticates. That is acceptable for read-only
 * groundwork but will need revisiting — a shared store — if the number of
 * concurrent instances ever approaches the session cap.
 */

import { renewAccessToken, requestAccessToken, snapshotFromResponse } from './auth';
import { describeConfigError, loadConfig } from './config';
import { TradovateConfigError } from './errors';
import type { TokenSnapshot, TradovateConfig } from './types';

/** Renew once the token is within this window of expiring. */
const RENEW_MARGIN_MS = 15 * 60_000;

/**
 * Treat a token as unusable this close to expiry even for an immediate request,
 * so we never hand out one that dies in flight.
 */
const MIN_REMAINING_MS = 30_000;

let cached: TokenSnapshot | null = null;
let inFlight: Promise<TokenSnapshot> | null = null;

function resolveConfig(override?: TradovateConfig): TradovateConfig {
  if (override) return override;
  const result = loadConfig();
  if (!result.ok) {
    throw new TradovateConfigError(describeConfigError(result), [
      ...result.missing,
      ...result.invalid.map((i) => i.name),
    ]);
  }
  return result.config;
}

function needsRenewal(token: TokenSnapshot, now: number): boolean {
  return token.expiresAt - now <= RENEW_MARGIN_MS;
}

function isUsable(token: TokenSnapshot, now: number): boolean {
  return token.expiresAt - now > MIN_REMAINING_MS;
}

/**
 * Obtain a valid access token, authenticating or renewing as needed.
 *
 * Renewal failure falls back to a full authentication: a session can be closed
 * out from under us (the two-session cap), and when that happens renewal fails
 * but a fresh authentication succeeds.
 */
export async function getAccessToken(options: { config?: TradovateConfig } = {}): Promise<TokenSnapshot> {
  const now = Date.now();

  if (cached && !needsRenewal(cached, now)) return cached;
  if (inFlight) return inFlight;

  const config = resolveConfig(options.config);
  const previous = cached;

  inFlight = (async (): Promise<TokenSnapshot> => {
    // Renew when we hold a token that is still alive; that keeps the session.
    if (previous && isUsable(previous, Date.now())) {
      try {
        const renewed = await renewAccessToken(config, previous.accessToken);
        // Renewal omits mdAccessToken; carry the original forward so the shape
        // stays stable for any caller that reads it.
        return snapshotFromResponse({ ...renewed, mdAccessToken: previous.mdAccessToken });
      } catch {
        // Fall through to a full authentication.
      }
    }
    return snapshotFromResponse(await requestAccessToken(config));
  })();

  try {
    cached = await inFlight;
    return cached;
  } finally {
    inFlight = null;
  }
}

/** The cached token without triggering a network call, if one is held. */
export function peekToken(): TokenSnapshot | null {
  return cached;
}

/**
 * Drop the cached token. Call after a 401 so the next request re-authenticates;
 * also used by tests. Does not close the Tradovate session.
 */
export function clearToken(): void {
  cached = null;
  inFlight = null;
}

/** Milliseconds until the cached token expires, or null when none is held. */
export function timeUntilExpiry(now: number = Date.now()): number | null {
  return cached ? cached.expiresAt - now : null;
}

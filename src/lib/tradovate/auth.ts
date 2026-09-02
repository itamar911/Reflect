/**
 * Tradovate authentication.
 *
 * SERVER ONLY — see ./config.ts.
 *
 * Two operations, both from https://api.tradovate.com/:
 *
 *   POST /auth/accesstokenrequest   full authentication; opens a new session
 *   GET  /auth/renewaccesstoken     extends the current session in place
 *
 * Prefer renewal. A user is limited to **two concurrent sessions**; opening a
 * third silently closes the oldest, after which the orphaned token starts
 * throwing 408/429/500. Renewal, per Tradovate's docs, "extends the current
 * session without creating a new one" — which is why ./session.ts renews on a
 * timer instead of re-authenticating whenever a token looks stale.
 */

import {
  TradovateAuthError,
  TradovatePenaltyError,
  TradovateRequestError,
} from './errors';
import {
  isPenaltyResponse,
  type AccessTokenRequestBody,
  type AccessTokenResponse,
  type PenaltyResponse,
  type TradovateConfig,
  type TokenSnapshot,
} from './types';

/**
 * How many times to sit out a time penalty before giving up. Tradovate's limits
 * are deliberately variable, so this is a budget rather than a guarantee.
 */
const MAX_PENALTY_RETRIES = 3;

/** Upper bound on a single penalty wait, so a bad `p-time` cannot hang a request. */
const MAX_PENALTY_WAIT_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toSnapshot(response: AccessTokenResponse): TokenSnapshot {
  const expiresAt = Date.parse(response.expirationTime);
  if (Number.isNaN(expiresAt)) {
    // Without a parsable expiry we cannot schedule renewal, and a token we
    // cannot renew will lapse mid-flight. Refuse it rather than guess a TTL.
    throw new TradovateRequestError(
      '/auth',
      200,
      `unparsable expirationTime: ${JSON.stringify(response.expirationTime)}`
    );
  }
  return {
    accessToken: response.accessToken,
    mdAccessToken: response.mdAccessToken,
    userId: response.userId,
    expiresAt,
    expirationTime: response.expirationTime,
    name: response.name,
    userStatus: response.userStatus,
  };
}

/**
 * Decide what a penalty response means and how long to wait.
 *
 * Tradovate signals rate limiting in the *body*, not the status code: an
 * over-limit request comes back looking ordinary but carrying `p-ticket` and
 * `p-time` instead of the payload. `p-captcha` means a third-party application
 * cannot proceed at all.
 */
function readPenalty(body: PenaltyResponse): { waitMs: number; ticket?: string; captcha: boolean } {
  const captcha = Boolean(body['p-captcha']);
  const seconds = typeof body['p-time'] === 'number' ? body['p-time'] : 1;
  return {
    waitMs: Math.min(Math.max(seconds, 0) * 1000, MAX_PENALTY_WAIT_MS),
    ticket: typeof body['p-ticket'] === 'string' ? body['p-ticket'] : undefined,
    captcha,
  };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  return { status: res.status, text: await res.text() };
}

/**
 * Authenticate against Tradovate and return the parsed response.
 *
 * Opens a new session — see the two-session cap above. Callers that just want a
 * usable token should go through {@link getAccessToken} in ./session.ts rather
 * than calling this directly.
 *
 * Time penalties are absorbed here: the call waits `p-time` seconds and retries
 * with the `p-ticket`, up to {@link MAX_PENALTY_RETRIES} times.
 */
export async function requestAccessToken(config: TradovateConfig): Promise<AccessTokenResponse> {
  const url = `${config.apiUrl}/auth/accesstokenrequest`;

  const body: AccessTokenRequestBody = {
    name: config.username,
    password: config.password,
    appId: config.appId,
    appVersion: config.appVersion,
    cid: config.cid,
    sec: config.sec,
    deviceId: config.deviceId,
  };

  for (let attempt = 0; attempt <= MAX_PENALTY_RETRIES; attempt++) {
    const { status, text } = await postJson(url, body);

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new TradovateRequestError('/auth/accesstokenrequest', status, text);
    }

    if (status < 200 || status >= 300) {
      throw new TradovateRequestError('/auth/accesstokenrequest', status, text);
    }

    // Checked before the success path: a penalty arrives with a 200 status and
    // no accessToken, so treating it as success would yield `undefined` later.
    if (isPenaltyResponse(parsed)) {
      const { waitMs, ticket, captcha } = readPenalty(parsed);

      if (captcha) {
        throw new TradovatePenaltyError(
          'Tradovate returned a captcha challenge (p-captcha). A third-party application ' +
            'cannot complete it; wait about an hour before authenticating again.',
          { captcha: true }
        );
      }
      if (attempt === MAX_PENALTY_RETRIES) {
        throw new TradovatePenaltyError(
          `Rate limited by Tradovate after ${MAX_PENALTY_RETRIES} retries ` +
            `(last wait ${waitMs / 1000}s). Back off and try again later.`,
          { retryAfterSeconds: waitMs / 1000 }
        );
      }

      // Retry carries the ticket alongside the original fields, per the docs.
      if (ticket) body['p-ticket'] = ticket;
      await sleep(waitMs);
      continue;
    }

    const response = parsed as AccessTokenResponse;

    // Bad credentials also come back as HTTP 200, with errorText set.
    if (response.errorText) throw new TradovateAuthError(response.errorText);

    if (!response.accessToken || !response.expirationTime) {
      throw new TradovateRequestError(
        '/auth/accesstokenrequest',
        status,
        `response had no accessToken/expirationTime: ${text.slice(0, 300)}`
      );
    }

    return response;
  }

  // Unreachable: the loop either returns or throws.
  throw new TradovatePenaltyError('Exhausted authentication retries.');
}

/**
 * Extend the current session. Returns the same shape as authentication minus
 * `mdAccessToken` — renewal does not reissue the market-data token, which does
 * not affect us because we never use it.
 */
export async function renewAccessToken(
  config: TradovateConfig,
  accessToken: string
): Promise<AccessTokenResponse> {
  const url = `${config.apiUrl}/auth/renewaccesstoken`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const text = await res.text();

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new TradovateRequestError('/auth/renewaccesstoken', res.status, text);
  }

  if (!res.ok) throw new TradovateRequestError('/auth/renewaccesstoken', res.status, text);

  if (isPenaltyResponse(parsed)) {
    const { waitMs, captcha } = readPenalty(parsed);
    throw new TradovatePenaltyError(
      captcha
        ? 'Tradovate returned a captcha challenge while renewing the token.'
        : `Rate limited while renewing the token; retry in ${waitMs / 1000}s.`,
      { retryAfterSeconds: waitMs / 1000, captcha }
    );
  }

  const response = parsed as AccessTokenResponse;
  if (response.errorText) throw new TradovateAuthError(response.errorText);
  if (!response.accessToken || !response.expirationTime) {
    throw new TradovateRequestError(
      '/auth/renewaccesstoken',
      res.status,
      `response had no accessToken/expirationTime: ${text.slice(0, 300)}`
    );
  }
  return response;
}

/** Parse an auth response into the snapshot the session cache stores. */
export function snapshotFromResponse(response: AccessTokenResponse): TokenSnapshot {
  return toSnapshot(response);
}

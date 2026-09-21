/**
 * The Tradovate OAuth network layer: build the authorization URL, exchange the
 * code, and identify whose token we got.
 *
 * SERVER ONLY — see ./config.ts.
 *
 * READ-ONLY SCOPE. This connects an account so Reflect can read that user's
 * executions. Tradovate's OAuth has no scope parameter to narrow with, so the
 * restriction is ours to keep: nothing in this integration places, modifies or
 * cancels an order, and adding that should be a deliberate decision rather than
 * a side effect of needing a POST.
 *
 * Every response body here either is a token or can echo an authorization code,
 * so nothing reaches an Error without going through redactSecrets() first.
 * Nothing in this module logs.
 */

import { tradovateGet } from './client';
import { TradovateOAuthError, TradovatePenaltyError, TradovateRequestError } from './errors';
// PHASE 2 DIAGNOSTICS — remove with ./phase2-diagnostics.ts.
import { describeJsonShape, type JsonShape } from './phase2-diagnostics';
import { redactSecrets } from './redact';
import {
  isPenaltyResponse,
  type OAuthTokenResponse,
  type TradovateMeResponse,
} from './types';
import type { TradovateOAuthConfig } from './oauth-config';

/**
 * The OAuth error code Tradovate returns when the user declines on the consent
 * screen. A normal outcome, not a failure — the callback route treats it as
 * such.
 */
export const ACCESS_DENIED = 'access_denied';

/**
 * Build the URL to send the user to.
 *
 * Only the three parameters Tradovate's guide documents, plus `state`. No
 * `scope`: Tradovate does not define one, and inventing a value risks the
 * authorization server rejecting the request outright.
 */
export function buildAuthorizeUrl(config: TradovateOAuthConfig, state: string): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export interface ExchangedToken {
  accessToken: string;
  /** Epoch milliseconds, computed from `expires_in` at the moment of exchange. */
  expiresAt: number;
  /** Present only if Tradovate ever starts issuing one. */
  refreshToken?: string;
  /** Seconds, as returned. A lifetime, not a credential. */
  expiresIn: number;
  /**
   * PHASE 2 DIAGNOSTICS — remove with ./phase2-diagnostics.ts.
   * Top-level field names and JSON types of the token response. No values.
   */
  diagnostics?: JsonShape;
}

/**
 * Exchange an authorization code for an access token.
 *
 * Form-encoded, not JSON — Tradovate's guide posts `form` fields, and the
 * endpoint rejects a JSON body. The code is single-use: a retry with the same
 * code fails with `invalid_grant`, so there is deliberately no retry here beyond
 * the rate-limit wait the shared helpers already do.
 */
export async function exchangeCodeForToken(
  config: TradovateOAuthConfig,
  code: string,
  signal?: AbortSignal
): Promise<ExchangedToken> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
  });

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
    cache: 'no-store',
    signal,
  });

  const text = await res.text();
  // From here on `text` may contain a token or the code. Anything derived from
  // it that could escape this function is redacted first. The code is passed in
  // explicitly because Tradovate echoes it inside free-form error prose, where
  // no key=value pattern would catch it.
  const safe = (value: string) => redactSecrets(value, [code]).slice(0, 300);
  const safeText = () => safe(text);

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new TradovateRequestError('/auth/oauthtoken', res.status, safeText());
  }

  // Same trap as everywhere else in this API: a rate-limit penalty arrives with
  // an ordinary status code and the payload replaced.
  if (isPenaltyResponse(parsed)) {
    const p = parsed as Record<string, unknown>;
    const seconds = typeof p['p-time'] === 'number' ? p['p-time'] : undefined;
    throw new TradovatePenaltyError(
      p['p-captcha']
        ? 'Tradovate returned a captcha challenge during the OAuth code exchange; wait about an hour.'
        : `Rate limited during the OAuth code exchange${seconds ? `; retry in ${seconds}s` : ''}.`,
      { retryAfterSeconds: seconds, captcha: Boolean(p['p-captcha']) }
    );
  }

  const body = (parsed ?? {}) as OAuthTokenResponse;

  // Checked before res.ok: Tradovate reports OAuth failures in the body, and the
  // `error` code is more useful to the caller than the status.
  if (body.error) {
    throw new TradovateOAuthError(
      `Tradovate rejected the code exchange (${body.error}): ` +
        `${safe(body.error_description ?? 'no description')}`,
      { stage: 'exchange', oauthError: body.error }
    );
  }

  if (!res.ok) throw new TradovateRequestError('/auth/oauthtoken', res.status, safeText());

  if (!body.access_token) {
    throw new TradovateOAuthError(
      `Tradovate returned no access_token from the code exchange (HTTP ${res.status}).`,
      { stage: 'exchange' }
    );
  }

  // A missing or nonsensical expires_in would leave us unable to schedule
  // renewal, and a token we cannot renew lapses mid-request. Refuse it rather
  // than invent a lifetime — the same rule ./auth.ts applies to expirationTime.
  if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
    throw new TradovateOAuthError(
      `Tradovate returned an unusable expires_in (${JSON.stringify(body.expires_in)}); ` +
        'refusing a token we cannot schedule renewal for.',
      { stage: 'exchange' }
    );
  }

  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    // PHASE 2 DIAGNOSTICS — remove this line with ./phase2-diagnostics.ts.
    diagnostics: describeJsonShape(parsed),
  };
}

/**
 * Identify the Tradovate user a freshly exchanged token belongs to.
 *
 * Called once per connection so `tradovate_user_id` can be stored without the
 * token — that id is what the UI shows to say which account is linked.
 *
 * ALWAYS AGAINST THE LIVE HOST, whatever environment the connection targets:
 *
 *   "Environments: Live"
 *   "This endpoint operates against Live. On Demo it returns an error
 *    indicating the request must be sent to the Live server."
 *   — https://docs.ninjatrader.com/api/rest-api-endpoints/authentication/me
 *
 * This previously used config.apiUrl, which meant every Demo connection failed
 * identification. config.liveApiUrl resolves to the Live host on Demo and to
 * the same host as apiUrl on Live.
 *
 * Rate limit is 10 requests per hour, counting failed requests only, so a run
 * of failed connects burns the budget while successful ones do not. One call
 * per connection, no retry.
 *
 * Only `userId` is stored. The response also carries `email`, `fullName` and
 * `organizationName`; none of it is read, kept, or logged.
 */
export async function fetchTradovateUser(
  config: TradovateOAuthConfig,
  accessToken: string,
  signal?: AbortSignal
): Promise<TradovateMeResponse> {
  const me = await tradovateGet<TradovateMeResponse>('/auth/me', undefined, {
    apiUrl: config.liveApiUrl,
    accessToken,
    signal,
  });

  if (typeof me?.userId !== 'number') {
    throw new TradovateOAuthError('Tradovate /auth/me returned no userId for the new token.', {
      stage: 'identify',
    });
  }
  return me;
}

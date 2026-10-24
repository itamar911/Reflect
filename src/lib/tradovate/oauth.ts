/**
 * The Tradovate OAuth network layer: build the authorization URL, redeem a grant
 * at the token endpoint, and identify whose token we got.
 *
 * Two grants, both through {@link postTokenGrant}: `authorization_code` when a
 * user connects, and `refresh_token` to keep that connection alive without
 * making them reconnect (REF-100). Neither stores anything — this module is the
 * network boundary, and ./connections.ts owns the database and the encryption.
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

import { readApiHosts } from './api-hosts';
import { tradovateGet } from './client';
import { TradovateOAuthError, TradovatePenaltyError, TradovateRequestError } from './errors';
import { redactSecrets } from './redact';
import {
  isPenaltyResponse,
  type OAuthTokenResponse,
  type TradovateApiHosts,
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
  /**
   * Epoch milliseconds, computed from `expires_in` at the moment of exchange.
   *
   * Arithmetic on our own clock, because the exchange states no absolute time —
   * only a number of seconds. Renewal does state one (`expirationTime`), and
   * ./connections.ts stores that verbatim rather than recomputing from it.
   */
  expiresAt: number;
  /**
   * The refresh token.
   *
   * Observed in production: the exchange DOES issue one, together with
   * `refresh_token_expires_in`, despite the OAuth guide never mentioning
   * either. Still optional, because nothing documents it as guaranteed and a
   * response without one must not be rejected.
   */
  refreshToken?: string;
  /** Seconds, as returned. A lifetime, not a credential. */
  expiresIn: number;
  /**
   * Epoch milliseconds, from `refresh_token_expires_in`.
   *
   * This is the value that decides how long a user may be away before they
   * have to re-authorize, so it is product-visible rather than bookkeeping.
   * Absent when the response carried no usable number; unlike `expires_in`
   * that is not fatal, because nothing schedules work off it.
   */
  refreshExpiresAt?: number;
  /** `token_type`, as returned. Expected "Bearer"; kept so a change is visible. */
  tokenType?: string;
  /**
   * This user's API hosts, as the exchange returned them.
   *
   * The reason there is no "renew once at connect just to learn the hosts"
   * step: they arrive with the token. Absent when the response carried none,
   * which the dynamic-hosts page says happens on an error response and on a
   * multi-factor step — ./api-hosts.ts falls back to the documented shared
   * hosts for those, and for every row written before this field existed.
   */
  apiHosts?: TradovateApiHosts;
}

/**
 * POST a grant to /auth/oauthtoken and return a validated token.
 *
 * Shared by the two grants this integration uses — `authorization_code` at
 * connect time and `refresh_token` on the keep-alive path — because every rule
 * below is a property of the endpoint rather than of either grant: it rejects a
 * JSON body, it reports failures in the body rather than the status, it can
 * answer with a rate-limit penalty under an ordinary 2xx, and its response is
 * itself a credential.
 *
 * `grantSecret` is the single-use value being redeemed (the authorization code,
 * or the refresh token). It is passed to redactSecrets() as a literal because
 * Tradovate echoes grant values back inside free-form `error_description` prose,
 * where no key=value pattern would catch them.
 *
 * `grantLabel` names the operation in every thrown message, so a log line says
 * which of the two failed without the caller having to wrap and re-throw.
 */
async function postTokenGrant(params: {
  config: TradovateOAuthConfig;
  form: URLSearchParams;
  grantSecret: string;
  grantLabel: 'code exchange' | 'refresh grant';
  signal?: AbortSignal;
}): Promise<{ body: OAuthTokenResponse; parsed: unknown; expiresIn: number }> {
  const { config, form, grantSecret, grantLabel, signal } = params;

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
  // From here on `text` may contain a token or the grant value. Anything derived
  // from it that could escape this function is redacted first.
  const safe = (value: string) => redactSecrets(value, [grantSecret]).slice(0, 300);
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
        ? `Tradovate returned a captcha challenge during the OAuth ${grantLabel}; wait about an hour.`
        : `Rate limited during the OAuth ${grantLabel}${seconds ? `; retry in ${seconds}s` : ''}.`,
      { retryAfterSeconds: seconds, captcha: Boolean(p['p-captcha']) }
    );
  }

  const body = (parsed ?? {}) as OAuthTokenResponse;

  // Checked before res.ok: Tradovate reports OAuth failures in the body, and the
  // `error` code is more useful to the caller than the status. On the refresh
  // grant this is also the branch that carries `invalid_grant`, which is the one
  // verdict that licenses marking a connection expired — see
  // classifyRenewalFailure() in ./connections.ts.
  if (body.error) {
    throw new TradovateOAuthError(
      `Tradovate rejected the ${grantLabel} (${body.error}): ` +
        `${safe(body.error_description ?? 'no description')}`,
      { stage: 'exchange', oauthError: body.error }
    );
  }

  if (!res.ok) throw new TradovateRequestError('/auth/oauthtoken', res.status, safeText());

  if (!body.access_token) {
    throw new TradovateOAuthError(
      `Tradovate returned no access_token from the ${grantLabel} (HTTP ${res.status}).`,
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

  return { body, parsed, expiresIn: body.expires_in };
}

/**
 * Turn a validated /auth/oauthtoken body into an {@link ExchangedToken}.
 *
 * `refresh_token_expires_in` is seconds, like `expires_in`, and is turned into
 * an instant here for the same reason: the column is a timestamptz, and the
 * clock reading that makes the number mean anything is this one. Deliberately
 * not validated the way `expires_in` is — a missing or nonsensical refresh
 * lifetime costs us a stored date, not a token we cannot schedule renewal for,
 * so it is dropped rather than made fatal.
 */
function toExchangedToken(body: OAuthTokenResponse, parsed: unknown, expiresIn: number): ExchangedToken {
  const refreshLifetime = body.refresh_token_expires_in;
  const refreshExpiresAt =
    typeof refreshLifetime === 'number' && Number.isFinite(refreshLifetime) && refreshLifetime > 0
      ? Date.now() + refreshLifetime * 1000
      : undefined;

  return {
    accessToken: body.access_token!,
    expiresAt: Date.now() + expiresIn * 1000,
    refreshToken: body.refresh_token,
    expiresIn,
    refreshExpiresAt,
    tokenType: body.token_type,
    // From `parsed`, not `body`: readApiHosts() checks that the field really
    // is an object instead of trusting the cast above, and the cast is the
    // reason this field went unnoticed until it was measured.
    apiHosts: readApiHosts(parsed),
  };
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
  const { body, parsed, expiresIn } = await postTokenGrant({
    config,
    form: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
    }),
    grantSecret: code,
    grantLabel: 'code exchange',
    signal,
  });

  return toExchangedToken(body, parsed, expiresIn);
}

/**
 * Redeem a refresh token for a new access token — the network half of REF-100.
 *
 * MEASURED IN PRODUCTION, 13 Oct 2026, and this is why the keep-alive is built
 * on it rather than on GET /auth/renewaccesstoken alone:
 *
 *   - It answers 200 with a new access token (`expires_in` 4800) AND a new
 *     refresh token (`refresh_token_expires_in` 93600 — 26 hours).
 *   - THE REFRESH TOKEN ROTATES. The value sent is spent; the response carries
 *     its replacement. That is what makes the storage half a compare-and-swap
 *     rather than an upsert — see redeemRefreshToken() in ./connections.ts.
 *   - The PREVIOUS access token keeps working afterwards, so the grant did not
 *     open a second session. That was the blocking question: a new session
 *     counts against Tradovate's two-concurrent-session cap and would evict the
 *     user's own trading terminal mid-trade.
 *
 * No `redirect_uri`: it is a parameter of the authorization-code grant and this
 * one does not carry it. Everything else — field names, content type, the error
 * shapes — is the same endpoint, so this goes through the same helper.
 *
 * Throws, and the type of what it throws is the whole interface for the caller's
 * verdict: TradovateOAuthError carrying `invalid_grant` is a refusal of the
 * credential, while a penalty, a 5xx or a fetch failure says nothing about it.
 */
export async function exchangeRefreshToken(
  config: TradovateOAuthConfig,
  refreshToken: string,
  signal?: AbortSignal
): Promise<ExchangedToken> {
  const { body, parsed, expiresIn } = await postTokenGrant({
    config,
    form: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }),
    grantSecret: refreshToken,
    grantLabel: 'refresh grant',
    signal,
  });

  return toExchangedToken(body, parsed, expiresIn);
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
 *
 * `reflectUserId` IS THE SIGNED-IN REFLECT USER AND NOT TRADOVATE'S (REF-112
 * §4.5 item 1). It is here because `UserTokenRequestOptions.userId` is required
 * — every per-user Tradovate request has to say whose behalf it is on, so that
 * ./call-meter.ts can count it — and this is the one call site where that fact
 * was not already in hand. The caller has it from the session, and the callback
 * route verifies a state cookie bound to exactly this id before reaching here.
 *
 * IT IS THE ONLY PARAMETER THIS FUNCTION GREW, AND IT IS NOT SENT ANYWHERE. The
 * request is byte-identical: `/auth/me` takes no arguments, and the id reaches
 * the meter and nothing else. Note the collision of names this function now
 * holds on purpose — `reflectUserId` is a Supabase uuid and
 * `TradovateMeResponse.userId` is Tradovate's integer, and the second is the
 * one that gets stored.
 */
export async function fetchTradovateUser(
  config: TradovateOAuthConfig,
  accessToken: string,
  reflectUserId: string,
  signal?: AbortSignal
): Promise<TradovateMeResponse> {
  const me = await tradovateGet<TradovateMeResponse>('/auth/me', undefined, {
    apiUrl: config.liveApiUrl,
    accessToken,
    userId: reflectUserId,
    signal,
  });

  if (typeof me?.userId !== 'number') {
    throw new TradovateOAuthError('Tradovate /auth/me returned no userId for the new token.', {
      stage: 'identify',
    });
  }
  return me;
}

/**
 * Whether the broker has SAID this user has neither a live nor a funded
 * entitlement (REF-112 §5.17, item 5).
 *
 * THE FIRST READER THESE FLAGS HAVE EVER HAD. §5.17's finding is that
 * `hasLive`, `hasFunded`, `hasMarketData` and `hasSimPlus` are declared in
 * ./types.ts and read by nothing — so a user could complete the whole OAuth
 * flow with no live provisioning at all, and "connected but no live account"
 * was indistinguishable from "connected and flat" on every screen.
 *
 * `=== false` ON BOTH, AND NOTHING ELSE WILL DO. Three reasons, and they are
 * the whole of this function:
 *
 *   1. The fields are NOT in the published `/auth/me` schema (see
 *      {@link import('./types').TradovateMeResponse}). A host that does not
 *      send them leaves both `undefined`, and `!me.hasLive` would read that
 *      as a denial and tell every trader on such a host that their accounts
 *      are missing. Absence has to mean silence.
 *   2. The body is a plain cast like every other in this integration, so the
 *      string `"false"` is expressible on the wire and is not a denial — the
 *      same rule `readSyncResponse` applies to `ran`.
 *   3. BOTH, not either. A funded-only trader has `hasLive: false` and is
 *      exactly who this product is for; a live-only trader has
 *      `hasFunded: false`. Either one alone is an ordinary account.
 *
 * NOT A GATE. Nothing is refused on the strength of this: the connection is
 * saved, the tokens are stored, and the next pull finds whatever is there. It
 * decides one sentence, on one screen, once — which is the right weight for a
 * claim built on a field no schema promises.
 */
export function saysNoLiveEntitlement(me: TradovateMeResponse): boolean {
  return me.hasLive === false && me.hasFunded === false;
}

/**
 * OAuth state: CSRF protection for the connect/callback round trip.
 *
 * SERVER ONLY — see ./config.ts.
 *
 * The attack this stops: an attacker completes the Tradovate consent screen with
 * *their* account, holds on to the resulting callback URL, and gets a victim to
 * load it while signed in to Reflect. Without a state check, Reflect would store
 * the attacker's tokens against the victim's user id and the victim's journal
 * would silently fill with the attacker's executions.
 *
 * The state value is therefore bound to the session two ways at once:
 *
 *   1. It is issued into an httpOnly, SameSite=Lax cookie, so the callback can
 *      only be satisfied by the browser that started the flow.
 *   2. The cookie is signed and carries the Supabase user id, which the callback
 *      compares against the currently signed-in user. A cookie planted by a
 *      subdomain, or replayed after the user switched accounts, fails here.
 *
 * SameSite must be Lax rather than Strict: the callback is a top-level GET
 * navigation from tradovate.com, and Strict would withhold the cookie on exactly
 * that request, failing every legitimate flow.
 *
 * A caveat worth knowing: Tradovate's OAuth guide documents only response_type,
 * client_id and redirect_uri, and never mentions `state`. RFC 6749 requires an
 * authorization server to return the parameter unchanged, and Tradovate does,
 * but if a future change dropped it, this module's deliberate reject-on-absence
 * would fail every connection rather than fall back to no CSRF protection. That
 * is the correct trade, and the failure would be loud.
 */

import { createHmac, randomBytes } from 'node:crypto';

import { TradovateOAuthError } from './errors';
import { deriveSubkey, safeEqual } from './token-crypto';

/** Cookie holding the signed state. Scoped to the routes that use it. */
export const STATE_COOKIE_NAME = 'tv_oauth_state';

/** Path scope: the cookie is never sent to the rest of the app. */
export const STATE_COOKIE_PATH = '/api/tradovate';

/**
 * How long a started flow stays valid. Long enough to sign in to Tradovate and
 * read the consent screen, short enough that an abandoned flow cannot be
 * resurrected from a shared machine hours later.
 */
export const STATE_TTL_MS = 10 * 60_000;

/** 256 bits of randomness: not guessable, and cheap. */
const STATE_BYTES = 32;

const SIGNING_LABEL = 'tradovate-oauth-state-v1';

interface StatePayload {
  /** The state value echoed through Tradovate. */
  s: string;
  /** Supabase user id the flow was started by. */
  u: string;
  /** Issued-at, epoch milliseconds. */
  t: number;
}

function sign(body: string): string {
  const key = deriveSubkey(SIGNING_LABEL);
  return createHmac('sha256', key).update(body).digest('base64url');
}

export interface IssuedState {
  /** Put this in the authorization URL's `state` parameter. */
  state: string;
  /** Put this in the state cookie. */
  cookieValue: string;
}

/**
 * Mint a state value and the signed cookie that binds it to this user.
 *
 * The cookie carries the user id so the callback can reject a flow finished
 * under a different Reflect account; it is signed so that value cannot be
 * rewritten by anything that can set cookies on the domain.
 */
export function issueState(userId: string): IssuedState {
  const state = randomBytes(STATE_BYTES).toString('base64url');
  const payload: StatePayload = { s: state, u: userId, t: Date.now() };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { state, cookieValue: `${body}.${sign(body)}` };
}

/**
 * Validate a callback against the cookie issued by {@link issueState}.
 *
 * Throws TradovateOAuthError on any failure — absent state, absent cookie, bad
 * signature, expiry, wrong user, or mismatch. Absence is a rejection, not a
 * pass: an attacker who can strip a parameter would otherwise be able to strip
 * the whole defence.
 *
 * No part of the state, the cookie, or the signature appears in a thrown
 * message; the caller gets the reason, not the values.
 */
export function verifyState(params: {
  cookieValue: string | undefined;
  queryState: string | null | undefined;
  userId: string;
  now?: number;
}): void {
  const { cookieValue, queryState, userId, now = Date.now() } = params;

  if (!queryState) {
    throw new TradovateOAuthError(
      'Tradovate callback arrived without a state parameter; refusing it.',
      { stage: 'state' }
    );
  }
  if (!cookieValue) {
    throw new TradovateOAuthError(
      'No Tradovate OAuth state cookie on the callback — the flow was not started here, ' +
        'or it took longer than the cookie lifetime.',
      { stage: 'state' }
    );
  }

  const [body, signature] = cookieValue.split('.');
  if (!body || !signature || !safeEqual(signature, sign(body))) {
    throw new TradovateOAuthError('Tradovate OAuth state cookie failed its signature check.', {
      stage: 'state',
    });
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    throw new TradovateOAuthError('Tradovate OAuth state cookie is malformed.', { stage: 'state' });
  }

  if (typeof payload.t !== 'number' || now - payload.t > STATE_TTL_MS || payload.t > now + 60_000) {
    // The forward-dated check is not paranoia about clocks: it catches a cookie
    // whose timestamp was crafted to never expire.
    throw new TradovateOAuthError('Tradovate OAuth flow expired; start it again.', {
      stage: 'state',
    });
  }
  if (typeof payload.u !== 'string' || !safeEqual(payload.u, userId)) {
    throw new TradovateOAuthError(
      'Tradovate OAuth flow was started by a different Reflect account than the one now signed in.',
      { stage: 'state' }
    );
  }
  if (typeof payload.s !== 'string' || !safeEqual(payload.s, queryState)) {
    throw new TradovateOAuthError('Tradovate OAuth state mismatch; refusing the callback.', {
      stage: 'state',
    });
  }
}

/** Cookie attributes shared by the set and clear paths, so they cannot drift. */
export function stateCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: STATE_COOKIE_PATH,
  };
}

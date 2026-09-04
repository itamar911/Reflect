/**
 * GET /api/tradovate/callback — finish the Tradovate OAuth flow.
 *
 * Order of operations, and none of it is negotiable:
 *
 *   1. Require a signed-in Reflect user. The tokens are about to be bound to a
 *      user id, so there has to be one.
 *   2. Handle an explicit `error` from Tradovate. `access_denied` means the user
 *      said no on the consent screen — a normal outcome that gets a plain result
 *      page, not an error.
 *   3. Validate state BEFORE spending the code. A callback that fails the state
 *      check is not ours; exchanging its code first would mean doing work on an
 *      attacker's behalf and, worse, minting a token we might then store.
 *   4. Exchange, identify, encrypt, store.
 *
 * The state cookie is cleared on every path out of here, success or failure, so
 * a stale one cannot be replayed against a later callback.
 *
 * Logging: this handler receives an authorization code in the query string.
 * Neither the code nor the request URL is ever logged, and upstream response
 * bodies pass through redactSecrets() in ../../../lib/tradovate/oauth.ts before
 * they can reach an Error.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { describeConfigError } from '@/lib/tradovate/config';
import { saveConnection } from '@/lib/tradovate/connections';
import {
  TradovateOAuthError,
  TradovatePenaltyError,
} from '@/lib/tradovate/errors';
import { ACCESS_DENIED, exchangeCodeForToken, fetchTradovateUser } from '@/lib/tradovate/oauth';
import { loadOAuthConfig } from '@/lib/tradovate/oauth-config';
import {
  resultUrl,
  TradovateResult,
  type TradovateResultCode,
} from '@/lib/tradovate/oauth-results';
import { STATE_COOKIE_NAME, stateCookieOptions, verifyState } from '@/lib/tradovate/oauth-state';
import { redactSecrets } from '@/lib/tradovate/redact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const params = url.searchParams;

  // Cookie attributes must match the ones used to set it or the browser keeps
  // the original. `secure` is derived from the URL we were actually reached on,
  // which is the same origin the redirect URI points at.
  const secure = url.protocol === 'https:';

  const finish = (code: TradovateResultCode) => {
    const response = NextResponse.redirect(resultUrl(request, code));
    response.cookies.set(STATE_COOKIE_NAME, '', { ...stateCookieOptions(secure), maxAge: 0 });
    return response;
  };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.redirect(new URL('/login', request.url));

  // Step 2 — Tradovate said no before we spend anything. The user declining is
  // an outcome, not a failure: no error page, no console noise.
  const upstreamError = params.get('error');
  if (upstreamError) {
    return finish(upstreamError === ACCESS_DENIED ? TradovateResult.Denied : TradovateResult.Failed);
  }

  const config = loadOAuthConfig();
  if (!config.ok) {
    console.error(describeConfigError(config));
    return finish(TradovateResult.NotConfigured);
  }

  // Step 3 — state before code. Absence is a rejection, not a pass.
  try {
    verifyState({
      cookieValue: request.cookies.get(STATE_COOKIE_NAME)?.value,
      queryState: params.get('state'),
      userId: user.id,
    });
  } catch {
    // The thrown message names the reason but the response deliberately does
    // not: an attacker probing the state check learns nothing from the outcome.
    return finish(TradovateResult.StateInvalid);
  }

  const code = params.get('code');
  if (!code) return finish(TradovateResult.Failed);

  // Step 4 — from here on, `code` and everything derived from it is secret.
  try {
    const token = await exchangeCodeForToken(config.config, code);
    const me = await fetchTradovateUser(config.config, token.accessToken);

    await saveConnection({
      userId: user.id,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      tradovateUserId: me.userId,
    });

    return finish(TradovateResult.Connected);
  } catch (error) {
    if (error instanceof TradovatePenaltyError) return finish(TradovateResult.RateLimited);

    // A late access_denied — some servers report the refusal at the exchange
    // rather than on the redirect. Same normal outcome.
    if (error instanceof TradovateOAuthError && error.oauthError === ACCESS_DENIED) {
      return finish(TradovateResult.Denied);
    }

    // Only the message, never the error object — a fetch failure's `cause` can
    // carry the request it was made with. The message is redacted again on the
    // way out: exchangeCodeForToken() already scrubs what it builds, but an
    // error from a later step (/auth/me) carries an upstream body this handler
    // has not inspected, and that body holds the user's Tradovate email.
    console.error(
      '[tradovate] OAuth callback failed:',
      redactSecrets(error instanceof Error ? error.message : 'unknown error', [code])
    );
    return finish(TradovateResult.Failed);
  }
}

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
import { isAllowlistConfigured, isUserAllowed } from '@/lib/tradovate/allowlist';
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
// PHASE 2 DIAGNOSTICS — remove with lib/tradovate/phase2-diagnostics.ts.
import { formatShape, logPhase2, probeRenewal } from '@/lib/tradovate/phase2-diagnostics';
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

  // The allowlist gate, checked independently of /connect. A callback can be
  // replayed or hand-crafted, so the route that actually writes tokens does not
  // get to assume the route that starts the flow was ever involved. Placed
  // before the error branch and before state so that a blocked user cannot
  // learn anything about the flow's internals.
  if (!isUserAllowed(user.id)) {
    if (!isAllowlistConfigured()) {
      console.warn(
        '[tradovate] callback refused: TRADOVATE_OAUTH_ALLOWED_USER_IDS is unset or empty, ' +
          'so no user can connect. This is the fail-closed default.'
      );
    }
    return finish(TradovateResult.NotAvailable);
  }

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
      environment: config.config.environment,
    });

    // ========================================================================
    // PHASE 2 DIAGNOSTICS — DELETE THIS BLOCK WHEN THE PRODUCTION TEST PASSES
    //
    // Answers Q3, Q4 and Q8 from the migration plan; see
    // lib/tradovate/phase2-diagnostics.ts for what each one is and for the
    // rules about what may be logged. Only reachable by an allowlisted user,
    // because the gate above already returned for everyone else.
    //
    // Field NAMES and TYPES only, plus expires_in as a number and an HTTP
    // status. No token, no secret, no code, no header, no field value. Every
    // line goes through redactSecrets() inside logPhase2().
    // ========================================================================
    logPhase2('exchange environment', config.config.environment);
    logPhase2('exchange response fields', formatShape(token.diagnostics ?? {}));
    logPhase2('exchange expires_in (seconds)', String(token.expiresIn));

    try {
      const probe = await probeRenewal(config.config.apiUrl, token.accessToken);
      logPhase2('renewal HTTP status', String(probe.status));
      logPhase2('renewal response fields', formatShape(probe.shape));
      logPhase2('renewal apiHosts present', String(probe.hasApiHosts));
      logPhase2('renewal looked like a rate-limit penalty', String(probe.penalty));
      logPhase2('renewal returned usable credentials', String(Boolean(probe.renewed)));

      // Persist what renewal returned. The docs say renewal "returns a fresh
      // accessToken" but never say the presented token survives, so discarding
      // the result could leave a dead token in the row. Storing it is the safe
      // reading, and it keeps the connection usable after the probe.
      if (probe.renewed) {
        const renewedExpiry = Date.parse(probe.renewed.expirationTime);
        if (!Number.isNaN(renewedExpiry)) {
          await saveConnection({
            userId: user.id,
            accessToken: probe.renewed.accessToken,
            expiresAt: renewedExpiry,
            tradovateUserId: me.userId,
            environment: config.config.environment,
          });
          logPhase2('renewed token stored', 'yes');
        }
      }
    } catch (probeError) {
      // A failed probe must never fail the connection — the token is already
      // stored and usable. Message only, redacted, never the error object.
      logPhase2(
        'renewal probe threw',
        redactSecrets(probeError instanceof Error ? probeError.message : 'unknown error', [code])
      );
    }
    // ===================== END PHASE 2 DIAGNOSTICS ==========================

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

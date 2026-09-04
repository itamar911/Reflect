/**
 * GET /api/tradovate/connect — start the Tradovate OAuth flow.
 *
 * Mints a random state value, binds it to the signed-in session with a signed
 * httpOnly cookie, and redirects to Tradovate's consent screen. The matching
 * check lives in ../callback.
 *
 * A GET that changes state (it sets a cookie) is unusual, but this is a
 * top-level navigation the user initiates by clicking a link — it cannot be a
 * POST and still land on Tradovate's page. The state cookie is what keeps that
 * from being exploitable: a forged link to this route only ever starts a flow in
 * the victim's own browser, and the callback then requires the cookie that flow
 * issued.
 *
 * Nothing here is logged. The authorization URL contains client_id and state.
 */

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { describeConfigError } from '@/lib/tradovate/config';
import { buildAuthorizeUrl } from '@/lib/tradovate/oauth';
import { loadOAuthConfig } from '@/lib/tradovate/oauth-config';
import { resultUrl, TradovateResult } from '@/lib/tradovate/oauth-results';
import {
  issueState,
  STATE_COOKIE_NAME,
  STATE_TTL_MS,
  stateCookieOptions,
} from '@/lib/tradovate/oauth-state';

// node:crypto in the state and encryption modules; not available on the edge.
export const runtime = 'nodejs';
// Reads auth cookies and mints fresh randomness — must never be cached.
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // A browser navigation, so send them to sign in rather than answering with
    // JSON they would never see.
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const result = loadOAuthConfig();
  if (!result.ok) {
    // Server misconfiguration, not the user's problem. The detail goes to the
    // server console — describeConfigError names variables, never values.
    console.error(describeConfigError(result));
    return NextResponse.redirect(resultUrl(request, TradovateResult.NotConfigured));
  }

  const { state, cookieValue } = issueState(user.id);

  const response = NextResponse.redirect(buildAuthorizeUrl(result.config, state));
  response.cookies.set(STATE_COOKIE_NAME, cookieValue, {
    ...stateCookieOptions(new URL(result.config.redirectUri).protocol === 'https:'),
    maxAge: Math.floor(STATE_TTL_MS / 1000),
  });
  return response;
}

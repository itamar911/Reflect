/**
 * GET /api/cron/tradovate-keepalive — keep every connected user's Tradovate
 * connection alive (REF-100).
 *
 * Once a day, from vercel.json. The work is in lib/tradovate/keepalive.ts; this
 * route is the cron secret, the service-role client, and a response made of
 * counts.
 *
 * WHY A CRON AT ALL, when ./connections.ts also redeems on the request path:
 * the request path only helps a user who makes a request. The refresh token
 * lasts 26 hours, so a user who closes the app on Friday and opens it on Monday
 * has nothing live left to recover with — renewal needs a valid access token to
 * present, and theirs lapsed 80 minutes in. The cron is what covers the user
 * who is away, which is the whole of "a connected user never has to reconnect".
 *
 * Once a day is enough because each redemption issues a FRESH 26-hour refresh
 * token: the deadline moves out faster than it approaches. See
 * KEEPALIVE_WINDOW_MS.
 *
 *
 * AUTHORIZATION
 * -------------
 *
 * `Authorization: Bearer ${CRON_SECRET}`, the same variable and the same check
 * /api/cron/send-alerts and /api/cron/security-assertions already use, and
 * fail-closed for the same reason: this route holds the service-role client and
 * spends a third-party rate-limit budget, so an unset or renamed CRON_SECRET
 * must reject rather than run.
 *
 * The 401 body is EMPTY, which the two older cron routes' is not. Deliberate:
 * an unauthenticated caller should not learn from the response that it found a
 * cron endpoint rather than a path that does not exist.
 *
 *
 * SECRETS
 * -------
 *
 * No token, user id, key or secret appears in the response, in a log line, or
 * in an error. The response is six integers. Everything the library logs goes
 * through redactSecrets() first.
 */

import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { describeConfigError } from '@/lib/tradovate/config';
import { runKeepAlive } from '@/lib/tradovate/keepalive';
import { loadOAuthConfig } from '@/lib/tradovate/oauth-config';

// node:crypto in token-crypto.ts, reached through connections.ts; not available
// on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Redemptions are sequential and each is a round trip to Tradovate plus a
 * write, so the default 10-second budget would cut the run short once there are
 * more than a handful of connections. A run cut off here is not harmful — every
 * redemption is saved as it completes and the next run picks up the rest, in
 * expiry order — but it is wasted work, so the budget is the maximum the Hobby
 * plan allows.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new NextResponse(null, { status: 401 });
  }

  // Before the client and before any read: without OAuth configuration there is
  // no token endpoint to redeem against, so there is nothing this route can do.
  // describeConfigError() names variables and never values, and it goes to the
  // server console only.
  const config = loadOAuthConfig();
  if (!config.ok) {
    console.error(describeConfigError(config));
    return NextResponse.json({ error: 'Tradovate OAuth is not configured' }, { status: 500 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    // Missing or malformed service-role key. The message names the variable,
    // not its value, and stays on the server.
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[tradovate][keepalive] could not build the admin client:', message);
    return NextResponse.json({ error: 'Admin client unavailable' }, { status: 500 });
  }

  try {
    const counts = await runKeepAlive({ admin, config: config.config });
    return NextResponse.json({ ok: true, ...counts });
  } catch (error) {
    // runKeepAlive() catches per connection, so reaching here means the initial
    // listing failed and nothing was attempted. Say so rather than reporting
    // zeroes, which would read as a clean run with nothing to do.
    const name = error instanceof Error ? error.name : 'non-Error throw';
    console.error(`[tradovate][keepalive] the run could not start (${name})`);
    return NextResponse.json({ ok: false, ran: false }, { status: 500 });
  }
}

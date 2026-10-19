/**
 * GET /api/cron/tradovate-orders — read the day's protective orders for every
 * connected trader, before the trading day rolls (REF-113 Stage 4).
 *
 * The fourth trigger that can record a stop history, and the only one that does
 * not need the trader to show up. Once a day, from vercel.json, at 21:30 UTC.
 *
 * THAT HOUR IS THE ENTIRE POINT OF THE ROUTE and the arithmetic behind it is on
 * `runStopCapture` in lib/tradovate/orders-cron.ts. In one line: `/order/list`
 * is `depthDays = 0`, so the orders behind today's trades exist only until the
 * trading day rolls at ~17:00 CT, and 21:30 UTC is the one slot that is after
 * the American session closes and before that roll in BOTH DST regimes.
 *
 * IT DOES NOT SHARE A SLOT WITH ANYTHING, unlike the nightly import. Nothing
 * else in vercel.json runs at :30 past 21, and that is worth keeping: this job
 * makes more upstream requests per trader than any other scheduled work in the
 * product, and the thirty minutes of margin it has in summer are not a budget
 * to spend on contention.
 *
 * The work is in lib/tradovate/orders-cron.ts; this route is the cron secret,
 * the service-role client, and a response made of counts. Same split as
 * /api/cron/tradovate-import and the keep-alive, and for the reason stated
 * there.
 *
 *
 * AUTHORIZATION
 * -------------
 *
 * `Authorization: Bearer ${CRON_SECRET}` — the same variable and the same check
 * /api/cron/send-alerts, /api/cron/security-assertions,
 * /api/cron/tradovate-keepalive and /api/cron/tradovate-import already use, and
 * fail-closed for the same reason. THIS ROUTE HOLDS THE SERVICE-ROLE CLIENT AND
 * WRITES ROWS INTO USERS' JOURNALS. An unset or renamed CRON_SECRET must reject
 * rather than run.
 *
 * The 401 body is EMPTY, like the other crons': an unauthenticated caller
 * should not learn from the response that it found a cron endpoint rather than
 * a path that does not exist.
 *
 *
 * SECRETS AND IDENTIFIERS
 * -----------------------
 *
 * No token, user id, key, symbol, price, order id or account id appears in the
 * response, in a log line, or in an error. The response is ten integers.
 * Everything the library logs goes through redactSecrets() first, and the
 * stop-order read is stricter still: the body of a failed `/orderVersion/deps`
 * is the trader's stop prices, so lib/tradovate/orders.ts strips response
 * bodies before anything else.
 */

import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { isImportEnabled } from '@/lib/tradovate/import';
import { runStopCapture } from '@/lib/tradovate/orders-cron';

// node:crypto in token-crypto.ts, reached through connections.ts; not available
// on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One user here is a day pull PLUS the stop read — on the order of fifteen to
 * twenty upstream requests against two hosts — and the users are processed
 * sequentially, so the default 10-second budget would cut the run short at the
 * first or second trader.
 *
 * A run cut off here is not harmful in the same way the nightly one is not:
 * each user's rows are committed as they complete and the import is idempotent
 * by key. IT IS WORSE THAN WASTED WORK, THOUGH, AND THAT IS THE DIFFERENCE.
 * Tomorrow's run cannot pick up what this one missed — the orders are gone by
 * then — so a trader cut off by the timeout loses their stop histories for that
 * day and not just their place in the queue.
 *
 * So the budget is the maximum the plan allows, the same 60 as the keep-alive
 * and the nightly import. AT ROUGHLY FOUR TO EIGHT SECONDS A TRADER THAT IS ON
 * THE ORDER OF TEN — half the nightly job's ceiling, because the per-user cost
 * is roughly double. The allowlist is smaller than that today
 * (lib/tradovate/allowlist.ts); when it is not, this job has to become a queue
 * rather than a loop, and `attempted` far below `found` on a run that logged no
 * skip is the signature that it already should have.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new NextResponse(null, { status: 401 });
  }

  // Before the admin client and before any read. Without the flag there is not
  // one column this job may select — `is_trade_source` arrives with migration
  // 034 and `stop_history` with 038 — so an authorized call on a deployment
  // where the owner has not yet run those files answers honestly and does
  // nothing. `ran: false` rather than ten zeroes, which would read as a healthy
  // run with nothing to do.
  if (!isImportEnabled()) {
    return NextResponse.json({ ok: true, ran: false, reason: 'import_disabled' });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    // Missing or malformed service-role key. The message names the variable,
    // not its value, and stays on the server.
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[tradovate][orders-cron] could not build the admin client:', message);
    return NextResponse.json({ error: 'Admin client unavailable' }, { status: 500 });
  }

  try {
    const counts = await runStopCapture({ admin });
    return NextResponse.json({ ok: true, ran: true, ...counts });
  } catch (error) {
    // runStopCapture() catches per user, so reaching here means the initial
    // listing failed and nothing was attempted. Say so rather than reporting
    // zeroes, which would read as a clean run with nothing to do.
    const name = error instanceof Error ? error.name : 'non-Error throw';
    console.error(`[tradovate][orders-cron] the run could not start (${name})`);
    return NextResponse.json({ ok: false, ran: false }, { status: 500 });
  }
}

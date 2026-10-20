/**
 * GET /api/cron/tradovate-import — import yesterday's and today's finished
 * trades for every connected user (REF-107 Stage 2, E9).
 *
 * The third of E9's three triggers and the only one that does not need the
 * trader to show up. Once a day, from vercel.json, at **20:00 UTC**.
 *
 * The work is in lib/tradovate/import-cron.ts; this route is the cron secret,
 * the service-role client, and a response made of counts. Same split as the
 * keep-alive's route, and for the reason stated there.
 *
 *
 * IT RAN AT 03:30 UTC UNTIL REF-117 STAGE 2b, AND AT THAT HOUR IT IMPORTED
 * NOTHING
 * -----------------------------------------------------------------------
 *
 * Measured, 20.10: `/fill/list`, `/fillPair/list` AND `/position/list` are all
 * `depthDays = 0`. Tradovate clears them at the daily reset, exactly as it
 * clears `/order/list` — which REF-113 measured and acted on, for the ORDERS,
 * while nobody applied the same reasoning to the FILLS. 03:30 UTC is 22:30 CT
 * the previous day, five and a half hours after the 17:00 CT roll, so this job
 * woke every night, asked for the day it was meant to import, and was handed
 * three empty lists. `IMPORT_LOOKBACK_MS` reaching 48 hours back made no
 * difference: `windowStartMs` widens what gets PRICED, and there is nothing to
 * price in an empty response.
 *
 * Every row that has ever reached a journal got there from a trigger that runs
 * DURING the session — the trade form, the Sync button, the end-of-day summary,
 * or REF-113's 21:30 stop-capture cron. Which is why the import only ever
 * appeared to work when the trader pressed the button.
 *
 * 20:00 UTC is 15:00 CDT and 14:00 CST, so it is before the roll in both
 * regimes with hours to spare rather than the thirty minutes
 * /api/cron/tradovate-orders has to live with. It is also ninety minutes BEFORE
 * that job, which is deliberate — see lib/tradovate/import-cron.ts on why two
 * pre-roll passes is the point rather than a duplicate.
 *
 * WHAT MOVING IT GAVE UP, AND WHY THAT IS FINE. The old slot was thirty minutes
 * after /api/cron/tradovate-keepalive at 03:00, so that this job never met an
 * expired token. That was never a precondition: `getUserAccessToken`
 * (lib/tradovate/connections.ts) renews on demand and redeems a due refresh
 * token on the same path, which is why the 21:30 stop-capture cron has always
 * run seventeen hours from the keep-alive without trouble. A connection idle
 * past the 26-hour refresh-token life is dead at any hour.
 *
 * It no longer shares a slot with /api/cron/security-assertions (`30 3 * * *`),
 * which needed no coordination either way — Vercel runs crons concurrently and
 * the two touch nothing in common.
 *
 *
 * AUTHORIZATION
 * -------------
 *
 * `Authorization: Bearer ${CRON_SECRET}`, the same variable and the same check
 * /api/cron/send-alerts, /api/cron/security-assertions and
 * /api/cron/tradovate-keepalive already use, and fail-closed for the same
 * reason — and here for a sharper one than any of them. THIS ROUTE HOLDS THE
 * SERVICE-ROLE CLIENT AND WRITES ROWS INTO USERS' JOURNALS. An unset or renamed
 * CRON_SECRET must reject rather than run.
 *
 * The 401 body is EMPTY, like the keep-alive's: an unauthenticated caller
 * should not learn from the response that it found a cron endpoint rather than
 * a path that does not exist.
 *
 *
 * SECRETS AND IDENTIFIERS
 * -----------------------
 *
 * No token, user id, key, symbol, price or account id appears in the response,
 * in a log line, or in an error. The response is ten integers. Everything the
 * library logs goes through redactSecrets() first.
 */

import { NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { runBrokerImport } from '@/lib/tradovate/import-cron';
import { isImportEnabled } from '@/lib/tradovate/import';

// node:crypto in token-crypto.ts, reached through connections.ts; not available
// on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * One user's import is a pull of seven to nine upstream requests plus a batch of
 * statements, and the users are processed sequentially — so the default
 * 10-second budget would cut the run short at the second or third trader.
 *
 * A run cut off here is not harmful: each user's rows are committed as they
 * complete, the import is idempotent by key, and tomorrow's run plus every form
 * opening in between pick up the rest. But it is wasted work, so the budget is
 * the maximum the Hobby plan allows — the same 60 as the keep-alive, and the
 * same reasoning.
 *
 * IT IS ALSO THE REAL CEILING ON THIS STAGE'S USER COUNT. At roughly two to
 * four seconds a trader, sixty seconds is on the order of twenty. The
 * allowlist is smaller than that today (lib/tradovate/allowlist.ts); when it is
 * not, this job has to become a queue rather than a loop, and the counts are
 * what will say so — `found` far above `attempted` on a run that did not log a
 * skip is the signature.
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
  // 034 — so an authorized call on a deployment where the owner has not yet run
  // that file answers honestly and does nothing. `ran: false` rather than ten
  // zeroes, which would read as a healthy run with nothing to do.
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
    console.error('[tradovate][import-cron] could not build the admin client:', message);
    return NextResponse.json({ error: 'Admin client unavailable' }, { status: 500 });
  }

  try {
    const counts = await runBrokerImport({ admin });
    return NextResponse.json({ ok: true, ran: true, ...counts });
  } catch (error) {
    // runBrokerImport() catches per user, so reaching here means the initial
    // listing failed and nothing was attempted. Say so rather than reporting
    // zeroes, which would read as a clean run with nothing to do.
    const name = error instanceof Error ? error.name : 'non-Error throw';
    console.error(`[tradovate][import-cron] the run could not start (${name})`);
    return NextResponse.json({ ok: false, ran: false }, { status: 500 });
  }
}

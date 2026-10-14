/**
 * GET /api/tradovate/today — today's closed round trips for the signed-in user.
 *
 * The first route in this repository that returns trading data; connect,
 * callback and disconnect are the only others under /api/tradovate, and none of
 * them reads a fill. It exists because the rule engine runs in the browser and
 * the tokens cannot: lib/tradovate/connections.ts holds the service-role key and
 * decrypted tokens, the token columns are unreadable from the browser by
 * migration 017, and so the only shape this can take is a route that answers a
 * question. See lib/rules/brokerDayContext.ts for the other half.
 *
 *
 * WHAT CROSSES THE WIRE
 * ---------------------
 *
 * Six numbers and a timestamp — {@link BrokerDayContext} — and never:
 *
 * - **the access token.** Obviously, but worth writing down next to the code
 *   that holds one.
 * - **`api_hosts`.** Migration 030 keeps that column away from the browser
 *   deliberately; a user's hosts are not the user's business and are not needed
 *   to render a sentence about their day.
 * - **the fills themselves.** Nothing downstream needs per-trade rows, so
 *   sending a trader's positions to their browser would be volume and exposure
 *   bought for nothing. The streak is already reduced to an integer here.
 *
 * `source` is always present and is the only thing the client branches on. The
 * four values are `rule_context_source` from lib/types.ts.
 *
 *
 * STATUS CODES
 * ------------
 *
 * 200 for all four provenance states, including the three that failed. They are
 * not errors of this route: "your connection lapsed" and "Tradovate did not
 * answer" are ANSWERS, the client renders each one differently, and a 503 would
 * invite a retry layer or a console error over an outcome the UI already
 * handles. 401 is for a caller with no session and 400 for a missing or
 * implausible `dayStart`, both of which are faults in the request itself.
 */

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import {
  brokerPullFromSource,
  classifyDayPullFailure,
  describeDayPullFailure,
  REFLECT_ONLY,
  type BrokerDayPull,
} from '@/lib/rules/brokerDayContext';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { tradovateGet } from '@/lib/tradovate/client';
import { getUserTradingApi } from '@/lib/tradovate/connections';
import {
  formatDayPullCounts,
  loadBrokerDay,
  type DayPullCounts,
  type TradovateReader,
} from '@/lib/tradovate/fills';
import { redactSecrets } from '@/lib/tradovate/redact';
import { DAY_START_PARAM, parseDayStart } from '@/lib/tradovate/trading-day';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** No store, at every layer: this is one user's trading day, a minute old. */
const NO_STORE = { 'Cache-Control': 'no-store, private' };

function answer(pull: BrokerDayPull) {
  return NextResponse.json(pull, { headers: NO_STORE });
}

/**
 * TEMPORARY (diag/ref-90-counts). One line, counts only, off by default.
 *
 * A successful pull logs NOTHING on this path, and that is what made the
 * 13.10 report unanswerable: `broker_verified` with zeros has four possible
 * causes (see DayPullCounts in lib/tradovate/fills.ts) and they are
 * indistinguishable from the response, the status code and the logs alike.
 * This says which stage emptied.
 *
 * OFF UNLESS TRADOVATE_DIAG_COUNTS === '1'. Same shape as the REF-100
 * measurement route: a diagnostic that ships disabled and is removed once it
 * has answered its question, rather than a log line that lives in production
 * forever.
 *
 * WHAT IS NOT IN IT, and the list is the point: no user id, no Supabase id, no
 * `tradovate_user_id`, no account ids, no contract ids or symbols, no prices,
 * no P&L, no timestamps, no token. Integers and field names. The existing
 * failure warning below declines to log even the user id, reasoning that the
 * allowlist is small enough for it to identify a person (see its comment); the
 * same reasoning applies here and is why this carries no identifier at all.
 *
 * Through redactSecrets() regardless — every diagnostic in this integration
 * goes through it, and a formatter that is safe today should not be the reason
 * the next person skips it.
 */
function logDayPullCounts(counts: DayPullCounts): void {
  if (process.env.TRADOVATE_DIAG_COUNTS !== '1') return;

  console.info(redactSecrets(`[tradovate] today pull counts: ${formatDayPullCounts(counts)}`));
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // The same gate as connect and callback, and it fails closed: an unset or
  // empty TRADOVATE_OAUTH_ALLOWED_USER_IDS allows nobody (allowlist.ts). A user
  // outside it has no broker view at all, which is `reflect_only` and not a
  // failure — the panel says "only trades you recorded in Reflect" and invites
  // nothing. Answered before any read, so a deployment with the integration off
  // does no work here.
  if (!isUserAllowed(user.id)) return answer(REFLECT_ONLY);

  const dayStart = parseDayStart(
    new URL(request.url).searchParams.get(DAY_START_PARAM),
    Date.now()
  );
  if (!dayStart.ok) {
    // 400 rather than a server-side default. The only boundary this process
    // could invent is its own UTC midnight, which for a Tel Aviv trader at
    // 02:00 is three hours into their day and would report it as empty — wrong,
    // and wrong silently. See lib/tradovate/trading-day.ts.
    return NextResponse.json(
      { error: `Invalid ${DAY_START_PARAM}: ${dayStart.reason}` },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const api = await getUserTradingApi(user.id);

    // The token and the host travel together, which ./client.ts requires of
    // every per-user call: UserTokenRequestOptions does not type-check without
    // both, because a user's hosts are theirs and the deployment's host answers
    // a dedicated-infrastructure trader with a 307 (REF-92).
    const reader: TradovateReader = {
      get: (path, query) =>
        tradovateGet(path, query, { accessToken: api.accessToken, apiUrl: api.apiUrl }),
    };

    const { day, counts } = await loadBrokerDay({
      reader,
      dayStartMs: dayStart.dayStartMs,
      tradovateUserId: api.tradovateUserId,
    });

    logDayPullCounts(counts);

    return answer({ source: 'broker_verified', day });
  } catch (error) {
    const source = classifyDayPullFailure(error);

    // Through redactSecrets() like every diagnostic in this integration: the
    // describe helper reads an error's type and its own message, and on these
    // endpoints a message can have been built from a response body. The user id
    // is not logged — there is nothing to correlate it with here, and the
    // allowlist is small enough that it would identify a person.
    console.warn(
      redactSecrets(
        `[tradovate] today pull did not produce figures (${source}): ` +
          describeDayPullFailure(error)
      )
    );

    return answer(brokerPullFromSource(source));
  }
}

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
import { getUserTradingApi, type UserTradingApi } from '@/lib/tradovate/connections';
import {
  formatHostProbe,
  formatPermProbe,
  probeAccountHosts,
  probeTradingPermissions,
} from '@/lib/tradovate/diag-hosts';
import {
  formatBrokerDayCounts,
  loadBrokerDay,
  type BrokerDayCounts,
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
 * Since Stage 2 the pull also reads `/tradingPermission/list`, whose entity
 * carries two names and two email addresses as required fields — the first real
 * PII this integration touches. None of it can reach this line: what the rule
 * keeps from that response is a set of account ids (lib/tradovate/accounts.ts),
 * and `noPermission` and `permitted` here are counts of accounts like every
 * other field in the line.
 *
 * Through redactSecrets() regardless — every diagnostic in this integration
 * goes through it, and a formatter that is safe today should not be the reason
 * the next person skips it.
 */
function logDayPullCounts(counts: BrokerDayCounts): void {
  if (process.env.TRADOVATE_DIAG_COUNTS !== '1') return;

  console.info(redactSecrets(`[tradovate] today pull counts: ${formatBrokerDayCounts(counts)}`));
}

/**
 * TEMPORARY (diag/ref-90-hosts). One line, counts only, off by default.
 *
 * The counts line above answered "which stage emptied" with `accounts=0 …
 * filter: total=0` — a 200 carrying an empty array, so no condition in
 * lib/tradovate/accounts.ts ever ran and the ownership filter is not the
 * cause. What it cannot see is WHICH HOST was asked, and that is now the open
 * question: see the header of lib/tradovate/diag-hosts.ts.
 *
 * OFF UNLESS TRADOVATE_DIAG_HOSTS === '1', before any of the six GETs, so a
 * production request pays nothing at all for this. It no longer reads the
 * connection row either: Stage 1 made both resolved hosts part of
 * {@link UserTradingApi}, which is where the probe's own read came from, so the
 * probe now borrows what the product path already has in hand.
 *
 * NEVER THROWS. A diagnostic that can turn a served response into
 * `broker_unavailable` is worse than no diagnostic — the pull has already
 * succeeded by the time this runs, and the answer is already computed. Its own
 * failures are caught here and reported as one word.
 *
 * WHAT IS NOT IN IT: no hostname above all — `apiHosts.demo` varies by
 * organization, so logging it would name the prop firm this user trades for,
 * and `source` answers what a hostname would be reached for. Then the same
 * list as the counts line: no user id, no `tradovate_user_id`, no account ids
 * or names, no P&L, no timestamps, no token. `HostProbe` is counts-only by
 * type, so there is no hostname in hand here to log by accident.
 *
 * THE SECOND LINE (diag/ref-90-perms, Stage 0) answers what the first one
 * opened: the demo account's `userId` is not ours, so is it the firm admin's
 * with a TradingPermission naming our trader, or is user identity numbered per
 * host? See the header of lib/tradovate/diag-hosts.ts. It is four more GETs
 * behind the same flag, and it reads two entities that carry REAL PII — two
 * names and two email addresses on `TradingPermission`, `name` and `email` on
 * `/user/list`. None of it is in hand here: `PermProbe` is integers and one
 * closed union of words by type, the same discipline as `HostProbe` and the
 * reason this function cannot leak either.
 */
async function logHostProbe(api: UserTradingApi): Promise<void> {
  if (process.env.TRADOVATE_DIAG_HOSTS !== '1') return;

  try {
    const { environment: configured, hosts } = api;
    const probe = await probeAccountHosts({
      configured,
      hosts,
      tradovateUserId: api.tradovateUserId,
      // The same token against both hosts, which is the comparison: whether a
      // live-minted OAuth token is accepted by the demo host is the thing no
      // documentation answers. ./client.ts requires the host to travel with
      // the token, and here the host is the variable.
      get: (apiUrl) => tradovateGet<unknown>('/account/list', undefined, {
        accessToken: api.accessToken,
        apiUrl,
      }),
    });

    console.info(redactSecrets(`[tradovate] host probe: ${formatHostProbe(probe)}`));

    // After the host line, and deliberately after: this one cannot throw, so
    // the line above is already emitted whatever happens here, and the two
    // reads are independent findings that should not share a failure.
    const perms = await probeTradingPermissions({
      hosts,
      tradovateUserId: api.tradovateUserId,
      get: (apiUrl, path) =>
        tradovateGet<unknown>(path, undefined, { accessToken: api.accessToken, apiUrl }),
    });

    console.info(redactSecrets(`[tradovate] perm probe: ${formatPermProbe(perms)}`));
  } catch (error) {
    // Names the exception's type and nothing else: the probe reads a row and
    // calls two hosts, and either could fail in a way whose message carries a
    // response body.
    console.warn(
      redactSecrets(
        '[tradovate] host probe did not run ' +
          `(${error instanceof Error ? error.name : 'non-Error throw'})`
      )
    );
  }
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

    // ONE READER PER HOST (REF-90 Stage 1). The token and the host travel
    // together, which ./client.ts requires of every per-user call:
    // UserTokenRequestOptions does not type-check without both, because a
    // user's hosts are theirs and the deployment's host answers a
    // dedicated-infrastructure trader with a 307 (REF-92). That invariant is
    // what makes this a record of readers rather than one reader and a list of
    // hosts — each reader closes over the URL its token is addressed to, and
    // the two cannot drift apart.
    //
    // Both are built because both are asked: `environment` is the token's mint
    // server and says nothing about where the trader's accounts live, which was
    // the first of REF-90's two bugs. See loadBrokerDay for what it is still
    // used for.
    const readerFor = (apiUrl: string): TradovateReader => ({
      get: (path, query) =>
        tradovateGet(path, query, { accessToken: api.accessToken, apiUrl }),
    });

    const { day, counts } = await loadBrokerDay({
      readers: {
        live: readerFor(api.hosts.live.url),
        demo: readerFor(api.hosts.demo.url),
      },
      environment: api.environment,
      dayStartMs: dayStart.dayStartMs,
      tradovateUserId: api.tradovateUserId,
    });

    logDayPullCounts(counts);
    // Awaited rather than fired and forgotten: on a serverless runtime the
    // lambda can be frozen the moment the response is returned, and a probe
    // whose log line sometimes does not arrive is a measurement that cannot be
    // trusted. It runs only behind its own flag and cannot throw.
    await logHostProbe(api);

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

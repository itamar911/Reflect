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
 * - **the fills themselves.** Nothing THIS route's caller needs is per-trade, so
 *   sending a trader's positions here would be volume and exposure bought for
 *   nothing. The streak is already reduced to an integer.
 *
 * THAT LAST POINT IS NOW A STATEMENT ABOUT THIS ROUTE AND NOT ABOUT THE PRODUCT
 * (REF-107 Stage 1). `loadBrokerDay` returns the trade rows beside the scalars,
 * and GET /api/tradovate/trades does send them to the browser, deliberately,
 * because a journal is the rows — see that route's own header for the privacy
 * decision and its bounds. What survives here is the narrower and still-true
 * claim: THE RULE ENGINE'S ROUTE SENDS SCALARS, and a trader whose browser only
 * ever opens the trade form never receives a position from us. The two routes
 * are separate for exactly that reason, and the regression suite asserts that
 * this response carries no trade field — if a later change finds it convenient
 * to return `trades` from here, it has to delete that assertion on purpose.
 *
 * `source` is always present and is the only thing the client branches on. The
 * four values are `rule_context_source` from lib/types.ts.
 *
 * ONE FIELD WAS ADDED IN REF-107 STAGE 2 — `isTradeSource`, a boolean. It is
 * the trader's own declaration that the broker is the source of trades for
 * their account (E7), read from `tradovate_connections.is_trade_source`, and it
 * is here because THE RULE ENGINE RUNS IN THE BROWSER AND CANNOT DECIDE IT: the
 * decision depends on a server-side feature flag as well as a column, and
 * getting it wrong in either direction either double-counts a trader's day or
 * ignores half of it. See BrokerDayPull in lib/rules/brokerDayContext.ts.
 *
 * It is not a position, not a figure and not a secret — it is the policy the
 * trader put themselves under — so it does not weaken the claim above.
 *
 *
 * THIS ROUTE NOW WRITES (REF-107 STAGE 2)
 * ---------------------------------------
 *
 * A GET that writes is a bad smell, and it is the right trade here. E9 chose
 * "on trade-form open" as the first sync trigger for one reason: THE ROWS ARE
 * ALREADY BUILT. `loadBrokerDay` constructs the whole priced, grouped,
 * direction-aware list on every pull and REF-90 threw it away; importing it
 * costs ZERO additional upstream requests. Every other trigger costs a pull.
 *
 * What makes it safe rather than merely cheap:
 *
 * - **The write runs under the USER'S OWN SESSION**, the client built at the top
 *   of this handler, so RLS still enforces that a trader writes only their own
 *   rows. §C12 names a service-role import as the central new risk of REF-107,
 *   and this is the route that already holds the thing that avoids it.
 * - **It cannot fail the response.** The import is awaited inside its own
 *   try/catch and its result is discarded. The figures this route exists to
 *   return were correct before Stage 2 and are correct whether or not a row
 *   landed; failing a discipline check because an insert was refused would be
 *   the worst possible exchange.
 * - **It is a no-op without the flag.** TRADOVATE_IMPORT_ENABLED must be '1',
 *   which the owner sets after running migration 034 by hand.
 *
 *
 * STATUS CODES
 * ------------
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
import { flushUserCalls } from '@/lib/tradovate/call-meter';
import { getUserTradingApi, notingPenalty, readIsTradeSource } from '@/lib/tradovate/connections';
import { loadBrokerDay, type BrokerTrade, type TradovateReader } from '@/lib/tradovate/fills';
import { importBrokerTrades, isImportEnabled } from '@/lib/tradovate/import';
import { makesDayPartial } from '@/lib/tradovate/notices';
import { redactSecrets } from '@/lib/tradovate/redact';
import { DAY_START_PARAM, parseDayStart } from '@/lib/tradovate/trading-day';
import type { SupabaseClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** No store, at every layer: this is one user's trading day, a minute old. */
const NO_STORE = { 'Cache-Control': 'no-store, private' };

/**
 * Answer, stating the trade-source policy alongside the figures.
 *
 * `isTradeSource` is omitted rather than sent as `false`, so a deployment
 * without the flag produces BYTE-IDENTICAL responses to the pre-Stage-2 one.
 * The client reads absence as false (readBrokerDayResponse), which makes the
 * two indistinguishable where it matters and distinguishable in a diff.
 */
function answer(pull: BrokerDayPull, isTradeSource: boolean, partial = false) {
  const body: BrokerDayPull = isTradeSource ? { ...pull, isTradeSource: true } : pull;
  // REF-112-C item 3. Added the same way and for the same reason: absent unless
  // true, so an ordinary day is byte-identical to the pre-stage-B response. It
  // defaults to false so that the five call sites which have no pull in hand —
  // the refusal and the four failure states — cannot accidentally claim a
  // completeness they know nothing about.
  return NextResponse.json(partial ? { ...body, partial: true } : body, { headers: NO_STORE });
}

/**
 * Write the rows the pull already built, and never let that cost the answer.
 *
 * Awaited rather than fired and forgotten: a serverless function can be frozen
 * the moment its response is returned, so a detached promise here is an import
 * that sometimes happens. The cost is a handful of statements on a request that
 * has just made seven to nine upstream calls.
 *
 * Returns nothing. The counts are logged by the import itself and there is
 * nothing a rule check should do with them.
 */
async function syncQuietly(params: {
  client: SupabaseClient;
  userId: string;
  trades: BrokerTrade[];
  isTradeSource: boolean;
}): Promise<void> {
  try {
    await importBrokerTrades(params);
  } catch (error) {
    // The import catches per row and reports counts, so reaching here is
    // something structural — a client that cannot build a statement. The NAME
    // only: a thrown PostgREST error can carry the row, and the row is this
    // trader's position.
    const name = error instanceof Error ? error.name : 'non-Error throw';
    console.warn(redactSecrets(`[tradovate] import after the day pull threw (${name})`));
  }
}

/**
 * The trade-source declaration, and NEVER a reason this route fails.
 *
 * `readIsTradeSource` swallows a failed QUERY, but `createAdminClient()` inside
 * it throws outright on a missing or malformed service-role key — and this call
 * sits before the try block that classifies a pull failure. Unguarded, a
 * misconfigured key would turn /today from a 200 carrying `broker_unavailable`
 * into a 500, and the rule engine treats a non-200 as `broker_unavailable`
 * anyway (brokerDayContext.ts) — so the 500 buys nothing and costs the day's
 * figures.
 *
 * False on any failure, which is the pre-Stage-2 behaviour: the rules use
 * Reflect's own rows unfiltered, and nothing is imported.
 */
async function declaredTradeSource(userId: string): Promise<boolean> {
  if (!isImportEnabled()) return false;
  try {
    return await readIsTradeSource(userId);
  } catch (error) {
    const name = error instanceof Error ? error.name : 'non-Error throw';
    console.warn(redactSecrets(`[tradovate] could not read the trade-source declaration (${name})`));
    return false;
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

  // The same check as connect and callback, through the same function: open to
  // every signed-in user unless TRADOVATE_OAUTH_ALLOWED_USER_IDS names ids, in
  // which case only those (allowlist.ts). A restricted user has no broker view
  // at all, which is `reflect_only` and not a failure — the panel says "only
  // trades you recorded in Reflect" and invites nothing. Answered before any
  // read, so a deployment that has rolled the connection back does no work here.
  //
  // `false` for the policy, and it is the honest value: a restricted user has no
  // broker view, so nothing of theirs was ever imported and there is nothing to
  // de-duplicate against.
  if (!isUserAllowed(user.id)) return answer(REFLECT_ONLY, false);

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

  // BEFORE the pull and OUTSIDE its try, because it is needed in both outcomes:
  // the de-duplication policy is what the rule engine applies to its own rows,
  // and those rows exist whether or not Tradovate answered this minute. Behind
  // the flag, so a deployment where migration 034 has not been run never names
  // the column, and behind its own guard so that it cannot fail this route —
  // see declaredTradeSource.
  const isTradeSource = await declaredTradeSource(user.id);

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
    //
    // `notingPenalty` records a penalty verdict on the way out (REF-112 §4.5
    // item 3) and rethrows unchanged, so the catch below still maps it to
    // `broker_unavailable`. It wraps the READER rather than the catch because a
    // penalty is a property of a request, and this closure is the only thing
    // here that makes one.
    const readerFor = (apiUrl: string): TradovateReader => ({
      get: (path, query) =>
        notingPenalty(user.id, () =>
          tradovateGet(path, query, { accessToken: api.accessToken, apiUrl, userId: user.id })
        ),
    });

    // `trades` is kept now, and ONLY to be written. It does not enter the
    // response — the suite asserts that this body carries no trade field — and
    // no `windowStartMs` is passed either, so this pull prices exactly what it
    // priced before REF-107. What changed is that the list it always built is
    // persisted instead of discarded (REF-107 Stage 2, E9).
    //
    // `notices` IS NO LONGER DROPPED ON THE FLOOR (REF-112-C item 3). Stage B's
    // own report named this as the one thing it traded one risk for another on:
    // this route destructured `{ day, trades }` and discarded the list, so a
    // skipped account or an unresolvable product left the day SHORT with
    // nothing on this wire saying so. Only the boolean crosses — see
    // BrokerDayPull.partial for why not the list.
    const { day, trades, notices } = await loadBrokerDay({
      readers: {
        live: readerFor(api.hosts.live.url),
        demo: readerFor(api.hosts.demo.url),
      },
      environment: api.environment,
      dayStartMs: dayStart.dayStartMs,
      tradovateUserId: api.tradovateUserId,
    });

    // THE FREE TRIGGER (E9). `supabase` is the user's own session client, built
    // at the top of this handler and already proven to name this user — so the
    // write runs under their RLS and no user id is taken from the request.
    await syncQuietly({ client: supabase, userId: user.id, trades, isTradeSource });

    return answer({ source: 'broker_verified', day }, isTradeSource, makesDayPartial(notices));
  } catch (error) {
    const source = classifyDayPullFailure(error);

    // Through redactSecrets() like every diagnostic in this integration: the
    // describe helper reads an error's type and its own message, and on these
    // endpoints a message can have been built from a response body. The user id
    // is not logged — there is nothing to correlate it with here, and it names a
    // person. That reason USED TO BE "the allowlist is small enough that it
    // would identify a person", which an open rollout retires; the rule it
    // justified does not change, because a user id is an identifier at any
    // scale.
    console.warn(
      redactSecrets(
        `[tradovate] today pull did not produce figures (${source}): ` +
          describeDayPullFailure(error)
      )
    );

    return answer(brokerPullFromSource(source), isTradeSource);
  } finally {
    // The call counter, for a route that does not go through `syncUserTrades`
    // (REF-112 §4.5 item 1). In a `finally` rather than beside either `return`
    // because a pull that FAILED still made every request up to the failure,
    // and that is the user whose number matters most. Subject to
    // FLUSH_MIN_GAP_MS, so opening the trade form twice writes once.
    await flushUserCalls({ userIds: [user.id] });
  }
}

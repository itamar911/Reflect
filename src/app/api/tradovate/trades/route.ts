/**
 * GET /api/tradovate/trades — the signed-in user's finished round trips, as rows
 * (REF-107 Stage 1).
 *
 *
 * THE PRIVACY DECISION, WHICH IS THE POINT OF THIS FILE
 * ----------------------------------------------------
 *
 * THIS IS THE FIRST ROUTE IN THIS REPOSITORY THAT SENDS A TRADER'S POSITIONS TO
 * A BROWSER. REF-90 wrote the opposite position into lib/tradovate/fills.ts —
 * "a route that returned fills would be sending a trader's positions to the
 * browser for no purpose" — and the clause that mattered in that sentence was
 * the last one. REF-107 supplies the purpose: a journal is made of the rows, and
 * there is no way to show a trader the trade they took without the trade.
 *
 * So the reversal is deliberate, and these are its bounds:
 *
 * - **Only to the trader themselves.** The session cookie names the user and the
 *   token is fetched for THAT id; no user id is read from the request, so there
 *   is no parameter to tamper with. Same shape as /today.
 * - **Only what the broker already told us.** No DB write happens here, this
 *   stage has no migration, and nothing is persisted — Stage 2 is where rows
 *   land in `trade_plans`, behind `source`/`broker_trade_key` and the partial
 *   UNIQUE that makes a re-pull idempotent (§C10). Until then this route is a
 *   window onto a read.
 * - **Bounded in time.** Today by default; `since` reaches back at most
 *   {@link MAX_SINCE_AGE_MS} and says so when it clamps.
 * - **Never stored, never cached, never logged.** `no-store, private` on the
 *   response like /today, and the catch below logs a FAILURE KIND only — no
 *   symbol, no price, no fill id, no account id, not even the user id. See
 *   describeDayPullFailureKind for why that is a different function from the one
 *   /today uses.
 *
 * /api/tradovate/today is NOT widened to carry any of this, and its header
 * records the same split from the other side. The rule engine's route answers
 * with scalars; this one answers with rows; a trader who never opens the journal
 * has had no position leave our server.
 *
 *
 * WHAT CROSSES THE WIRE
 * ---------------------
 *
 * {@link BrokerTradesPull}: the same four-state `source` union as /today, with
 * `trades` where that route has `day`. The four states are
 * `rule_context_source` (lib/types.ts), and reusing the vocabulary is what lets
 * a client render "your connection lapsed" identically on both.
 *
 * Still never: the access token, and `api_hosts`. A row's `host` field says
 * 'live' or 'demo' — which is a fact about the trade, and the one thing that
 * makes `brokerTradeKey` unambiguous — and not a URL.
 *
 *
 * STATUS CODES
 * ------------
 *
 * Identical to /today, for the reasons given there: 200 for all four provenance
 * states including the three that failed, because "your connection lapsed" is an
 * answer and not a fault of the request; 401 for a caller with no session; 400
 * for a window that cannot be read.
 */

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import {
  classifyDayPullFailure,
  describeDayPullFailureKind,
} from '@/lib/rules/brokerDayContext';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { tradovateGet } from '@/lib/tradovate/client';
import { flushUserCalls } from '@/lib/tradovate/call-meter';
import { getUserTradingApi, notingPenalty } from '@/lib/tradovate/connections';
import { loadBrokerDay, type BrokerTrade, type TradovateReader } from '@/lib/tradovate/fills';
import { redactSecrets } from '@/lib/tradovate/redact';
import {
  MAX_SINCE_AGE_MS,
  parseTradesWindow,
  type TradesWindowParse,
} from '@/lib/tradovate/trading-day';
import type { RuleContextSource } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** No store, at every layer: this is one user's positions, a minute old. */
const NO_STORE = { 'Cache-Control': 'no-store, private' };

/**
 * The outcome of asking the broker for rows.
 *
 * Shaped exactly like {@link import('@/lib/rules/brokerDayContext').BrokerDayPull}
 * — a discriminated union on `source`, so a caller cannot read trades that were
 * never fetched — and for the same reason: three of the four states have nothing
 * to carry and the fourth always does.
 */
export type BrokerTradesPull =
  | {
      source: 'broker_verified';
      trades: BrokerTrade[];
      /**
       * The earliest close this answer covers, ISO 8601.
       *
       * Always present, because an empty list means two different things — "you
       * have not traded" and "we only looked at today" — and only this field
       * tells them apart. It is also where a clamped `since` becomes visible:
       * see parseTradesWindow.
       */
      windowStart: string;
      /** When this was read from Tradovate, ISO 8601. The day pull's `asOf`. */
      asOf: string;
    }
  | { source: 'broker_expired' }
  | { source: 'broker_unavailable' }
  | { source: 'reflect_only' };

function answer(pull: BrokerTradesPull) {
  return NextResponse.json(pull, { headers: NO_STORE });
}

/** The three stateless outcomes. Narrow enough that no cast is needed. */
function stateless(source: Exclude<RuleContextSource, 'broker_verified'>): BrokerTradesPull {
  return { source };
}

/**
 * What the handler needs from the world, so that the handler itself can be run
 * by the regression suite.
 *
 * There is no module mocker in this repository — scripts/tradovate-today-check.ts
 * is a plain `tsx` script and the Supabase client it uses elsewhere is a
 * hand-built stub — so the only way for a test to reach the 401, the 400 and the
 * allowlist refusal is for the seams to be parameters. The same reasoning as
 * TradovateReader in lib/tradovate/fills.ts: the seam exists because it is the
 * one the tests drive.
 *
 * GET supplies the real four below, and they are the only lines of this file
 * the suite does not execute.
 */
export interface TradesRouteDeps {
  /** The signed-in user's id, or null. From the session cookie, never the request body. */
  currentUserId: () => Promise<string | null>;
  isAllowed: (userId: string) => boolean;
  loadTrades: (
    userId: string,
    window: { dayStartMs: number; windowStartMs: number }
  ) => Promise<{ trades: BrokerTrade[]; asOf: string }>;
  /**
   * The clock, for the window bounds. Injected for the same reason
   * `BrokerDayRequest.now` is: a suite whose fixtures are dated 2026 cannot
   * assert anything about a 25-hour window measured from the real one.
   */
  now: () => number;
}

/**
 * The route, with its four seams supplied.
 *
 * The order of the checks is the order of /today's and is load-bearing: session
 * first (a signed-out caller is a fault in the request), then the allowlist
 * (answered BEFORE any window parsing, so a deployment with the integration off
 * does no work and leaks no 400s about parameters it would never have used),
 * then the window, then the pull.
 */
export async function respondToTradesRequest(
  request: Request,
  deps: TradesRouteDeps
): Promise<NextResponse> {
  const userId = await deps.currentUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // Fails closed, like connect, callback and today: an unset or empty
  // TRADOVATE_OAUTH_ALLOWED_USER_IDS allows nobody (allowlist.ts). `reflect_only`
  // and not a 403 — the user has no broker view, which is a state the journal
  // renders ("only trades you recorded in Reflect") and not an error.
  //
  // §E16 of the investigation is worth reading next to this: in a JOURNAL, where
  // the trader expects their trades to appear by themselves, silence is the worst
  // available failure. The route cannot fix that — the allowlist is small enough
  // that explaining the refusal would identify a person — so it answers
  // `reflect_only` and the UI that ships in a later stage owes the trader a
  // visible sentence.
  if (!deps.isAllowed(userId)) return answer(stateless('reflect_only'));

  const requested = parseTradesWindow(new URL(request.url).searchParams, deps.now());
  if (!requested.ok) return badWindow(requested);

  try {
    // Spelled out rather than passed whole: the parse also carries `ok` and
    // `clamped`, which are this function's business and not the pull's.
    const { trades, asOf } = await deps.loadTrades(userId, {
      dayStartMs: requested.dayStartMs,
      windowStartMs: requested.windowStartMs,
    });

    // The pull returns the window's closes AND the loss-streak window, which
    // reaches back past both on purpose (STREAK_WINDOW in fills.ts). So the list
    // is cut to what was asked for here, after the reduction that needed the
    // wider view has already happened.
    return answer({
      source: 'broker_verified',
      trades: trades.filter((trade) => trade.closedAtMs >= requested.windowStartMs),
      windowStart: new Date(requested.windowStartMs).toISOString(),
      asOf,
    });
  } catch (error) {
    const source = classifyDayPullFailure(error);

    // The kind of failure and nothing else. describeDayPullFailureKind drops the
    // message that describeDayPullFailure keeps, because those messages name
    // contract and product ids and this is the route whose whole subject matter
    // is a trader's positions. Through redactSecrets anyway, belt and braces,
    // like every diagnostic in this integration.
    console.warn(
      redactSecrets(
        `[tradovate] trades pull did not produce rows (${source}): ` +
          describeDayPullFailureKind(error)
      )
    );

    return answer(stateless(source));
  }
}

/**
 * A window that could not be read.
 *
 * Names the parameter and the reason and nothing else — the same shape /today
 * uses, and `MAX_SINCE_AGE_MS` is stated in days because a caller that sent a
 * `since` from last month needs to know what to send instead.
 */
function badWindow(bad: Extract<TradesWindowParse, { ok: false }>): NextResponse {
  const detail =
    bad.param === 'since'
      ? ` (an instant, no older than ${MAX_SINCE_AGE_MS / 86_400_000} days)`
      : '';
  return NextResponse.json(
    { error: `Invalid ${bad.param}: ${bad.reason}${detail}` },
    { status: 400, headers: NO_STORE }
  );
}

export async function GET(request: Request) {
  return respondToTradesRequest(request, {
    currentUserId: async () => {
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return user?.id ?? null;
    },

    isAllowed: isUserAllowed,

    now: Date.now,

    loadTrades: async (userId, window) => {
      const api = await getUserTradingApi(userId);

      // ONE READER PER HOST, token and host travelling together — the invariant
      // lib/tradovate/client.ts enforces in the type system, and the same
      // construction as /today. Both hosts are built because both are asked:
      // `environment` is the token's mint server and says nothing about where
      // the trader's accounts live (REF-90).
      //
      // `notingPenalty` records a penalty verdict on the way out (REF-112 §4.5
      // item 3) and rethrows unchanged, so the catch below still maps it to
      // `broker_unavailable`. It wraps the READER rather than the catch because
      // a penalty is a property of a request, and this closure is the only
      // thing here that makes one.
      const readerFor = (apiUrl: string): TradovateReader => ({
        get: (path, query) =>
          notingPenalty(userId, () =>
            tradovateGet(path, query, { accessToken: api.accessToken, apiUrl, userId })
          ),
      });

      try {
        const { day, trades } = await loadBrokerDay({
          readers: {
            live: readerFor(api.hosts.live.url),
            demo: readerFor(api.hosts.demo.url),
          },
          environment: api.environment,
          dayStartMs: window.dayStartMs,
          // The only parameter this route passes that /today does not, and the
          // only one that changes what the pull prices.
          windowStartMs: window.windowStartMs,
          tradovateUserId: api.tradovateUserId,
        });

        // `day` is dropped here, and the suite asserts the two routes agree:
        // these rows reduce to those scalars, because the scalars ARE this
        // list's reduction (fills.ts). Nothing recomputes a figure here.
        return { trades, asOf: day.asOf };
      } finally {
        // The call counter, for a route that does not go through
        // `syncUserTrades` (REF-112 §4.5 item 1). In a `finally` because a pull
        // that failed still made every request up to the failure.
        await flushUserCalls({ userIds: [userId] });
      }
    },
  });
}

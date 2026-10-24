/**
 * POST /api/tradovate/sync — import the signed-in user's finished trades now
 * (REF-107 Stage 2, E9).
 *
 * The second of E9's three triggers, and the one that exists because the first
 * one is not enough. The free trigger fires when the trader opens the TRADE
 * FORM (/api/tradovate/today), which is a thing they do before entering a
 * trade — not when they sit down to read their journal. This is the button
 * ("סנכרן עכשיו") for that moment.
 *
 * THE UI IS NOT IN THIS STAGE. The route ships first on purpose: it is the
 * half that can be driven and tested end to end without a browser, and a button
 * wired to a route that does not exist yet is worse than a route nobody has
 * clicked.
 *
 * STAGE 2.5 BUILT THAT BUTTON, and changed two things here. The handler is now
 * {@link respondToSyncRequest} with its seams as parameters, because this was
 * the only route in the integration a trader triggers deliberately and it had
 * not one assertion on it. And the `broker_verified` answer carries
 * `importEnabled`, which separates "the import is switched off" from "the
 * trader declared the broker is not their source of trades" — two states the
 * button has to word differently and the response could not tell apart.
 * Additive: a client that does not know the field reads its absence as false,
 * and false is the sentence that blames nobody.
 *
 *
 * WHY POST, AND WHY THAT IS NOT PEDANTRY
 * --------------------------------------
 *
 * /api/tradovate/today is a GET that writes, and its header argues the case:
 * the rows are already built there, so the import is free, and the alternative
 * is not importing. Here there is no such excuse — the pull exists only to
 * write — so the method says what the request does. It also means a browser
 * prefetch, a link preview or a retried GET cannot spend seven upstream calls
 * and a batch of inserts on a trader's behalf.
 *
 *
 * WHAT CROSSES THE WIRE
 * ---------------------
 *
 * COUNTS AND A PROVENANCE, AND NOT ONE TRADE. This is the only route in the
 * import path that a trader triggers deliberately, and it is tempting to answer
 * with the rows it just wrote so the journal can render them without a reload.
 * It does not: the journal reads `trade_plans` under the user's own RLS like
 * every other page, and sending the rows back from here would make this a
 * second, parallel way for a position to leave the server — with its own
 * caching rules to get wrong. The client refreshes; the rows are in the table.
 *
 * `source` is the same four-state vocabulary as /today and /trades, so a client
 * renders "your connection lapsed" identically on all three.
 *
 *
 * STATUS CODES
 * ------------
 *
 * 200 for all four provenance states, as on the other two routes and for the
 * reason given there: "your connection lapsed" is an answer. 401 for a caller
 * with no session. 400 for a window that cannot be read. 429 for a second call
 * inside {@link SYNC_COOLDOWN_MS} — see below.
 *
 *
 * AND 429, WHICH IS THE ONE STATUS CODE HERE THAT IS NOT A PROVENANCE
 * ------------------------------------------------------------------
 *
 * REF-112 §4.5 item 2 calls a server-side cooldown on this route "the single
 * cheapest missing cap", and the reasoning is about this route specifically:
 * it is fifteen to twenty upstream requests, a trader triggers it on purpose,
 * and the client's throttle is DESIGNED to be bypassed on an explicit click
 * (lib/tradovate/syncClock.ts). Holding the button down was therefore a
 * one-user denial of service against that trader's own Tradovate quota, with
 * nothing anywhere counting it.
 *
 * THE CLIENT GUARD STAYS AND THIS IS THE BACKSTOP. `AUTO_SYNC_THROTTLE_MS` is
 * still three minutes, a click still skips it, and `shareBrokerSync` still
 * collapses a double-click into one request. None of that is weakened. This
 * catches what a browser cannot: a second tab, a page left open since before
 * the deploy, and a caller that is not the button.
 *
 * **429 AND NOT A 200 WITH A NARROWED `source`**, which is the opposite of
 * every other refusal on this route and is deliberate. The four-state `source`
 * vocabulary answers "what does Reflect know about your broker", and the answer
 * to that is unchanged by a cooldown — the connection is fine, the broker is
 * fine, and we simply will not ask again this minute. Spending `reflect_only`
 * on it would tell the trader they have no broker view, and spending
 * `broker_unavailable` would blame Tradovate for our own cap. So the cooldown
 * leaves the union alone and answers in the error shape the 401 and the 400
 * already use, with `Retry-After` for anything that is not a browser.
 *
 * The message is Hebrew because it is the only refusal on this route that a
 * trader can both cause and fix, and it is the one place in this integration
 * where the right sentence is "we just did that" rather than an explanation of
 * a failure.
 */

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  classifyDayPullFailure,
  describeDayPullFailureKind,
} from '@/lib/rules/brokerDayContext';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { claimSyncSlot, type SyncSlot } from '@/lib/tradovate/connections';
import { redactSecrets } from '@/lib/tradovate/redact';
import { syncUserTrades, type SyncResult } from '@/lib/tradovate/sync';
// The copy lives with the rest of this route's sentences, in a browser-safe
// module the client component also reads — see SYNC_COOLDOWN_NOTE's own note.
import { SYNC_COOLDOWN_NOTE } from '@/lib/tradovate/sync-response';
import type { BrokerNotice } from '@/lib/tradovate/notices';
import type { BrokerImportCounts } from '@/lib/tradovate/import';
import {
  MAX_SINCE_AGE_MS,
  parseTradesWindow,
  type TradesWindowParse,
} from '@/lib/tradovate/trading-day';
import type { RuleContextSource } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** No store: a count of one user's trades, written one second ago. */
const NO_STORE = { 'Cache-Control': 'no-store, private' };

/**
 * The outcome of asking for a sync.
 *
 * Shaped like the other two routes' pulls — discriminated on `source`, three
 * states carrying nothing — so the client's branch is the one it already has.
 */
export type BrokerSyncResult =
  | ({
      source: 'broker_verified';
      /** The earliest close this run covered, ISO 8601. */
      windowStart: string;
      /** When this was read from Tradovate, ISO 8601. */
      asOf: string;
      /**
       * Whether TRADOVATE_IMPORT_ENABLED was set for this run.
       *
       * ON THE ANSWER BECAUSE `ran: false` IS AMBIGUOUS WITHOUT IT. Two states
       * reach the client as `broker_verified` with ten zeroes and no upstream
       * call made: the import flag is unset, and the trader has declared the
       * broker is not where their trades come from. They need different
       * sentences — the first is an operator fact the trader can do nothing
       * about, the second is their own setting, which they can change.
       *
       * IT IS THIS FIELD AND NOT `isTradeSource`, and the Stage 2.5
       * investigation got that wrong. `SyncResult.isTradeSource` looks like
       * the discriminator and is not one: lib/tradovate/sync.ts forces it to
       * false whenever the flag is off, because `is_trade_source` is a column
       * migration 034 adds and reading it early is a 42703 on every user. So
       * it comes out exactly equal to `ran` and splits nothing. The flag does
       * split them: false means nothing was read at all, true with `ran` still
       * false leaves the declaration as the only remaining explanation. The
       * regression suite asserts both halves of that.
       *
       * A SECOND, INDEPENDENT AXIS from `source`, the same way `isTradeSource`
       * is on BrokerDayPull: `source` says whether the broker answered, this
       * says whether the deployment would have let it matter. Sent only on the
       * verified member, because the other three never reach the gate.
       */
      importEnabled: boolean;
      /**
       * The contracts whose trades this run refused to state (REF-117 Stage 6).
       *
       * THE ONLY TRADE-SHAPED STRING THIS ROUTE HAS EVER SENT, so it is worth
       * being explicit about the bound. It is a SYMBOL — `MNQZ6` — and not an
       * id, a price, a quantity or an account: `HeldGroup` carries all of those
       * and lib/tradovate/sync.ts reduces it to this one field before the
       * response is built. The privacy class is /api/tradovate/trades', which
       * sends a trader their own rows on their own request, and this is a POST
       * the trader pressed a button to make.
       *
       * WHY IT IS SENT AT ALL: a held group is a day UNDER-COUNTED on that
       * contract, and an under-counted day makes every rule MORE PERMISSIVE.
       * REF-117 Stage 2 chose to hold the group rather than fail the whole pull
       * — one overnight carry must not take the integration down for a session
       * — and wrote down that the choice is defensible only if the trader can
       * see it. Nothing could, until this.
       *
       * Absent when empty, like `isTradeSource` on /today and for the same
       * reason: an ordinary day produces a response byte-identical to the one
       * before this stage.
       */
      heldSymbols?: string[];
      /** How many groups were held, including any with no readable symbol. */
      heldCount?: number;
      /**
       * What this run could not do for the trader (REF-112 §5).
       *
       * THE SECOND TRADE-SHAPED THING THIS ROUTE SENDS, and the bound is the
       * one `heldSymbols` established, restated in the type itself: a
       * {@link BrokerNotice} has an account LABEL and a symbol ROOT and no
       * other field. No account id, no host, no price, no quantity — the
       * server-side `PullNotice` carries the first two and
       * lib/tradovate/sync.ts drops them before this shape is built, so a leak
       * here would have to be a new field rather than a forgotten line.
       *
       * WHY IT IS SENT AT ALL: every member of that union is a state in which
       * the trader's journal is INCOMPLETE and nothing else on the screen
       * would say so. REF-112 §5 found five of them and they all present
       * identically — as an honest-looking zero — which is the one failure a
       * discipline product must not have.
       *
       * Absent when empty, like `heldSymbols`: an ordinary day produces a
       * response byte-identical to the one before this change.
       */
      notices?: BrokerNotice[];
    } & BrokerImportCounts)
  | { source: 'broker_expired' }
  | { source: 'broker_unavailable' }
  | { source: 'reflect_only' };

function answer(result: BrokerSyncResult) {
  return NextResponse.json(result, { headers: NO_STORE });
}

/** The three stateless outcomes. Narrow enough that no cast is needed. */
function stateless(source: Exclude<RuleContextSource, 'broker_verified'>): BrokerSyncResult {
  return { source };
}

/**
 * What the handler needs from the world, so that the handler itself can be run
 * by the regression suite.
 *
 * The same construction, and the same reason, as `TradesRouteDeps` in
 * app/api/tradovate/trades/route.ts: there is no module mocker in this
 * repository — the check scripts are plain `tsx` and the Supabase client they
 * use is a hand-built stub — so the only way for a test to reach the 401, the
 * four 400s and the allowlist refusal is for the seams to be parameters.
 *
 * This route needed it more than that one did. It is the only route in the
 * import path a trader triggers on purpose, it writes rows, and until Stage 2.5
 * it had no assertion on it at all. {@link POST} supplies the real four below,
 * and they are the only lines of this file the suite does not execute.
 */
export interface SyncRouteDeps {
  /** The signed-in user's id, or null. From the session cookie, never the request. */
  currentUserId: () => Promise<string | null>;
  isAllowed: (userId: string) => boolean;
  /**
   * Take this trader's sync slot, or report how long they must wait
   * (REF-112 §4.5 item 2).
   *
   * A SEAM FOR THE SAME REASON THE OTHER FOUR ARE ONE, and with one extra: the
   * real implementation writes to `tradovate_connections`, so a suite without
   * it could only assert the cooldown by reaching a database. `claimSyncSlot`
   * in lib/tradovate/connections.ts is the production one.
   *
   * OPTIONAL, AND ABSENCE MEANS "NO COOLDOWN". Every group written before this
   * stage asserts something else about this route, and none of them should
   * have to know the cap exists to keep passing. {@link POST} supplies the
   * real one, so production is never the defaulted path.
   */
  claimSlot?: (userId: string) => Promise<SyncSlot>;
  /** The pull and the import it feeds. Throws what the pull throws. */
  runSync: (
    userId: string,
    window: { dayStartMs: number; windowStartMs: number }
  ) => Promise<SyncResult>;
  /**
   * The clock, for the window bounds. Injected for the same reason
   * `TradesRouteDeps.now` is: a suite with fixed fixtures cannot assert
   * anything about a 25-hour window measured from the real one.
   */
  now: () => number;
}

/**
 * The route, with its four seams supplied.
 *
 * The order of the checks is /today's and /trades' and is load-bearing: session
 * first, then the allowlist (answered BEFORE any window parsing, so a
 * deployment with the integration off does no work and leaks no 400s about
 * parameters it would never have used), then the window, then the sync.
 *
 * THE COOLDOWN GOES BETWEEN THE WINDOW AND THE SYNC, which is the one position
 * in that list it can occupy, and both neighbours are the reason:
 *
 *   - AFTER THE ALLOWLIST, because a refused user must not cause a write. The
 *     allowlist answers `reflect_only` without touching the database, and
 *     claiming a slot for somebody who was never going to pull would both spend
 *     a statement and record a sync that did not happen.
 *   - AFTER THE WINDOW PARSE, because the claim is a WRITE and a 400 is free.
 *     A client sending a malformed `dayStart` in a loop would otherwise burn
 *     the trader's real slot on requests that never reach Tradovate — the cap
 *     would be doing the attacker's work.
 *   - BEFORE THE SYNC, because that is the thing being capped.
 */
export async function respondToSyncRequest(
  request: Request,
  deps: SyncRouteDeps
): Promise<NextResponse> {
  const userId = await deps.currentUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // Fails closed, like every other route in this integration: an unset or empty
  // TRADOVATE_OAUTH_ALLOWED_USER_IDS allows nobody (allowlist.ts). `reflect_only`
  // and not a 403 — the user has no broker view, which is a state the pages
  // render (E16) and not an error.
  if (!deps.isAllowed(userId)) return answer(stateless('reflect_only'));

  // The same window parser as /trades, and `dayStart` is mandatory for the same
  // reason: the trader's local midnight is the one instant no server can
  // compute (lib/tradovate/trading-day.ts). A button that wants everything it
  // can get sends `since` too, bounded to seven days.
  const requested = parseTradesWindow(new URL(request.url).searchParams, deps.now());
  if (!requested.ok) return badWindow(requested);

  // REF-112 §4.5 item 2. See the header on why this is a 429 rather than a
  // fifth `source`, and the note on {@link respondToSyncRequest} on why it sits
  // exactly here. A deployment without migration 042 claims every slot — the
  // backstop is absent rather than broken (lib/tradovate/connections.ts).
  if (deps.claimSlot) {
    const slot = await deps.claimSlot(userId);
    if (!slot.allowed) return tooSoon(slot);
  }

  try {
    // Spelled out rather than passed whole: the parse also carries `ok` and
    // `clamped`, which are this function's business and not the sync's.
    const { counts, asOf, importEnabled, heldSymbols, heldCount, notices } = await deps.runSync(
      userId,
      { dayStartMs: requested.dayStartMs, windowStartMs: requested.windowStartMs }
    );

    return answer({
      source: 'broker_verified',
      windowStart: new Date(requested.windowStartMs).toISOString(),
      asOf,
      importEnabled,
      // OMITTED WHEN NOTHING WAS HELD, which is every ordinary day, so the
      // body is byte-identical to the pre-Stage-6 one. `readSyncResponse`
      // reads the absence as "nothing held", the same rule it applies to
      // `importEnabled`.
      ...(heldCount > 0 ? { heldSymbols, heldCount } : {}),
      // Same rule, same reason (REF-112 §5).
      ...(notices.length > 0 ? { notices } : {}),
      ...counts,
    });
  } catch (error) {
    const source = classifyDayPullFailure(error);

    // The KIND of failure and nothing else, through redactSecrets, exactly as
    // /trades does and for the same reason: describeDayPullFailure's messages
    // name contract and product ids, and this is a route whose whole subject
    // matter is a trader's positions.
    console.warn(
      redactSecrets(
        `[tradovate] sync did not import (${source}): ${describeDayPullFailureKind(error)}`
      )
    );

    return answer(stateless(source));
  }
}

export async function POST(request: Request) {
  // Built once and shared by the two seams below: `currentUserId` reads the
  // session off it and `runSync` writes the rows through it, and they must be
  // the same identity for RLS to mean what lib/tradovate/sync.ts says it means.
  const supabase = await createClient();

  // Built once and shared by the cooldown and the sync, rather than one each.
  // The claim is a write to `tradovate_connections`, which has no UPDATE policy
  // for `authenticated` at all (migration 017) — so it is the service role or
  // nothing, and the trader cannot clear their own cooldown.
  const admin = createAdminClient();

  return respondToSyncRequest(request, {
    currentUserId: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return user?.id ?? null;
    },

    isAllowed: isUserAllowed,

    now: Date.now,

    claimSlot: (userId) => claimSyncSlot(userId, { admin }),

    runSync: (userId, window) =>
      syncUserTrades({
        userId,
        // The user's own session client for the WRITE — RLS enforces ownership —
        // and the service-role client for the token and host reads it cannot
        // make. See lib/tradovate/sync.ts on why these are two parameters.
        client: supabase,
        admin,
        dayStartMs: window.dayStartMs,
        windowStartMs: window.windowStartMs,
        // The trader pressed the button, which means they are here on the
        // trading day whose orders are still readable — the one condition
        // REF-113 Stage 3 has (see `readStops` in lib/tradovate/sync.ts). It
        // adds a handful of requests to a route somebody is already waiting on,
        // and only for trades that do not have an answer yet.
        readStops: true,
      }),
  });
}

/**
 * A second sync inside the window.
 *
 * THE ERROR SHAPE AND NOT A `BrokerSyncResult`, like the 401 and the 400 above
 * it: `source` answers "what does Reflect know about your broker", and the
 * answer to that did not change. `error` is the English machine-readable code
 * every other non-200 on this route carries, `message` is the Hebrew the client
 * renders, and `retryAfterSeconds` is the same number as the header so a
 * caller that reads JSON does not have to also read headers.
 *
 * `Retry-After` IS SENT because this is the one refusal here that a non-browser
 * caller can act on correctly, and it is the standard way to say it. Seconds
 * rather than a date, which is the form fetch libraries actually implement.
 */
function tooSoon(slot: SyncSlot): NextResponse {
  return NextResponse.json(
    {
      error: 'Sync cooldown',
      message: SYNC_COOLDOWN_NOTE,
      retryAfterSeconds: slot.retryAfterSeconds,
    },
    {
      status: 429,
      headers: { ...NO_STORE, 'Retry-After': String(slot.retryAfterSeconds) },
    }
  );
}

/** A window that could not be read. Names the parameter and the reason only. */
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

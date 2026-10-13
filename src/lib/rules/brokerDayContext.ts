/**
 * The broker's view of today, as the rule engine receives it (REF-90 §7).
 *
 * This module is the whole of the boundary between "what Tradovate said" and
 * "what the rules act on". It holds four things and deliberately nothing else:
 * the value the rule context takes as a parameter, the client-side fetch that
 * produces one, the short cache that keeps the two enforcement paths looking at
 * the same answer, and the mapping from a failure to the provenance value the
 * user is shown.
 *
 *
 * WHY THE PULL IS NOT INSIDE loadTradeRuleContext
 * -----------------------------------------------
 *
 * It cannot be. `loadTradeRuleContext` runs in the browser, under the user's own
 * RLS — that is what lets it use the browser Supabase client — while the tokens
 * are server-only by construction: lib/tradovate/connections.ts uses the
 * service-role key and holds decrypted tokens in memory, and the token columns
 * are not readable from the browser at all. So the broker data is fetched by a
 * route and ARRIVES AS A PARAMETER, and the pull stays outside the function
 * that defines the rule inputs — which also keeps that function what it was: one
 * definition, no side effects, testable with a value.
 *
 *
 * THE PARAMETER IS MANDATORY, AND THAT IS THE DESIGN
 * -------------------------------------------------
 *
 * {@link BrokerDayPull} has no default and `loadTradeRuleContext` takes it in
 * second position, before the optional client, so that NO CALL SITE CAN OMIT
 * IT. There are two enforcement paths — the gate that decides whether the trade
 * form opens (lib/rules/fetchActiveRuleViolation.ts, from AppShell) and the
 * validation inside the form (validateTradePlan, from TradePlanForm) — and if
 * only one of them passed broker data they would go back to disagreeing about
 * the same user at the same instant. That divergence is the bug
 * lib/rules/tradeRuleContext.ts was written to end; its header tells the story.
 * An optional parameter would be an invitation to reintroduce it in a later
 * change, by someone who added a third call site and did not read this.
 *
 * The precedent is lib/tradovate/client.ts, where `apiUrl` is required
 * alongside `accessToken` for the same reason: the compiler is the only
 * reviewer that reads every call site.
 *
 *
 * THE CACHE
 * ---------
 *
 * One form opening runs both paths, about a second apart, and the pull costs
 * seven to nine upstream requests. So the result is held for
 * {@link FRESH_MS} and concurrent callers share one in-flight promise. Within
 * that window both paths receive THE SAME OBJECT, which is the strongest form
 * of "they cannot disagree" available without threading a prop through four
 * components.
 *
 * It is a freshness window, not a store: nothing persists it, nothing warms it,
 * and it is per-tab. A trader who leaves the form open for twenty minutes and
 * then submits gets a new pull, which is what they should get — the submit path
 * re-runs the gate for exactly that reason.
 */

import { startOfTodayIso } from './tradeRuleContext';
import {
  TradovateNotConnectedError,
  TradovateUnpriceableError,
} from '@/lib/tradovate/errors';
import { DAY_START_PARAM } from '@/lib/tradovate/trading-day';
import type { BrokerDayContext } from '@/lib/tradovate/fills';
import type { RuleContextSource } from '@/lib/types';

export type { BrokerDayContext };

/** The route. One place, so the client and the tests cannot drift. */
export const BROKER_TODAY_PATH = '/api/tradovate/today';

/**
 * The outcome of asking the broker about today.
 *
 * Shaped as a discriminated union on `source` rather than
 * `{ day, source }` with a nullable day, because three of the four states have
 * no day and the fourth always has one. A caller cannot read figures that were
 * never fetched, and the compiler is what stops them — which matters because
 * the mistake it prevents is reading zeros as "nothing happened today" and
 * lifting a block the trader is subject to.
 *
 * The `source` values ARE `rule_context_source` (lib/types.ts, mirrored by the
 * CHECK constraint in migration 032). One vocabulary for the provenance, from
 * the route to the panel.
 */
export type BrokerDayPull =
  | { source: 'broker_verified'; day: BrokerDayContext }
  | { source: 'broker_expired' }
  | { source: 'broker_unavailable' }
  | { source: 'reflect_only' };

/** The three stateless outcomes, as singletons: there is nothing to vary. */
export const BROKER_EXPIRED: BrokerDayPull = Object.freeze({ source: 'broker_expired' });
export const BROKER_UNAVAILABLE: BrokerDayPull = Object.freeze({ source: 'broker_unavailable' });
export const REFLECT_ONLY: BrokerDayPull = Object.freeze({ source: 'reflect_only' });

/**
 * The pull for a source that carries no figures.
 *
 * A function rather than a lookup object so that adding a fifth
 * `RuleContextSource` is a compile error here — the `switch` is exhaustive over
 * the union and TypeScript checks the return.
 */
export function brokerPullFromSource(
  source: Exclude<RuleContextSource, 'broker_verified'>
): BrokerDayPull {
  switch (source) {
    case 'broker_expired':
      return BROKER_EXPIRED;
    case 'broker_unavailable':
      return BROKER_UNAVAILABLE;
    case 'reflect_only':
      return REFLECT_ONLY;
  }
}

/**
 * Where a thrown failure lands in the provenance vocabulary.
 *
 * The three rules this encodes, in the order they matter:
 *
 * 1. **A connection that never existed is not an expired one.** `'missing'`
 *    maps to `reflect_only`, not `broker_expired`, because `broker_expired`
 *    puts a "reconnect" button in front of the user — and pointing it at a
 *    connection they never made is an instruction they cannot follow.
 *    Disconnecting mid-request lands here too, by the same logic.
 * 2. **Only a refusal is an expiry.** TradovateNotConnectedError is thrown on
 *    evidence that Tradovate judged the credential and rejected it; everything
 *    else — a rate-limit penalty, a timeout, a 5xx, an unreadable body — is
 *    TradovateTransientError and means nothing was judged. That distinction is
 *    REF-101, where collapsing the two turned live connections into
 *    permanently dead rows, and this mapping is downstream of that fix rather
 *    than a second opinion on it.
 * 3. **Everything else is `broker_unavailable`**, by falling through rather
 *    than by being enumerated. That covers the transient family, the
 *    "answered but unusable" one (TradovateUnpriceableError: a non-USD
 *    product, or one with no value per point — the figures could not be
 *    produced and there is nothing to reconnect), and any error a later change
 *    introduces. The fail-safe direction: it degrades to Reflect's own data and
 *    says so, where `broker_expired` would send the user to re-authorise over a
 *    bug of ours.
 */
export function classifyDayPullFailure(error: unknown): Exclude<RuleContextSource, 'broker_verified'> {
  if (error instanceof TradovateNotConnectedError) {
    return error.status === 'missing' ? 'reflect_only' : 'broker_expired';
  }
  return 'broker_unavailable';
}

/** Non-secret one-liner for a log: the error's type and its own message. */
export function describeDayPullFailure(error: unknown): string {
  if (error instanceof TradovateUnpriceableError) {
    return `${error.name}(${error.reason}): ${error.message}`;
  }
  if (error instanceof TradovateNotConnectedError) {
    return `${error.name}(${error.status})`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'unknown error';
}

// ── The client side ─────────────────────────────────────────────────────────

/**
 * How long one pull stands for. Long enough to cover a form opening (the gate
 * and then the form, about a second apart), short enough that a trade closed
 * while the form is open is picked up on the next check.
 */
const FRESH_MS = 30_000;

let cached: { userId: string; at: number; pull: BrokerDayPull } | null = null;
let inFlight: { userId: string; work: Promise<BrokerDayPull> } | null = null;

/** Drop the cached pull. Test seam. */
export function forgetBrokerDayPull(): void {
  cached = null;
  inFlight = null;
}

/**
 * Ask the route about today, or reuse a recent answer.
 *
 * `userId` is the cache key, not a parameter of the request — the route reads
 * the session cookie and would ignore it. It is here so that signing out and
 * back in as somebody else in the same tab cannot be served the previous
 * trader's day out of a module-level variable for the next thirty seconds.
 * Whose day this is matters more than it is cheap to check.
 *
 * Never throws and never rejects. A pull that fails IS one of the four states —
 * that is the whole point of the union — and a throw here would propagate into
 * the gate, where the only available behaviours are "block everyone" and
 * "crash the form". `broker_unavailable` falls back to Reflect's own figures
 * with the panel saying so, which is the designed answer.
 */
export async function loadBrokerDayPull(
  userId: string,
  options: { force?: boolean } = {}
): Promise<BrokerDayPull> {
  if (!options.force) {
    if (cached && cached.userId === userId && Date.now() - cached.at < FRESH_MS) return cached.pull;
    if (inFlight && inFlight.userId === userId) return inFlight.work;
  }

  const work = requestBrokerDay().then((pull) => {
    cached = { userId, at: Date.now(), pull };
    inFlight = null;
    return pull;
  });

  inFlight = { userId, work };
  return work;
}

async function requestBrokerDay(): Promise<BrokerDayPull> {
  try {
    // The day boundary travels with the request: the route runs in UTC on
    // Vercel and cannot work out the trader's local midnight. startOfTodayIso()
    // is the one definition of it — see lib/tradovate/trading-day.ts.
    const url = `${BROKER_TODAY_PATH}?${DAY_START_PARAM}=${encodeURIComponent(startOfTodayIso())}`;
    const res = await fetch(url, { cache: 'no-store' });

    // A signed-out or forbidden caller has no broker view and no problem to
    // report: there is nothing to warn about and nothing to reconnect. The
    // session is the app shell's business, not this panel's.
    if (res.status === 401 || res.status === 403) return REFLECT_ONLY;
    if (!res.ok) return BROKER_UNAVAILABLE;

    return readBrokerDayResponse(await res.json());
  } catch {
    // Offline, aborted, or a body that is not JSON.
    return BROKER_UNAVAILABLE;
  }
}

/**
 * Turn a route response into a pull, trusting none of its shape.
 *
 * Exported for the test script, and defensive on purpose: the figures decide
 * whether a block lifts, so a half-built `day` object must not reach the
 * arithmetic as a set of zeros. Anything unrecognised is
 * `broker_unavailable` — degrade and say so.
 */
export function readBrokerDayResponse(body: unknown): BrokerDayPull {
  if (typeof body !== 'object' || body === null) return BROKER_UNAVAILABLE;
  const { source, day } = body as { source?: unknown; day?: unknown };

  if (source === 'reflect_only') return REFLECT_ONLY;
  if (source === 'broker_expired') return BROKER_EXPIRED;
  if (source === 'broker_unavailable') return BROKER_UNAVAILABLE;
  if (source !== 'broker_verified') return BROKER_UNAVAILABLE;

  const parsed = readBrokerDayContext(day);
  return parsed ? { source: 'broker_verified', day: parsed } : BROKER_UNAVAILABLE;
}

function readBrokerDayContext(value: unknown): BrokerDayContext | null {
  if (typeof value !== 'object' || value === null) return null;
  const d = value as Record<string, unknown>;

  const finite = (key: string): number | null => {
    const n = d[key];
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };

  const closedCount = finite('closedCount');
  const losingCount = finite('losingCount');
  const net = finite('net');
  const lost = finite('lost');
  const lossStreak = finite('lossStreak');
  const asOf = typeof d.asOf === 'string' ? d.asOf : null;

  if (
    closedCount === null ||
    losingCount === null ||
    net === null ||
    lost === null ||
    lossStreak === null ||
    asOf === null
  ) {
    return null;
  }

  // Null is a value here, not an absence: "there is no streak, so nothing has a
  // time". Only a number or null will do; undefined means the field was not
  // sent and the object is not the one this expects.
  const minutes = d.minutesSinceLastClose;
  if (minutes !== null && !(typeof minutes === 'number' && Number.isFinite(minutes))) return null;

  return {
    closedCount,
    losingCount,
    net,
    lost,
    lossStreak,
    minutesSinceLastClose: minutes as number | null,
    asOf,
  };
}

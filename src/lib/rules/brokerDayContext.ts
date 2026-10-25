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
import { markBrokerPull } from '@/lib/tradovate/syncClock';
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
export type BrokerDayPull = (
  | { source: 'broker_verified'; day: BrokerDayContext }
  | { source: 'broker_expired' }
  | { source: 'broker_unavailable' }
  | { source: 'reflect_only' }
) & {
  /**
   * Whether the connection declares the broker a SOURCE OF TRADES (REF-107 E7,
   * §C8 option ג) — `tradovate_connections.is_trade_source`.
   *
   * ON THE PULL AND NOT IN A QUERY OF ITS OWN, because the rule engine runs in
   * the browser and the route is the only thing that can answer this. The
   * column is granted to `authenticated` by migration 034, so the browser
   * COULD read it — but only after 034 has run, and a browser that named the
   * column early would fail for every user. The route knows whether the import
   * is enabled at all (server-side env), so it is the right place to decide
   * both.
   *
   * It is a SECOND, INDEPENDENT AXIS from `source`, which is why it is an
   * intersection rather than another member of the union. `source` says whether
   * the broker answered this minute; this says what policy the trader put their
   * account under, and that is true in all four states — most importantly in
   * the two failure states, where the engine falls back to Reflect's own rows
   * and those rows now include the broker's.
   *
   * OPTIONAL, AND ABSENCE MEANS FALSE. Three things produce the absence: a
   * deployment where TRADOVATE_IMPORT_ENABLED is not '1', the three frozen
   * singletons below, and any client that has not been updated. All three mean
   * "there are no imported rows to de-duplicate against", and false is the
   * behaviour this product had before Stage 2 — so the conservative default and
   * the backward-compatible one are the same value. The same reasoning as the
   * optional columns in lib/types.ts.
   */
  isTradeSource?: boolean;
  /**
   * Whether this day's figures are INCOMPLETE (REF-112-C item 3).
   *
   * A THIRD INDEPENDENT AXIS, for the same reason `isTradeSource` is a second
   * one: `source` says whether the broker answered, that says what policy the
   * trader is under, and this says whether what the broker answered covers
   * their whole day. True when the pull raised a notice of a kind that means
   * something is missing from the figures — a skipped account, a skipped trade,
   * or a dropped host (`makesDayPartial` in lib/tradovate/notices.ts).
   *
   * WHAT IT IS FOR, IN ONE SENTENCE: stage B stopped a non-USD account and an
   * unresolvable product from failing the whole pull, which was right, and the
   * cost was that the day is now stated with those trades missing while
   * `max_daily_loss` is measured against the short total. An under-counted day
   * makes every rule MORE PERMISSIVE — the one direction this integration must
   * never fail in — so the gap has to be visible to the thing that acts on it,
   * not only to the sync panel.
   *
   * ONLY MEANINGFUL ON `broker_verified`, and that is why it is on the
   * intersection rather than inside that member: the three failure states have
   * no figures at all, so "the figures are short" has nothing to say about
   * them, and a caller that reads it there gets `undefined` — which is false.
   *
   * OPTIONAL, AND ABSENCE MEANS FALSE — the same rule, and the same reason, as
   * `isTradeSource`. An ordinary day raises no notices, so the field is absent
   * from almost every response; a client that has not been updated reads it as
   * false and behaves exactly as it did before, which is also the pre-stage-B
   * behaviour for every day that had nothing missing.
   *
   * NOT THE NOTICES THEMSELVES. A boolean is all the rule engine can act on,
   * and the specific sentences — which account, which symbol — already reach
   * the trader through the sync panel, where lib/tradovate/sync.ts has already
   * resolved an account id into a label the trader chose. Putting the list on
   * this route would put a broker account label on the rule engine's wire for
   * nothing to read.
   */
  partial?: boolean;
};

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

/**
 * The error's KIND alone, with no message attached.
 *
 * {@link describeDayPullFailure} is the fuller line and the right default, but
 * the messages it passes through are built by this integration and some of them
 * name an entity: "No value per point for contract 2606306". On the route that
 * carries a trader's positions (app/api/tradovate/trades/route.ts) the rule is
 * that nothing identifying a trade reaches a log at all — not a symbol, not a
 * price, not an id — so that route needs the classification without the
 * sentence. Two functions rather than one with a flag, because the choice is
 * made once per route and a flag would be read as a verbosity setting.
 */
export function describeDayPullFailureKind(error: unknown): string {
  if (error instanceof TradovateUnpriceableError) return `${error.name}(${error.reason})`;
  if (error instanceof TradovateNotConnectedError) return `${error.name}(${error.status})`;
  if (error instanceof Error) return error.name;
  return 'unknown error';
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

    // The page-entry sync trigger shares this stamp (REF-107 Stage 2.5). This
    // pull was a GET THAT IMPORTS — /api/tradovate/today calls syncQuietly with
    // the rows it just built — so by the time it lands, the work the sync
    // button would do has already been done, server-side, for free. Without
    // this line "I opened the trade form, closed it, went to the journal" pays
    // for a second eight-request pull a second later over rows the first one
    // already wrote. The window belongs to the trader, hence `userId`.
    markBrokerPull(userId, Date.now());
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
  const { source, day, isTradeSource, partial } = body as {
    source?: unknown;
    day?: unknown;
    isTradeSource?: unknown;
    partial?: unknown;
  };

  // Only the literal `true` turns the de-duplication policy on. A missing
  // field, the string "true", or anything else is false — see the field's own
  // note on why absence and the safe answer are the same value here.
  const tradeSource = isTradeSource === true;

  // The same literal-`true` rule (REF-112-C item 3), and here the two reasons
  // for it point the same way for once. The string "true" is not a claim, like
  // everywhere else in this parser — AND the conservative answer is the
  // SURPRISING one: false means "trust the broker's figures", so a half-built
  // body that defaulted this to true would silently stop every connected
  // trader's broker day from reaching their rules. Absence has to mean "nothing
  // was missing", because that is what every response before this field said.
  const isPartial = partial === true;

  // The three stateless outcomes keep their FROZEN SINGLETONS when the policy
  // is off, which is every call before migration 034 and the flag: nothing
  // about the pre-Stage-2 path changes shape or allocates. When it is on they
  // get a fresh object, because a shared singleton cannot carry a per-user
  // value — and a mutation of a frozen one would silently do nothing.
  const stateless = (pull: BrokerDayPull): BrokerDayPull =>
    tradeSource ? { ...pull, isTradeSource: true } : pull;

  // `partial` IS DROPPED ON THE THREE STATELESS OUTCOMES, deliberately. It
  // describes figures, and those three carry none — so keeping it would mean
  // the frozen singletons could no longer be returned as-is on the commonest
  // path, in exchange for a field nothing can read. See the field's own note.
  if (source === 'reflect_only') return stateless(REFLECT_ONLY);
  if (source === 'broker_expired') return stateless(BROKER_EXPIRED);
  if (source === 'broker_unavailable') return stateless(BROKER_UNAVAILABLE);
  if (source !== 'broker_verified') return BROKER_UNAVAILABLE;

  const parsed = readBrokerDayContext(day);
  if (!parsed) return BROKER_UNAVAILABLE;

  // Built up rather than spread over a literal, so each flag is absent unless
  // it is true — which is what keeps an ordinary day's pull byte-identical to
  // the one that shipped before either field existed.
  const pull: BrokerDayPull = { source: 'broker_verified', day: parsed };
  if (tradeSource) pull.isTradeSource = true;
  if (isPartial) pull.partial = true;
  return pull;
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

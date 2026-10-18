/**
 * One clock for the live-position poll (REF-108 Stage 2).
 *
 * BROWSER-SAFE AND PURE, in the same sense ./syncClock.ts is: module-level
 * state and plain functions, no fetch, no env, no Supabase client, no React.
 * The hook that drives it lives in ./useLivePositions.ts; everything that can
 * be asserted without a browser lives here, and that is the split the
 * regression suite relies on.
 *
 * The construction is `shareBrokerSync`'s, deliberately — that module solved
 * "three mounted components must not make three requests" once, and the shape
 * is the part worth copying rather than the code.
 *
 *
 * WHY A SECOND CLOCK RATHER THAN syncClock's
 * -------------------------------------------
 *
 * Because they measure different things and would fight. `syncClock` governs
 * a three-minute window around a full broker SYNC — eight to ten upstream
 * requests that write rows — and a live poll is four reads that write nothing
 * and must happen every fifteen seconds. One module with two windows would be
 * a module nobody could reason about, and the first person to touch it would
 * change the wrong number.
 *
 *
 * THE INTERVALS, AND WHY THE SLOW ONE IS THE DEFAULT
 * --------------------------------------------------
 *
 *   in a position → {@link HOLDING_MS}  (15 s)
 *   flat          → {@link FLAT_MS}     (60 s)
 *   tab hidden    → nothing at all
 *
 * REF-108 asked for 10-15 s and this takes the slow end, which is a decision
 * and not a rounding. The vendor FAQ is explicit that there is no hard
 * request cap, that limits vary by hour, minute AND second, and that crossing
 * one escalates to `p-captcha` — which **a third-party application cannot
 * clear**. The trader then waits about an hour, and they do not wait alone:
 * the rule engine's own day pull goes down with it. A stale position line
 * costs a few seconds of accuracy; a captcha costs the trader their
 * discipline checks for an hour. The asymmetry picks the number.
 *
 * **Flat is a different question, not a disabled poll.** A trader who opens a
 * position wants to see it, and only a poll notices. Sixty seconds is the
 * compromise: up to a minute of silence after opening, at a quarter of the
 * cost. The route's own ten-second hold sits under both, so even a burst of
 * consumers cannot out-run it.
 *
 *
 * HIDDEN TABS STOP, AND SHOWING FIRES ONCE
 * ----------------------------------------
 *
 * A background tab is a trader who is not looking, and polling for them is
 * pure cost against a rate limit that is shared with the features they DO
 * use. Coming back fires immediately rather than waiting out the interval,
 * because a trader who just switched to the tab is asking.
 *
 * `BrokerSyncButton` already listens on `visibilitychange`; this follows it
 * rather than inventing a second convention.
 */

import type { BrokerLivePull } from '@/app/api/tradovate/live/route';

/** The route. One constant, so the client and the tests cannot drift. */
export const BROKER_LIVE_PATH = '/api/tradovate/live';

/** Poll interval while at least one position is open. See the header. */
export const HOLDING_MS = 15_000;

/** Poll interval while flat — still polling, because only a poll notices. */
export const FLAT_MS = 60_000;

/**
 * How long until the next poll, given what the last one found.
 *
 * A pure function of the answer, so the hook has no policy in it and the
 * suite can assert the policy without a browser. `null` — no answer yet —
 * takes the slow interval: an unknown state is not a held position, and
 * guessing fast would make a failed first poll the most expensive one.
 */
export function nextPollMs(pull: BrokerLivePull | null): number {
  if (pull === null || pull.source !== 'broker_verified') return FLAT_MS;
  const holding = pull.accounts.some((account) => account.positions.length > 0);
  return holding ? HOLDING_MS : FLAT_MS;
}

/**
 * Whether this answer is worth polling for at all.
 *
 * `reflect_only` means the trader has no broker view — not allowlisted, no
 * connection, or migration 037 not run — and no amount of polling changes
 * that within a session. Stopping is the whole point: the three consumers
 * mount on every page, and a trader with no broker would otherwise generate a
 * request a minute, forever, for an answer that cannot move.
 *
 * The three other states keep polling. `broker_unavailable` is transient by
 * definition, and `broker_expired` resolves the moment the trader reconnects
 * in another tab — which is exactly when they would be looking.
 */
export function shouldKeepPolling(pull: BrokerLivePull | null): boolean {
  return pull === null || pull.source !== 'reflect_only';
}

let last: { userId: string; at: number; pull: BrokerLivePull } | null = null;
let inFlight: { userId: string; work: Promise<BrokerLivePull> } | null = null;

/**
 * The last answer for this user, or null.
 *
 * A DIFFERENT user is always null, never the previous trader's positions —
 * `syncClock`'s rule, and it matters more here: this is live exposure, and a
 * tab that signed out and back in as somebody else showing the first
 * trader's holdings would be the worst leak this feature could produce.
 */
export function lastLivePull(userId: string): BrokerLivePull | null {
  return last && last.userId === userId ? last.pull : null;
}

/**
 * Run a poll, or join the one already in the air for this user.
 *
 * Three things collapse into one request, and all three are real: React
 * StrictMode mounting an effect twice in development, two consumers mounted
 * at once, and a `visibilitychange` landing while a timer-driven poll is
 * still running. Every one of them receives THE SAME PROMISE, which is the
 * strongest available form of "they cannot disagree about what is open".
 *
 * The answer is recorded when the work SETTLES, in `finally`, so a failed
 * poll also updates the clock — re-firing on every consumer's timer after a
 * failure would turn one lapsed connection into a stream of requests.
 */
export function shareLivePull(
  userId: string,
  now: () => number,
  start: () => Promise<BrokerLivePull>
): Promise<BrokerLivePull> {
  if (inFlight && inFlight.userId === userId) return inFlight.work;

  const work = start()
    .then((pull) => {
      last = { userId, at: now(), pull };
      return pull;
    })
    .finally(() => {
      // Only if it is still OURS. A poll for a second user started while this
      // one was in the air owns the slot now, and clearing it unconditionally
      // would un-share a promise other callers are already holding.
      if (inFlight && inFlight.work === work) inFlight = null;
    });

  inFlight = { userId, work };
  return work;
}

/** Forget the last answer and the in-flight poll. Test seam, and nothing else. */
export function forgetLivePoll(): void {
  last = null;
  inFlight = null;
}

/**
 * Fetch the route. The only impure line in this module, and it is one call.
 *
 * A non-200 is `broker_unavailable` rather than a throw, for
 * `brokerDayContext`'s reason: the caller renders a state, and there is no
 * state in this product that means "the fetch itself failed". A 401 lands
 * here too — a session that expired mid-session — and `broker_unavailable` is
 * the honest rendering of it until the next navigation redirects.
 */
export async function fetchLivePositions(signal?: AbortSignal): Promise<BrokerLivePull> {
  try {
    const response = await fetch(BROKER_LIVE_PATH, { signal, cache: 'no-store' });
    if (!response.ok) return { source: 'broker_unavailable' };
    return (await response.json()) as BrokerLivePull;
  } catch {
    return { source: 'broker_unavailable' };
  }
}

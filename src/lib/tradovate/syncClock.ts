/**
 * One clock for every broker pull this tab makes (REF-107 Stage 2.5).
 *
 * BROWSER-SAFE AND PURE. Two module-level variables and four functions; no
 * fetch, no env, no Supabase client, no React. The same construction as the
 * cache in lib/rules/brokerDayContext.ts, deliberately — that module solved
 * this problem once for /today and the shape is the part worth copying.
 *
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 *
 * A sync is eight to ten upstream requests and two to four seconds (§A2), and
 * /sync shares nothing with /today's thirty-second cache: that cache is keyed
 * to `BROKER_TODAY_PATH` and knows nothing about this route. With the auto
 * trigger mounted on three pages, a trader walking `/trades → /journal →
 * dashboard` would pay for three full pulls over rows that could not have
 * changed, and they would WAIT for them. The throttle is not about the rate
 * limit — 5,000/hour is not the constraint — it is about not spending a
 * trader's seconds on work with no possible result.
 *
 *
 * WHY 180 SECONDS, AND WHY A CLICK IGNORES IT
 * -------------------------------------------
 *
 * Sixty is too short for the reason above, and the delay that actually governs
 * "my trade is not in the journal yet" is not polling frequency: a position has
 * to be FLAT before it can be imported at all (§A3, rule 1), so the broker, not
 * this number, decides when a trade becomes importable. Three minutes also sits
 * clear of /today's thirty seconds, so the two windows do not interleave into
 * something nobody can reason about.
 *
 * An explicit click skips the window entirely, because a trader who pressed
 * "סנכרן עכשיו" is ASKING, and refusing them is worse than a pull. It does not
 * skip {@link shareBrokerSync} — double-clicks are one request.
 *
 *
 * WHY `userId` IS A KEY AND NOT A PARAMETER
 * -----------------------------------------
 *
 * Nothing sends it anywhere: the route reads the session cookie and would
 * ignore a user id in the request. It is here so that signing out and back in
 * as somebody else in the same tab cannot be served — or silenced — by the
 * previous trader's entry in a module-level variable. Whose pull this was
 * matters more than it is cheap to check. Same note as brokerDayContext's.
 */

import type { BrokerSyncOutcome } from './sync-response';

/**
 * How long one pull stands for, for the AUTOMATIC trigger only.
 *
 * See the header on why three minutes rather than one. Exported because the
 * regression suite asserts the boundary on both sides of it, and a test that
 * hard-coded 180000 would pass after somebody changed the constant.
 */
export const AUTO_SYNC_THROTTLE_MS = 180_000;

let last: { userId: string; at: number } | null = null;
let inFlight: { userId: string; work: Promise<BrokerSyncOutcome> } | null = null;

/**
 * Record that this user's broker data was just pulled.
 *
 * Called from two places, and the second one is the whole point: /sync stamps
 * it through {@link shareBrokerSync}, and loadBrokerDayPull stamps it too,
 * because opening the trade form ALREADY RAN AN IMPORT server-side
 * (api/tradovate/today imports what it pulled). Without that second call site,
 * "I opened the form, closed it, went to the journal" pays for a second pull
 * one second later over rows the first one already wrote.
 */
export function markBrokerPull(userId: string, now: number): void {
  last = { userId, at: now };
}

/**
 * Whether the automatic page-entry trigger should fire.
 *
 * A DIFFERENT user is always true, never "within the window": the window
 * belongs to the trader it was measured for, and inheriting it would mean the
 * first page a newly signed-in trader opens silently declines to sync.
 */
export function shouldAutoSync(userId: string, now: number): boolean {
  if (!last || last.userId !== userId) return true;
  return now - last.at >= AUTO_SYNC_THROTTLE_MS;
}

/**
 * Run a sync, or join the one already running for this user.
 *
 * Three things collapse into one request here, and all three are real: React
 * StrictMode mounting an effect twice in development, two of these components
 * mounted at once, and a trader clicking the button while the page-entry
 * trigger is still in the air. Every one of them receives THE SAME PROMISE,
 * which is the strongest available form of "they cannot disagree about what
 * happened" — the same argument brokerDayContext makes for its shared pull.
 *
 * The clock is stamped when the work SETTLES, not when it starts, and in
 * `finally` so that a failed pull also starts the window. A sync that failed
 * is evidence about the connection, and re-firing it on every navigation for
 * three minutes would turn one broken connection into a stream of them.
 */
export function shareBrokerSync(
  userId: string,
  now: () => number,
  start: () => Promise<BrokerSyncOutcome>
): Promise<BrokerSyncOutcome> {
  if (inFlight && inFlight.userId === userId) return inFlight.work;

  const work = start().finally(() => {
    markBrokerPull(userId, now());
    // Only if it is still OURS. A sync for a second user started while this one
    // was in the air owns the slot now, and clearing it unconditionally would
    // un-share a promise other callers are already holding.
    if (inFlight && inFlight.work === work) inFlight = null;
  });

  inFlight = { userId, work };
  return work;
}

/** Forget the window and the in-flight pull. Test seam, and nothing else. */
export function forgetBrokerSync(): void {
  last = null;
  inFlight = null;
}

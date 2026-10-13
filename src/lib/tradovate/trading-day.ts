/**
 * The day boundary the broker pull filters on (REF-90 §4).
 *
 * ONE DEFINITION OF "TODAY", AND IT IS ALREADY CHOSEN
 * ---------------------------------------------------
 *
 * `startOfTodayIso()` in lib/rules/tradeRuleContext.ts is local midnight on the
 * clock of the browser the trader is sitting in front of, and its own note says
 * why: a trading day belongs to the trader, and Vercel's UTC would file an
 * 01:00 Tel Aviv plan under yesterday. Every "today" in the rule engine is
 * measured from there.
 *
 * The broker pull has to use the SAME instant or the two halves of one answer
 * disagree — "trades taken today" from Reflect against "money lost today" from
 * Tradovate, cut at two different midnights. But the pull runs in a route
 * handler, on Vercel, in UTC, where that instant cannot be computed: the
 * server does not know the trader's offset. Nothing in `profiles` records a
 * timezone (checked), and adding one is a product change, not this ticket.
 *
 * So the browser SENDS it. The client calls startOfTodayIso() — the one
 * function — and passes the result; {@link parseDayStart} validates it and the
 * route filters on it. There is still exactly one definition, and it is still
 * the trader's clock.
 *
 * ON TRUSTING THE CLIENT WITH IT. The value only ever narrows or widens one
 * user's view of their OWN broker data, and the route authenticates that user
 * before it reads anything. A forged boundary cannot reach another account, and
 * the direction it could be pushed is not a win for the sender either: moving
 * it earlier counts MORE trades against their limits, and moving it later is
 * the same thing as not having traded yet, which they could achieve by not
 * opening the form. The bounds below are a sanity check against a broken clock
 * or a mangled parameter, not a security boundary.
 *
 *
 * WHY `tradeDate` IS NOT USED
 * ---------------------------
 *
 * `Fill`, `Position` and `CashBalance` all carry a `tradeDate` — a
 * `{year, month, day}` session label — and it looks like the obvious filter.
 * It is not, for one disqualifying reason: THE HOUR AT WHICH IT ROLLS OVER IS
 * NOT DOCUMENTED. Not on the endpoint pages, not in the architecture overview,
 * not in the cheat sheet. US futures convention puts it at 17:00 CT, which
 * would mean `tradeDate` changes in the middle of the Israeli night and shifts
 * twice a year as the US and Israeli DST transitions cross — but that figure
 * comes from a support article that is not fetchable, so it is a guess, and a
 * guess is not something to cut a discipline rule on.
 *
 * `Fill.timestamp` is a real instant. Converting an instant to a day on a clock
 * we chose is arithmetic we control; adopting a session label whose boundary we
 * cannot read is not. So the pull dates every round trip by the timestamp of
 * the fill that closed it, and `tradeDate` is read nowhere.
 */

/** Query parameter the client passes `startOfTodayIso()` in. */
export const DAY_START_PARAM = 'dayStart';

/**
 * How far back a plausible local midnight can be.
 *
 * Under 24 hours by construction — a local midnight is the start of the local
 * day the sender is currently in — plus an hour of tolerance for a clock that
 * disagrees with ours.
 */
const MAX_DAY_START_AGE_MS = 25 * 60 * 60_000;

/** A local midnight is never ahead of now. This is skew tolerance, nothing more. */
const MAX_DAY_START_SKEW_MS = 5 * 60_000;

export type DayStartParse =
  | { ok: true; dayStartMs: number }
  | { ok: false; reason: 'missing' | 'unparseable' | 'not_midnight' | 'out_of_range' };

/**
 * Validate a `dayStart` parameter into an instant.
 *
 * Rejects rather than defaults. A day boundary the route had to invent would be
 * the server's UTC midnight, which is precisely the wrong answer this module
 * exists to avoid — and it would be wrong silently, in the direction of
 * under-counting a trader's morning.
 */
export function parseDayStart(raw: string | null | undefined, now: number): DayStartParse {
  if (!raw) return { ok: false, reason: 'missing' };

  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { ok: false, reason: 'unparseable' };

  // Midnight on any real clock lands on a whole minute: every UTC offset in use
  // is a multiple of 15 minutes. A value carrying seconds is not a midnight, it
  // is "now" sent by mistake — worth catching, because the failure it produces
  // is a silently short day rather than an error.
  if (ms % 60_000 !== 0) return { ok: false, reason: 'not_midnight' };

  if (ms > now + MAX_DAY_START_SKEW_MS) return { ok: false, reason: 'out_of_range' };
  if (now - ms > MAX_DAY_START_AGE_MS) return { ok: false, reason: 'out_of_range' };

  return { ok: true, dayStartMs: ms };
}

/**
 * Whether a close falls in the trader's today.
 *
 * Lower bound only, deliberately: this is the same shape as the rule engine's
 * `.gte('closed_at', todayStart)`, which has no upper bound either. A close
 * cannot be in the future, and if a broker clock says otherwise the honest
 * answer is to count it today rather than to drop a real trade.
 */
export function closedToday(closedAtMs: number, dayStartMs: number): boolean {
  return Number.isFinite(closedAtMs) && closedAtMs >= dayStartMs;
}

/**
 * Minutes between an instant and now.
 *
 * Unrounded, like the rule engine's own `(Date.now() - closed_at) / 60000` —
 * `cooldown_after_losses` compares it against a minute count and rounds for
 * display only.
 */
export function minutesSince(instantMs: number, now: number): number {
  return (now - instantMs) / 60_000;
}

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
 * Query parameter for "everything since I connected" (REF-107 Stage 1).
 *
 * An instant, not a midnight: a connection happens at a wall-clock moment and
 * the journal's question is "what have I traded since then", so there is no
 * local-day arithmetic in it and none of {@link parseDayStart}'s midnight check
 * applies.
 */
export const SINCE_PARAM = 'since';

/**
 * How far back {@link SINCE_PARAM} may reach.
 *
 * Seven days, and the bound is about COST rather than about privacy or
 * permission — the trader may have every trade of theirs we can read. §A2 of the
 * REF-107 investigation measured where the cost actually is: the four list reads
 * are unfiltered and cost the same for any window, and what grows is PRICING, at
 * one contract chain per distinct contract in the window. A week of a futures
 * trader is one or two contracts; a full history is one per expiry month they
 * ever touched, which is tens of sequential round trips inside a request someone
 * is waiting on. So a week is what a synchronous route can promise, and the
 * historical import §A2 recommends is a separate job with a persistent spec
 * cache — not this parameter with a larger number.
 */
export const MAX_SINCE_AGE_MS = 7 * 24 * 60 * 60_000;

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

export type TradesWindowParse =
  | {
      ok: true;
      /** The trader's local midnight, as {@link parseDayStart} validated it. */
      dayStartMs: number;
      /** The earliest close to return. Equals `dayStartMs` when no `since` was asked for. */
      windowStartMs: number;
      /** Whether {@link MAX_SINCE_AGE_MS} moved `windowStartMs` later than asked. */
      clamped: boolean;
    }
  | { ok: false; param: 'dayStart' | 'since'; reason: string };

/**
 * Validate the trade-list route's window: a mandatory day, an optional reach
 * back behind it (REF-107 Stage 1).
 *
 * `dayStart` is required even when `since` is given, and that is not redundancy.
 * It is the one definition of the trader's today (above), the thing no server
 * can compute, and the boundary the day's own figures are cut at — the window
 * only ever says how much further back the LIST goes.
 *
 * THE CLAMP IS REPORTED, NOT SILENT. A `since` older than
 * {@link MAX_SINCE_AGE_MS} is answered with the seven days we can price rather
 * than a 400, because a trader who connected a month ago is asking a reasonable
 * question and a rejection tells them nothing they can act on. But a quietly
 * narrowed window is a week of missing trades that looks exactly like a quiet
 * week, so `clamped` travels with the answer and the route states the window it
 * actually served. That is the same instinct as {@link parseDayStart}'s refusal
 * to invent a boundary, applied where refusing would cost more than disclosing.
 *
 * A `since` in the future or unreadable IS a 400: neither is a question with a
 * narrower honest answer.
 */
export function parseTradesWindow(
  params: URLSearchParams,
  now: number
): TradesWindowParse {
  const dayStart = parseDayStart(params.get(DAY_START_PARAM), now);
  if (!dayStart.ok) return { ok: false, param: 'dayStart', reason: dayStart.reason };

  const raw = params.get(SINCE_PARAM);
  if (raw === null || raw === '') {
    return { ok: true, dayStartMs: dayStart.dayStartMs, windowStartMs: dayStart.dayStartMs, clamped: false };
  }

  const asked = Date.parse(raw);
  if (!Number.isFinite(asked)) return { ok: false, param: 'since', reason: 'unparseable' };
  if (asked > now + MAX_DAY_START_SKEW_MS) return { ok: false, param: 'since', reason: 'in_future' };

  const floor = now - MAX_SINCE_AGE_MS;
  const clamped = asked < floor;
  const sinceMs = clamped ? floor : asked;

  // A `since` LATER than the day boundary narrows nothing: today's trades are
  // the point of the route and the day's scalars are measured from midnight
  // regardless, so the window is the earlier of the two. A client that asks for
  // "since 14:00" gets today, which is the honest superset.
  return {
    ok: true,
    dayStartMs: dayStart.dayStartMs,
    windowStartMs: Math.min(dayStart.dayStartMs, sinceMs),
    clamped,
  };
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

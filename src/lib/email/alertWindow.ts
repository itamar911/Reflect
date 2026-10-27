/**
 * The day boundary the alert emails are cut at (REF-107 Stage 3a, §H).
 *
 * PURE. One exported function over `Intl`, no fetch, no env, no clock of its
 * own — the instant comes in as a parameter so the regression suite can drive
 * a DST weekend without waiting for one.
 *
 *
 * THE BUG THIS FIXES
 * ------------------
 *
 * api/cron/send-alerts computed "the start of today" as:
 *
 *     const todayStart = new Date(now);
 *     todayStart.setHours(0, 0, 0, 0);
 *
 * `setHours` works in the SERVER's zone, and on Vercel that is UTC. So the
 * daily summary's window began at UTC midnight — 02:00 or 03:00 on an Israeli
 * clock — and every trade a trader logged between their own midnight and
 * three in the morning fell out of the summary of the day they logged it in.
 *
 * The same route was already deriving the Israel hour correctly, with
 * `Intl.DateTimeFormat` and `timeZone: 'Asia/Jerusalem'`, to decide WHICH
 * HOUR to send at. Only the query window was left on the server clock. This
 * module is that one calculation, moved out so it can be asserted.
 *
 *
 * AND WHERE THAT WINDOW WENT (REF-125)
 * ------------------------------------
 *
 * The fix above replaced UTC midnight with the trader's midnight, which was
 * right about the direction and still one of SIX different "today"s in the
 * product. REF-125 settled it: a day is the CME trading day, 17:00
 * America/Chicago to 16:00 Chicago, and lib/tradingDay.ts computes it.
 * {@link alertRangeStart} now asks that module, so this file's remaining job
 * is the DISPATCH HOUR — which trader is due an email at this moment — and
 * {@link zonedDayStart} is what answers it. The two were always separate
 * questions; they were only ever cut at the same instant by coincidence.
 *
 *
 * WHY NOT A TIMEZONE LIBRARY, AND WHY NOT `profiles.timezone`
 * -----------------------------------------------------------
 *
 * No library, because `Intl` ships with the runtime and already carries the
 * IANA database the rest of this route depends on; adding a dependency to
 * compute one offset would be the larger change.
 *
 * `profiles.timezone` DOES NOT EXIST — verified, and it is the open question
 * §C10.5 of the REF-107 investigation records. Every user is therefore
 * assumed to be on Israel time, which is what the dispatch hour already
 * assumes and what the product is today. When that column lands, the zone
 * becomes this function's second argument and nothing else here changes;
 * that is why it takes one rather than hard-coding the string inside.
 */

import { currentTradingDayStart } from '@/lib/tradingDay';

/**
 * The zone every alert is DISPATCHED on until `profiles.timezone` exists.
 *
 * "Cut at" until REF-125, which moved the query window to the exchange's
 * trading day (lib/tradingDay.ts). What is left on this zone is the hour the
 * mail goes out, which is genuinely about the trader: `end_of_day_time` is a
 * wall-clock time they chose.
 */
export const ALERT_TIME_ZONE = 'Asia/Jerusalem';

/**
 * How far a zone is ahead of UTC at a given instant, in milliseconds.
 *
 * Formats the instant in the zone, reads it back as though those wall-clock
 * numbers were UTC, and subtracts. The difference is the offset, DST included
 * — which is the whole reason to go through `Intl` rather than store a number.
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const field = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second')
  );

  // Second resolution is enough: no IANA zone has ever had a sub-second
  // offset, and the milliseconds would cancel out of the subtraction anyway.
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant at which the current local day began in `timeZone`.
 *
 * Two steps, and the second is what makes it right across a DST boundary:
 * take the local calendar date, treat its midnight as though it were UTC, and
 * then shift by the offset IN FORCE AT THAT MIDNIGHT rather than the offset in
 * force now. On the morning after a spring-forward those two differ by an
 * hour, and using the current one would put the window an hour inside the
 * previous day.
 */
export function zonedDayStart(now: Date, timeZone: string = ALERT_TIME_ZONE): Date {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);

  const midnightAsUtc = Date.UTC(year, month - 1, day);
  return new Date(midnightAsUtc - zoneOffsetMs(new Date(midnightAsUtc), timeZone));
}

/**
 * The window an alert of this type reports on, as an ISO lower bound.
 *
 * BOTH DAILY ALERTS ARE NOW CUT AT THE TRADING DAY'S OPEN (REF-125), not at
 * the trader's midnight. That is the one thing this ticket changes in this
 * file, and it is a narrowing of what `zonedDayStart` is for rather than a
 * replacement of it: the DISPATCH HOUR is still a question about the trader's
 * own clock — "mail me at 21:00" means 21:00 in Israel — and the cron still
 * uses `zonedDayStart` for that. Only the question "which trades does this
 * email report on" belongs to the exchange.
 *
 * The practical difference is one to three hours at the front of the window
 * and the reason the email and the dashboard used to disagree: a trade closed
 * at 01:30 Israel was inside the email's day and outside the dashboard's. It
 * is now in the same day in both.
 *
 * THE `timeZone` PARAMETER IS GONE, and dropping it rather than leaving it
 * ignored is the point: a zone argument on a function that no longer consults
 * one is an invitation to pass `profiles.timezone` here the day that column
 * lands and expect the day boundary to follow it. It must not. When per-user
 * zones arrive they move the DISPATCH HOUR, which is `zonedDayStart`'s job
 * above and still takes a zone.
 *
 * The weekly one reaches back seven times twenty-four hours from now, which is
 * a duration and not a calendar week — the product has never promised
 * Sunday-to-Sunday, and changing that is a product decision rather than a bug
 * fix. REF-125 did not touch it.
 */
export function alertRangeStart(
  type: 'pre_market' | 'end_of_day' | 'weekly_summary',
  now: Date
): string {
  if (type === 'weekly_summary') {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  return currentTradingDayStart(now).toISOString();
}

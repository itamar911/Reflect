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

/** The zone every alert is cut at until `profiles.timezone` exists. */
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
 * Both daily alerts are cut at the trader's own midnight; the weekly one
 * reaches back seven times twenty-four hours from now, which is a duration
 * and not a calendar week — the product has never promised Sunday-to-Sunday,
 * and changing that is a product decision rather than a bug fix.
 */
export function alertRangeStart(
  type: 'pre_market' | 'end_of_day' | 'weekly_summary',
  now: Date,
  timeZone: string = ALERT_TIME_ZONE
): string {
  if (type === 'weekly_summary') {
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  return zonedDayStart(now, timeZone).toISOString();
}

/**
 * What "today" means in Reflect: the CME futures trading day (REF-125 §2).
 *
 * PURE. `Intl` and civil arithmetic, no fetch, no client, no clock of its own
 * — every function takes the instant or the day as a parameter, so the
 * regression suite drives a DST weekend without waiting for one. Browser-safe
 * and server-safe, which it has to be: the dashboard runs this in a browser
 * and the alert cron runs it on Vercel, and those two must not be able to
 * disagree about which day a trade belongs to.
 *
 *
 * THE DECISION THIS ENCODES (Imri, 27.10)
 * ---------------------------------------
 *
 * A trading day opens at **17:00 America/Chicago on the previous calendar
 * day** and closes at **16:00 Chicago**, and it is NAMED by the Chicago
 * calendar date on which it closes. The 16:00–17:00 Chicago hour — the CME
 * maintenance break — belongs to the day that just closed, not to the one
 * about to open.
 *
 * Over the weekend the break is one long gap: Friday 16:00 to Sunday 17:00 is
 * a single stretch with no session in it, and all of it belongs to Friday.
 * Sunday 17:00 opens MONDAY's trading day; there is no Saturday and no Sunday
 * trading day, and {@link tradingDayOf} never returns one.
 *
 * Daylight saving follows CHICAGO and not Israel, because the boundary is a
 * property of the exchange rather than of the trader. One consequence is worth
 * stating because it is the reason this module has no ambiguous-local-time
 * handling: both US transitions happen at 02:00 on a Sunday, which is inside
 * the weekend gap. **A DST shift therefore never lands inside a Monday-to-
 * Friday session.** No trading day is ever 23 or 25 hours long; what absorbs
 * the hour is Friday's gap, which runs 71 or 73 hours twice a year instead of
 * 72. The suite asserts that.
 *
 * The other consequence is that the day's Israeli wall-clock window is NOT
 * constant. Israel and Chicago change clocks on different dates, so for about
 * three weeks in March and one in November the two are "crossed" and the day
 * opens an hour earlier on an Israeli clock:
 *
 *   both on standard time   17:00 CT = 01:00 Israel, 16:00 CT = 00:00 Israel
 *   both on summer time     17:00 CT = 01:00 Israel, 16:00 CT = 00:00 Israel
 *   crossed (Mar, late Oct) 17:00 CT = 00:00 Israel, 16:00 CT = 23:00 Israel
 *
 * This is why {@link tradingDayWindowNote} DERIVES the hours it prints rather
 * than carrying the ticket's "מ-01:00 עד 00:00" as a constant. That string is
 * correct for most of the year and wrong by an hour during the crossed weeks —
 * including 27.10.2026, the day the decision was written.
 *
 *
 * WHICH TIMESTAMP DATES A TRADE
 * -----------------------------
 *
 * `closed_at`, falling back to `submitted_at` while the trade is still open —
 * see {@link tradingDayOfTrade}. A trade belongs to the day it was CLOSED in
 * because that is the day its money was realised, which is the same argument
 * `tradeRuleContext.ts` already makes for the daily loss limit.
 *
 * THE ONE READER THAT STAYS ON `submitted_at` is the rule engine's intraday
 * trade COUNT, and deliberately — see {@link tradingDayBounds}'s note and
 * lib/rules/tradeRuleContext.ts. `max_daily_trades` is about plans taken, not
 * closes, and the product has already ruled that mixing the two scopes is a
 * bug class rather than a rounding error.
 *
 *
 * WHY NOT A TIMEZONE LIBRARY
 * --------------------------
 *
 * `Intl` ships with the runtime and carries the IANA database, which is the
 * same reasoning lib/email/alertWindow.ts recorded for the Israel midnight
 * this module replaces. `zonedDayStart()` there is the function this one grew
 * out of; it stays where it is because the ALERT DISPATCH HOUR is still a
 * question about the trader's own clock ("mail me at 21:00") and not about the
 * exchange's day. Only the alert's QUERY WINDOW moves here.
 */

/** The exchange's clock. Not the trader's, and not the server's. */
export const TRADING_DAY_ZONE = 'America/Chicago';

/** Hour, Chicago, at which a trading day opens on the previous calendar day. */
export const SESSION_OPEN_HOUR = 17;

/** Hour, Chicago, at which a trading day closes on the day it is named for. */
export const SESSION_CLOSE_HOUR = 16;

/** The zone the day is DESCRIBED in, for a trader sitting in Israel. */
export const TRADER_TIME_ZONE = 'Asia/Jerusalem';

/** A trading day, `YYYY-MM-DD`, named by its Chicago closing date. */
export type TradingDay = string;

export interface TradingDayBounds {
  /**
   * First instant of the day. 17:00 Chicago on the previous calendar day —
   * Sunday's 17:00 for a Monday. Inclusive.
   */
  start: Date;
  /**
   * First instant of the NEXT trading day, and therefore the exclusive upper
   * bound of this one: `start <= t < end` is exactly `tradingDayOf(t) === day`.
   *
   * THIS IS 17:00 AND NOT THE 16:00 CLOSE, which is the whole content of "the
   * 16:00–17:00 gap belongs to the day that just closed". A query cut at
   * {@link close} would drop every fill in the maintenance break onto no day
   * at all. For a Friday it is SUNDAY's 17:00, because the weekend gap is
   * Friday's too.
   */
  end: Date;
  /**
   * When the session actually stopped trading: 16:00 Chicago on `day`.
   *
   * Display only — {@link tradingDayWindowNote} prints it. Never use it as a
   * query bound; see {@link end }.
   */
  close: Date;
}

// ── Zone primitives ─────────────────────────────────────────────────────────

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

function zonedParts(at: Date, timeZone: string): ZonedParts {
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

  return { year: field('year'), month: field('month'), day: field('day'), hour: field('hour') };
}

/**
 * How far `timeZone` is ahead of UTC at a given instant, in milliseconds.
 *
 * Formats the instant in the zone, reads those wall-clock numbers back as
 * though they were UTC, and subtracts. The difference is the offset with DST
 * already in it, which is the reason to go through `Intl` rather than store a
 * number. Lifted from lib/email/alertWindow.ts, which needs the same thing for
 * the trader's own midnight.
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

  // Second resolution is enough: no IANA zone has ever had a sub-second offset.
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant at which a given wall-clock hour occurs in `timeZone`.
 *
 * Two passes. The first reads the offset at the wall-clock numbers taken as
 * UTC, which is a guess; the second reads it AT the candidate instant, which is
 * the answer. One correction is enough here and the reason is specific rather
 * than a hope: the only hours this is ever called with are 16:00 and 17:00, and
 * both US transitions happen at 02:00 local, so the target is fourteen hours
 * away from any discontinuity. There is no skipped hour to fall into and no
 * repeated hour to pick between, so neither the nonexistent-time nor the
 * ambiguous-time case can arise — which is why this takes an hour rather than
 * a full local timestamp.
 */
function instantAtZonedHour(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string
): Date {
  const asIfUtc = Date.UTC(year, month - 1, day, hour);
  const guess = asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone);
  return new Date(asIfUtc - zoneOffsetMs(new Date(guess), timeZone));
}

// ── Civil-date arithmetic, independent of any zone ──────────────────────────

/** 0 = Sunday … 6 = Saturday, for a calendar date. Pure civil arithmetic. */
function civilWeekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function addCivilDays(
  year: number,
  month: number,
  day: number,
  delta: number
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function toIsoDay(year: number, month: number, day: number): TradingDay {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDay(day: string): { year: number; month: number; day: number } | null {
  const match = ISO_DAY_RE.exec(day);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  // Reject 2026-02-31 rather than letting Date roll it into March.
  if (month < 1 || month > 12 || date < 1 || date > 31) return null;
  const round = new Date(Date.UTC(year, month - 1, date));
  if (round.getUTCMonth() + 1 !== month || round.getUTCDate() !== date) return null;
  return { year, month, day: date };
}

const SATURDAY = 6;
const SUNDAY = 0;
const FRIDAY = 5;

// ── The three functions everything else in the product calls ────────────────

/**
 * Which trading day an instant falls in.
 *
 * Three steps, and the third is the weekend:
 *
 *   1. Read the instant's Chicago wall clock.
 *   2. At or after 17:00 the next session has opened, so the day is the NEXT
 *      Chicago calendar date. Before 17:00 — including the 16:00 hour, which
 *      is the maintenance break — it is the current one.
 *   3. If that lands on a Saturday or a Sunday the instant is somewhere in the
 *      weekend gap, which is Friday's. Roll back to it.
 *
 * Throws on an invalid `Date`, because a day name invented from `NaN` would be
 * a trade quietly filed under the epoch. Call {@link tradingDayOfIso} for the
 * defensive version that database columns need.
 */
export function tradingDayOf(instant: Date): TradingDay {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError('tradingDayOf: not a valid instant');
  }

  const chicago = zonedParts(instant, TRADING_DAY_ZONE);
  const candidate =
    chicago.hour >= SESSION_OPEN_HOUR
      ? addCivilDays(chicago.year, chicago.month, chicago.day, 1)
      : { year: chicago.year, month: chicago.month, day: chicago.day };

  const weekday = civilWeekday(candidate.year, candidate.month, candidate.day);
  if (weekday === SATURDAY || weekday === SUNDAY) {
    // Saturday is one day past Friday, Sunday is two.
    const back = addCivilDays(
      candidate.year,
      candidate.month,
      candidate.day,
      weekday === SATURDAY ? -1 : -2
    );
    return toIsoDay(back.year, back.month, back.day);
  }

  return toIsoDay(candidate.year, candidate.month, candidate.day);
}

/**
 * {@link tradingDayOf} over a timestamp column, trusting nothing.
 *
 * Null in, null out — and also null for an unparseable string, which is the
 * behaviour every caller this replaced already had: `iso.slice(0, 10)` on
 * garbage produced a key that matched no day, so the row fell out of the
 * bucket. Returning null keeps that and makes it legible, rather than throwing
 * inside a React render over one malformed row.
 */
export function tradingDayOfIso(iso: string | null | undefined): TradingDay | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return tradingDayOf(new Date(ms));
}

/**
 * Which trading day a TRADE belongs to.
 *
 * `closed_at` when it has one, `submitted_at` while it is still open — the
 * product decision, and already the fallback the dashboard and the weekly card
 * were reaching for with `closed_at ?? submitted_at`. Null when neither column
 * holds a readable instant.
 *
 * NOT FOR THE RULE ENGINE'S TRADE COUNT. That counts plans taken, by
 * `submitted_at` only, including ones still open; see this file's header.
 */
export function tradingDayOfTrade(trade: {
  closed_at?: string | null;
  submitted_at?: string | null;
}): TradingDay | null {
  return tradingDayOfIso(trade.closed_at ?? trade.submitted_at);
}

/**
 * The instants a trading day spans, as UTC `Date`s.
 *
 * `[start, end)` is the attribution window and is what a query filters on:
 * `tradingDayOf(t) === day` holds for exactly the instants in it. For a Friday
 * `end` is Sunday's 17:00 rather than Friday's, because the weekend gap
 * belongs to Friday — the single most likely thing to get wrong here, and the
 * reason this returns a window instead of letting each caller add 24 hours.
 *
 * Throws on anything {@link tradingDayOf} would never return: a malformed
 * string, or a Saturday or Sunday. There is no weekend trading day to bound,
 * and inventing one would overlap Friday's window and double-count the gap.
 */
export function tradingDayBounds(day: TradingDay): TradingDayBounds {
  const parsed = parseIsoDay(day);
  if (parsed === null) {
    throw new RangeError(`tradingDayBounds: not a YYYY-MM-DD day: ${JSON.stringify(day)}`);
  }

  const weekday = civilWeekday(parsed.year, parsed.month, parsed.day);
  if (weekday === SATURDAY || weekday === SUNDAY) {
    throw new RangeError(`tradingDayBounds: ${day} is a weekend; there is no such trading day`);
  }

  const previous = addCivilDays(parsed.year, parsed.month, parsed.day, -1);
  const start = instantAtZonedHour(
    previous.year,
    previous.month,
    previous.day,
    SESSION_OPEN_HOUR,
    TRADING_DAY_ZONE
  );

  const close = instantAtZonedHour(
    parsed.year,
    parsed.month,
    parsed.day,
    SESSION_CLOSE_HOUR,
    TRADING_DAY_ZONE
  );

  // The next open is this day's 17:00 — except on a Friday, where the next
  // session opens on Sunday and everything in between is still Friday's.
  const nextOpenDay =
    weekday === FRIDAY
      ? addCivilDays(parsed.year, parsed.month, parsed.day, 2)
      : parsed;
  const end = instantAtZonedHour(
    nextOpenDay.year,
    nextOpenDay.month,
    nextOpenDay.day,
    SESSION_OPEN_HOUR,
    TRADING_DAY_ZONE
  );

  return { start, end, close };
}

/**
 * The trading day before `day`.
 *
 * Monday's predecessor is FRIDAY, not Sunday: there is no weekend trading day
 * to step onto. That is the entire reason this exists rather than each caller
 * subtracting 86,400,000 — the dashboard's thirty-day bar chart used to plot
 * thirty CALENDAR days and therefore spent two bars in seven drawing a
 * guaranteed zero for a market that was shut.
 */
export function previousTradingDay(day: TradingDay): TradingDay {
  const parsed = parseIsoDay(day);
  if (parsed === null) {
    throw new RangeError(`previousTradingDay: not a YYYY-MM-DD day: ${JSON.stringify(day)}`);
  }
  const back = addCivilDays(parsed.year, parsed.month, parsed.day, -1);
  const weekday = civilWeekday(back.year, back.month, back.day);
  const skip = weekday === SATURDAY ? -1 : weekday === SUNDAY ? -2 : 0;
  const landed = skip === 0 ? back : addCivilDays(back.year, back.month, back.day, skip);
  return toIsoDay(landed.year, landed.month, landed.day);
}

/**
 * The `count` trading days ending at `day`, oldest first.
 *
 * For the bar charts, which need a dense axis: every day in the range gets a
 * slot whether or not the trader traded in it, so a quiet Wednesday reads as a
 * flat bar rather than vanishing and pulling Thursday leftward.
 */
export function tradingDaysEndingAt(day: TradingDay, count: number): TradingDay[] {
  const days: TradingDay[] = [];
  let cursor = day;
  for (let i = 0; i < count; i++) {
    days.push(cursor);
    cursor = previousTradingDay(cursor);
  }
  return days.reverse();
}

/**
 * The trading day in progress at `now`.
 *
 * A named alias for {@link tradingDayOf} rather than a second implementation,
 * and it takes `now` for the reason every function here does: a module that
 * reads the clock itself cannot be driven over a DST weekend by a test. The
 * name exists because `currentTradingDay(new Date())` says at the call site
 * what "today" was replaced by, and `tradingDayOf(new Date())` does not.
 */
export function currentTradingDay(now: Date): TradingDay {
  return tradingDayOf(now);
}

/**
 * When the trading day in progress at `now` opened.
 *
 * `tradingDayBounds(currentTradingDay(now)).start` is the most-written line in
 * the product after this ticket — the rule engine's query, the alert email's
 * query and the alert cron's broker pull all need exactly it, and those three
 * agreeing is most of what REF-125 is. One composition, named once, so that a
 * future reader changing the boundary cannot change it in two of the three.
 */
export function currentTradingDayStart(now: Date): Date {
  return tradingDayBounds(tradingDayOf(now)).start;
}

// ── Naming a day on screen (REF-125 item 4) ─────────────────────────────────

/**
 * "יום מסחר 27.10" — what a surface calls the day it is showing.
 *
 * `he-IL` numeric day and month, which is the format the dashboard header and
 * the stats chart already print, and PINNED TO UTC on purpose: the day is a
 * civil date with no instant in it, and letting the formatter apply a zone
 * would shift it by one on a server rendering in UTC for a reader in Israel.
 * That is §6.5's SSR trap, avoided by not giving the formatter an instant at
 * all.
 */
export function tradingDayLabel(day: TradingDay): string {
  const parsed = parseIsoDay(day);
  if (parsed === null) return '';
  const civil = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  const printed = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'numeric',
  }).format(civil);
  return `יום מסחר ${printed}`;
}

/**
 * "מ-01:00 עד 00:00 שעון ישראל (שעון חורף)" — the day's window, for a tooltip.
 *
 * DERIVED FROM THE BOUNDS, NOT A CONSTANT. The hours move: Israel and Chicago
 * change clocks on different dates, so for about three weeks in March and one
 * at the end of October the day opens at 00:00 Israel and closes at 23:00
 * rather than 01:00 and 00:00. The ticket's example string is the common case,
 * and 27.10 — the day the decision was taken — is one of the exceptions. A
 * hard-coded tooltip would have been wrong on arrival.
 *
 * The season named is ISRAEL's, because that is whose clock the hours are on.
 * Chicago's own switch is what makes the two cross, and saying so in a tooltip
 * would be explaining the exchange's calendar in a hover.
 *
 * Both hours are whole: every offset in use is a multiple of 15 minutes and
 * both ends sit on the hour, so there is no `:30` case to render.
 */
export function tradingDayWindowNote(day: TradingDay): string {
  const { start, close } = tradingDayBounds(day);
  const opensAt = israelHourLabel(start);
  const closesAt = israelHourLabel(close);
  return `מ-${opensAt} עד ${closesAt} שעון ישראל (${israelSeasonName(close)})`;
}

function israelHourLabel(at: Date): string {
  const { hour } = zonedParts(at, TRADER_TIME_ZONE);
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * Whether Israel is on summer or winter time at an instant.
 *
 * Compares the offset then against the offset in force the preceding January,
 * which is standard time by construction in the northern hemisphere. Reading
 * the offset rather than the calendar means the Knesset can move the dates
 * again — it has, twice — without this needing an edit.
 */
function israelSeasonName(at: Date): string {
  const { year } = zonedParts(at, TRADER_TIME_ZONE);
  const januaryOffset = zoneOffsetMs(new Date(Date.UTC(year, 0, 15, 12)), TRADER_TIME_ZONE);
  const offsetNow = zoneOffsetMs(at, TRADER_TIME_ZONE);
  return offsetNow > januaryOffset ? 'שעון קיץ' : 'שעון חורף';
}

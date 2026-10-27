/**
 * Trading-day regression suite (REF-125).
 *
 * src/lib/tradingDay.ts is now the single definition of "today" in the
 * product: the dashboard's daily P&L, the journal calendar, the trade form's
 * day panel, the rule engine's daily loss limit and trade count, the stats
 * page's daily chart, the weekly card's bars and both alert emails all cut
 * their day there. Before this ticket they cut it in six different places,
 * four of them at different instants, and the result was one trade appearing
 * on two days on two screens the trader could open side by side.
 *
 * So the module is worth pinning hard, and the fixtures below are instants
 * rather than durations: a day boundary bug is almost always a bug about ONE
 * particular hour on ONE particular date, and a test that says "add 24 hours"
 * reproduces the implementation instead of checking it. Every expected value
 * here was derived by hand from the two clocks and is stated as the wall-clock
 * reading it came from.
 *
 * Covered, group by group:
 *   - the maintenance hour, which belongs to the day that just closed
 *   - winter and summer, where both zones are aligned
 *   - the crossed weeks, where Israel and Chicago are on different seasons
 *   - the weekend gap, Friday 16:00 to Sunday 17:00, all of it Friday's
 *   - both US DST weekends, which land INSIDE that gap and never inside a
 *     Monday-to-Friday session
 *   - a trade closed at 01:30 Israel in winter and in summer — the concrete
 *     divergence the investigation's §2.2 is about
 *   - the cross-surface fixture (item 3): the real exported seams the six
 *     surfaces now call, asserted to agree on that one trade
 *   - the day label and its derived Israeli-hours tooltip
 *   - what the module REFUSES: a weekend day, a malformed day, a NaN instant
 *
 * Usage: npm run test:trading-day
 * Exits non-zero on the first failing group's summary.
 */
import {
  currentTradingDay,
  currentTradingDayStart,
  previousTradingDay,
  SESSION_CLOSE_HOUR,
  SESSION_OPEN_HOUR,
  TRADING_DAY_ZONE,
  tradingDayBounds,
  tradingDayLabel,
  tradingDayOf,
  tradingDayOfIso,
  tradingDayOfTrade,
  tradingDaysEndingAt,
  tradingDayWindowNote,
} from '../src/lib/tradingDay';
import { alertRangeStart } from '../src/lib/email/alertWindow';
// THE RULE ENGINE'S OWN EXPORT, not a reimplementation of it. This is the
// function the trade form, the journal and the broker pull all pass as the day
// boundary, so asserting it here is what makes the cross-surface claim below
// about the shipped code rather than about this file's idea of it. It reads the
// clock itself, so it is driven by comparison against a known day rather than
// by a fixture instant.
import { startOfTradingDayIso } from '../src/lib/rules/tradeRuleContext';
import { computeWeeklyStats } from '../src/lib/weekly/stats';

interface Case {
  label: string;
  got: unknown;
  want: unknown;
}

const failures: string[] = [];

function group(name: string, cases: Case[]) {
  const bad = cases.filter((c) => JSON.stringify(c.got) !== JSON.stringify(c.want));
  console.log(`${bad.length ? 'FAIL  ' : 'ok    '}${name}  (${cases.length - bad.length}/${cases.length})`);
  for (const c of bad) {
    console.log(`         ${c.label}: got ${JSON.stringify(c.got)} want ${JSON.stringify(c.want)}`);
    failures.push(`${name} / ${c.label}`);
  }
}

const c = (label: string, got: unknown, want: unknown): Case => ({ label, got, want });

/** The trading day an ISO instant falls in. Shorthand for the tables below. */
const dayOf = (iso: string): string => tradingDayOf(new Date(iso));

/** What a zone's clock reads at an instant, `YYYY-MM-DD HH:MM`. */
function wallClock(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const f = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${f('year')}-${f('month')}-${f('day')} ${f('hour')}:${f('minute')}`;
}

const HOUR_MS = 60 * 60 * 1000;
const hoursBetween = (a: Date, b: Date): number => (b.getTime() - a.getTime()) / HOUR_MS;

function threw(fn: () => unknown): string {
  try {
    fn();
    return 'no throw';
  } catch (error) {
    return error instanceof RangeError ? 'RangeError' : 'wrong error type';
  }
}

// ── The constants the whole thing rests on ───────────────────────────────────

group('the decision, as constants', [
  c('zone is Chicago and not Israel', TRADING_DAY_ZONE, 'America/Chicago'),
  c('opens at 17:00', SESSION_OPEN_HOUR, 17),
  c('closes at 16:00', SESSION_CLOSE_HOUR, 16),
]);

// ── The fixture clocks, asserted before anything is built on them ───────────
//
// If `Intl` or the host's IANA data ever disagreed with these, every expectation
// below would be wrong for a reason that had nothing to do with the module. So
// the clock readings are checked first and named in full.

group('the fixture instants read as claimed on both clocks', [
  c('winter: 23:00Z is 17:00 Chicago', wallClock('2026-01-14T23:00:00Z', TRADING_DAY_ZONE), '2026-01-14 17:00'),
  c('winter: 23:30Z is 01:30 Israel', wallClock('2026-01-14T23:30:00Z', 'Asia/Jerusalem'), '2026-01-15 01:30'),
  c('summer: 22:00Z is 17:00 Chicago', wallClock('2026-07-14T22:00:00Z', TRADING_DAY_ZONE), '2026-07-14 17:00'),
  c('summer: 22:30Z is 01:30 Israel', wallClock('2026-07-14T22:30:00Z', 'Asia/Jerusalem'), '2026-07-15 01:30'),
  // 27.10.2026 — the day the product decision was written — is a CROSSED week:
  // Israel went back to winter time on 25.10, Chicago stays on CDT until 1.11.
  c('crossed week: Israel is on +02:00', wallClock('2026-10-27T12:00:00Z', 'Asia/Jerusalem'), '2026-10-27 14:00'),
  c('crossed week: Chicago is on -05:00', wallClock('2026-10-27T12:00:00Z', TRADING_DAY_ZONE), '2026-10-27 07:00'),
]);

// ── The maintenance hour ─────────────────────────────────────────────────────
//
// "The 16:00–17:00 Chicago gap belongs to the day that just closed." This is
// the half of the decision that a naive implementation gets wrong, because the
// obvious reading of "the day closes at 16:00" is that 16:30 is nobody's day.

group('16:00-17:00 Chicago belongs to the day that just closed', [
  c('15:59 Chicago, Wed', dayOf('2026-01-14T21:59:00Z'), '2026-01-14'),
  c('16:00 Chicago exactly, Wed', dayOf('2026-01-14T22:00:00Z'), '2026-01-14'),
  c('16:30 Chicago, Wed', dayOf('2026-01-14T22:30:00Z'), '2026-01-14'),
  c('16:59 Chicago, Wed', dayOf('2026-01-14T22:59:00Z'), '2026-01-14'),
  // One minute later the next session is open and the day has rolled.
  c('17:00 Chicago exactly, Wed -> Thursday', dayOf('2026-01-14T23:00:00Z'), '2026-01-15'),
  c('17:01 Chicago, Wed -> Thursday', dayOf('2026-01-14T23:01:00Z'), '2026-01-15'),
]);

// ── Winter and summer, both zones aligned ───────────────────────────────────

group('winter (both zones on standard time)', [
  c('midday Wed', dayOf('2026-01-14T18:00:00Z'), '2026-01-14'),
  c('Wed 17:30 Chicago is Thursday', dayOf('2026-01-14T23:30:00Z'), '2026-01-15'),
  c('Thu 02:00 Chicago is still Thursday', dayOf('2026-01-15T08:00:00Z'), '2026-01-15'),
  c('Thu 09:00 Chicago is Thursday', dayOf('2026-01-15T15:00:00Z'), '2026-01-15'),
]);

group('summer (both zones on summer time)', [
  c('midday Tue', dayOf('2026-07-14T17:00:00Z'), '2026-07-14'),
  c('Tue 16:30 Chicago', dayOf('2026-07-14T21:30:00Z'), '2026-07-14'),
  c('Tue 17:00 Chicago is Wednesday', dayOf('2026-07-14T22:00:00Z'), '2026-07-15'),
  c('Wed 03:00 Chicago is Wednesday', dayOf('2026-07-15T08:00:00Z'), '2026-07-15'),
]);

// ── THE 01:30 ISRAEL TRADE — the divergence this ticket is about ────────────
//
// Investigation §2.2: "a trade closed at 01:30 Israel time appears in today's
// email, today's rule-engine loss total and today's calendar cell — and in
// YESTERDAY's dashboard dailyPnl." The old dashboard key was the UTC date, and
// 01:30 Israel is 23:30Z (winter) or 22:30Z (summer) on the PREVIOUS UTC date.
//
// Under the trading day both readings land on the later day, which is the one
// the trader means: at 01:30 Israel the Chicago clock says 17:30 or 19:30, the
// new session is open, and the trade belongs to it.

const WINTER_0130_ISRAEL = '2026-01-14T23:30:00Z';
const SUMMER_0130_ISRAEL = '2026-07-14T22:30:00Z';

group('a trade closed at 01:30 Israel', [
  c('winter: the old UTC key said', WINTER_0130_ISRAEL.slice(0, 10), '2026-01-14'),
  c('winter: the trading day says', dayOf(WINTER_0130_ISRAEL), '2026-01-15'),
  c('summer: the old UTC key said', SUMMER_0130_ISRAEL.slice(0, 10), '2026-07-14'),
  c('summer: the trading day says', dayOf(SUMMER_0130_ISRAEL), '2026-07-15'),
  // And the fix is not "always the next day": the same clock time two hours
  // earlier, inside the maintenance gap, stays on the day that closed.
  c('winter 23:30 Israel is the earlier day', dayOf('2026-01-14T21:30:00Z'), '2026-01-14'),
]);

// ── The weekend gap ─────────────────────────────────────────────────────────
//
// Friday 16:00 to Sunday 17:00 is one stretch with no session in it, and all of
// it is Friday's. 2026-01-16 is a Friday.

group('the weekend gap is all Friday', [
  c('Fri 15:00 Chicago', dayOf('2026-01-16T21:00:00Z'), '2026-01-16'),
  c('Fri 16:30 Chicago (gap opens)', dayOf('2026-01-16T22:30:00Z'), '2026-01-16'),
  c('Fri 17:30 Chicago (no Saturday session)', dayOf('2026-01-16T23:30:00Z'), '2026-01-16'),
  c('Sat 03:00 Chicago', dayOf('2026-01-17T09:00:00Z'), '2026-01-16'),
  c('Sat 12:00 Chicago', dayOf('2026-01-17T18:00:00Z'), '2026-01-16'),
  c('Sat 17:30 Chicago (still no session)', dayOf('2026-01-17T23:30:00Z'), '2026-01-16'),
  c('Sun 10:00 Chicago', dayOf('2026-01-18T16:00:00Z'), '2026-01-16'),
  c('Sun 16:59 Chicago (last minute of the gap)', dayOf('2026-01-18T22:59:00Z'), '2026-01-16'),
  // The gap ends here, and what opens is MONDAY — not Sunday.
  c('Sun 17:00 Chicago opens Monday', dayOf('2026-01-18T23:00:00Z'), '2026-01-19'),
  c('Sun 19:00 Chicago is Monday', dayOf('2026-01-19T01:00:00Z'), '2026-01-19'),
  c('Mon 09:00 Chicago is Monday', dayOf('2026-01-19T15:00:00Z'), '2026-01-19'),
]);

// A property rather than a table: no instant in a whole year maps to a weekend
// day. This is the invariant every `YYYY-MM-DD` key in the product now relies
// on — the journal calendar's Saturday and Sunday cells are structurally empty.
const weekendNames: string[] = [];
const daysIn2026 = new Set<string>();
// A whole year of hours, plus a day either side so the year's first and last
// sessions are reached from both directions. Days outside 2026 are dropped
// from the count rather than from the weekend check — a weekend name is a bug
// whatever year it is in.
for (let h = -24; h < 366 * 24; h++) {
  const day = dayOf(new Date(Date.parse('2026-01-01T00:30:00Z') + h * HOUR_MS).toISOString());
  if (day.startsWith('2026-')) daysIn2026.add(day);
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) weekendNames.push(day);
}

group('no instant in 2026 lands on a weekend trading day', [
  // 2026 runs Thursday to Thursday, so it holds 52 full weeks plus one extra
  // weekday: 261. Every one is reachable, which is also what proves the loop
  // ran and that no session is skipped over entirely.
  c('distinct 2026 trading days produced', daysIn2026.size, 261),
  c('weekend day names produced', weekendNames.slice(0, 3), []),
]);

// ── Both US DST weekends ────────────────────────────────────────────────────
//
// Chicago springs forward on Sunday 2026-03-08 at 02:00 and falls back on
// Sunday 2026-11-01 at 02:00. BOTH ARE INSIDE THE WEEKEND GAP, which is the
// property that keeps every Monday-to-Friday session exactly 24 hours long —
// the hour is absorbed by Friday's 72-hour gap instead.

group('spring forward, 2026-03-08 (inside the gap)', [
  c('Sat 2026-03-07 noon is Friday the 6th', dayOf('2026-03-07T18:00:00Z'), '2026-03-06'),
  // 01:30 CST on the Sunday, before the skip.
  c('Sun 01:30 CST is still Friday the 6th', dayOf('2026-03-08T07:30:00Z'), '2026-03-06'),
  // 03:30 CDT on the Sunday, after the skip. 02:30 never existed.
  c('Sun 03:30 CDT is still Friday the 6th', dayOf('2026-03-08T08:30:00Z'), '2026-03-06'),
  c('Sun 17:00 CDT opens Monday the 9th', dayOf('2026-03-08T22:00:00Z'), '2026-03-09'),
  c('Mon 2026-03-09 noon', dayOf('2026-03-09T17:00:00Z'), '2026-03-09'),
]);

group('fall back, 2026-11-01 (inside the gap)', [
  c('Sat 2026-10-31 noon is Friday the 30th', dayOf('2026-10-31T17:00:00Z'), '2026-10-30'),
  // 01:30 CDT, the first pass through the repeated hour.
  c('Sun 01:30 CDT (first pass) is Friday the 30th', dayOf('2026-11-01T06:30:00Z'), '2026-10-30'),
  // 01:30 CST, the second pass through the same wall clock.
  c('Sun 01:30 CST (second pass) is Friday the 30th', dayOf('2026-11-01T07:30:00Z'), '2026-10-30'),
  c('Sun 17:00 CST opens Monday the 2nd', dayOf('2026-11-01T23:00:00Z'), '2026-11-02'),
  c('Mon 2026-11-02 noon', dayOf('2026-11-02T17:00:00Z'), '2026-11-02'),
]);

// ── The crossed weeks ───────────────────────────────────────────────────────
//
// Israel leaves summer time on the last Sunday of October and Chicago on the
// first Sunday of November, and Israel enters it in late March while Chicago
// enters it on the second Sunday. So there are two stretches a year where the
// two clocks are on different seasons and the day's ISRAELI hours shift by one.
// The boundary itself does not move — it is a Chicago hour — which is what
// these cases are for.

group('crossed weeks: the Chicago boundary does not move', [
  // 27.10.2026: Israel on +02:00, Chicago on -05:00. 17:00 Chicago = 22:00Z.
  c('late Oct: 21:59Z is still the earlier day', dayOf('2026-10-27T21:59:00Z'), '2026-10-27'),
  c('late Oct: 22:00Z rolls the day', dayOf('2026-10-27T22:00:00Z'), '2026-10-28'),
  // Mid-March: Chicago already on -05:00, Israel still on +02:00.
  c('mid-Mar: 21:59Z is still the earlier day', dayOf('2026-03-11T21:59:00Z'), '2026-03-11'),
  c('mid-Mar: 22:00Z rolls the day', dayOf('2026-03-11T22:00:00Z'), '2026-03-12'),
  // Deep winter, both aligned: the same roll happens an hour later in UTC.
  c('deep winter: 22:59Z is still the earlier day', dayOf('2026-01-14T22:59:00Z'), '2026-01-14'),
  c('deep winter: 23:00Z rolls the day', dayOf('2026-01-14T23:00:00Z'), '2026-01-15'),
]);

// ── Bounds ──────────────────────────────────────────────────────────────────

const winterWed = tradingDayBounds('2026-01-14');
const summerTue = tradingDayBounds('2026-07-14');
const winterFri = tradingDayBounds('2026-01-16');
const springFri = tradingDayBounds('2026-03-06');
const autumnFri = tradingDayBounds('2026-10-30');
const springMon = tradingDayBounds('2026-03-09');

group('bounds: start is 17:00 Chicago the previous calendar day', [
  c('winter Wed start', winterWed.start.toISOString(), '2026-01-13T23:00:00.000Z'),
  c('winter Wed start reads 17:00 Chicago', wallClock(winterWed.start.toISOString(), TRADING_DAY_ZONE), '2026-01-13 17:00'),
  c('summer Tue start', summerTue.start.toISOString(), '2026-07-13T22:00:00.000Z'),
  c('summer Tue start reads 17:00 Chicago', wallClock(summerTue.start.toISOString(), TRADING_DAY_ZONE), '2026-07-13 17:00'),
  // A MONDAY OPENS ON SUNDAY EVENING, which is the one case where "the previous
  // calendar day" is also a day the market is otherwise shut.
  c('Monday opens on Sunday', springMon.start.toISOString(), '2026-03-08T22:00:00.000Z'),
  c('and that reads 17:00 Chicago Sunday', wallClock(springMon.start.toISOString(), TRADING_DAY_ZONE), '2026-03-08 17:00'),
]);

group('bounds: close is 16:00 Chicago on the day itself', [
  c('winter Wed close', winterWed.close.toISOString(), '2026-01-14T22:00:00.000Z'),
  c('winter Wed close reads 16:00 Chicago', wallClock(winterWed.close.toISOString(), TRADING_DAY_ZONE), '2026-01-14 16:00'),
  c('summer Tue close', summerTue.close.toISOString(), '2026-07-14T21:00:00.000Z'),
]);

group('bounds: end is the NEXT open, not the close', [
  // The maintenance hour is inside [start, end), which is the whole point.
  c('winter Wed end', winterWed.end.toISOString(), '2026-01-14T23:00:00.000Z'),
  c('end is one hour past close', hoursBetween(winterWed.close, winterWed.end), 1),
  // ON A FRIDAY THE END IS SUNDAY'S OPEN. The single most likely thing to get
  // wrong, and the reason bounds() exists rather than "start plus 24 hours".
  c('Friday end is Sunday 17:00', winterFri.end.toISOString(), '2026-01-18T23:00:00.000Z'),
  c('Friday end reads 17:00 Chicago Sunday', wallClock(winterFri.end.toISOString(), TRADING_DAY_ZONE), '2026-01-18 17:00'),
  c('Friday close is still Friday 16:00', wallClock(winterFri.close.toISOString(), TRADING_DAY_ZONE), '2026-01-16 16:00'),
]);

group('bounds: a weekday session is exactly 24 hours, always', [
  c('winter Wed', hoursBetween(winterWed.start, winterWed.end), 24),
  c('summer Tue', hoursBetween(summerTue.start, summerTue.end), 24),
  // The Monday after a spring forward and the Monday after a fall back. Both
  // are 24 hours, because the transition happened in the weekend gap.
  c('Monday after spring forward', hoursBetween(springMon.start, springMon.end), 24),
  c(
    'Monday after fall back',
    hoursBetween(tradingDayBounds('2026-11-02').start, tradingDayBounds('2026-11-02').end),
    24
  ),
]);

group('bounds: Friday absorbs the DST hour in its gap', [
  c('an ordinary Friday spans 72 hours', hoursBetween(winterFri.start, winterFri.end), 72),
  c('the spring-forward Friday spans 71', hoursBetween(springFri.start, springFri.end), 71),
  c('the fall-back Friday spans 73', hoursBetween(autumnFri.start, autumnFri.end), 73),
]);

// The invariant every query site depends on: `[start, end)` holds exactly the
// instants the day is named for. Sampled across a year at half-hour steps.
let mismatches = 0;
let sampled = 0;
for (let i = 0; i < 365 * 48; i++) {
  const at = new Date(Date.parse('2026-01-01T00:17:00Z') + i * 30 * 60 * 1000);
  const day = tradingDayOf(at);
  const { start, end } = tradingDayBounds(day);
  sampled++;
  if (!(at >= start && at < end)) mismatches++;
}

group('bounds round-trip: tradingDayOf(t) === d implies start <= t < end', [
  c('instants sampled across 2026', sampled, 365 * 48),
  c('instants outside their own day bounds', mismatches, 0),
]);

// ── Stepping backwards ──────────────────────────────────────────────────────

group('previousTradingDay skips the weekend', [
  c('Tuesday -> Monday', previousTradingDay('2026-01-20'), '2026-01-19'),
  c('Monday -> Friday, not Sunday', previousTradingDay('2026-01-19'), '2026-01-16'),
  c('Friday -> Thursday', previousTradingDay('2026-01-16'), '2026-01-15'),
  c('across a month boundary', previousTradingDay('2026-02-02'), '2026-01-30'),
  c('across a year boundary', previousTradingDay('2026-01-01'), '2025-12-31'),
]);

group('tradingDaysEndingAt is a dense axis of sessions', [
  c('five days ending Friday are that week', tradingDaysEndingAt('2026-01-16', 5), [
    '2026-01-12',
    '2026-01-13',
    '2026-01-14',
    '2026-01-15',
    '2026-01-16',
  ]),
  c('oldest first', tradingDaysEndingAt('2026-01-16', 3)[0], '2026-01-14'),
  c('ten sessions span two weeks, not ten dates', tradingDaysEndingAt('2026-01-16', 10)[0], '2026-01-05'),
  c('one is itself', tradingDaysEndingAt('2026-01-16', 1), ['2026-01-16']),
]);

// ── Reading a trade row ─────────────────────────────────────────────────────

group('tradingDayOfTrade: closed_at, falling back to submitted_at', [
  c('a closed trade dates by its close', tradingDayOfTrade({
    submitted_at: '2026-01-14T15:00:00Z',
    closed_at: WINTER_0130_ISRAEL,
  }), '2026-01-15'),
  c('an open trade dates by its submission', tradingDayOfTrade({
    submitted_at: '2026-01-14T15:00:00Z',
    closed_at: null,
  }), '2026-01-14'),
  c('no timestamps at all', tradingDayOfTrade({ submitted_at: null, closed_at: null }), null),
  // Defensive, like the `slice(0, 10)` it replaced: a malformed column drops
  // the row out of every bucket rather than throwing inside a render.
  c('unparseable close', tradingDayOfIso('not a date'), null),
  c('empty string', tradingDayOfIso(''), null),
  c('undefined', tradingDayOfIso(undefined), null),
]);

// ── What the module refuses ─────────────────────────────────────────────────
//
// There is no Saturday trading day and no Sunday one, so bounding either would
// mean inventing a window that overlaps Friday's and double-counts the gap.

group('refusals', [
  c('bounds of a Saturday', threw(() => tradingDayBounds('2026-01-17')), 'RangeError'),
  c('bounds of a Sunday', threw(() => tradingDayBounds('2026-01-18')), 'RangeError'),
  c('bounds of a malformed day', threw(() => tradingDayBounds('2026-1-5')), 'RangeError'),
  c('bounds of a day that is not one', threw(() => tradingDayBounds('2026-02-31')), 'RangeError'),
  c('tradingDayOf of an invalid Date', threw(() => tradingDayOf(new Date('nope'))), 'RangeError'),
]);

// ── The label and its tooltip (item 4) ──────────────────────────────────────

group('the day label', [
  c('the ticket\'s own example', tradingDayLabel('2026-10-27'), 'יום מסחר 27.10'),
  c('single-digit day, he-IL style', tradingDayLabel('2026-11-03'), 'יום מסחר 3.11'),
  c('single-digit month', tradingDayLabel('2026-01-14'), 'יום מסחר 14.1'),
  c('malformed input renders nothing rather than "Invalid Date"', tradingDayLabel('tomorrow'), ''),
]);

// THE TOOLTIP IS DERIVED, AND THESE CASES ARE WHY. The ticket specifies
// "מ-01:00 עד 00:00 שעון ישראל (שעון חורף)", which is correct for most of the
// year — and NOT for 27.10.2026, the day the decision was written, because
// Israel had already gone back to winter time and Chicago had not. A hard-coded
// string would have shipped wrong.
group('the window note, in Israeli hours', [
  c(
    'deep winter: the ticket\'s string exactly',
    tradingDayWindowNote('2026-01-14'),
    'מ-01:00 עד 00:00 שעון ישראל (שעון חורף)'
  ),
  c(
    'summer: the same hours, the other season',
    tradingDayWindowNote('2026-07-14'),
    'מ-01:00 עד 00:00 שעון ישראל (שעון קיץ)'
  ),
  c(
    'the crossed week the decision was written in: an hour earlier',
    tradingDayWindowNote('2026-10-27'),
    'מ-00:00 עד 23:00 שעון ישראל (שעון חורף)'
  ),
  c(
    'the March crossed week: also an hour earlier',
    tradingDayWindowNote('2026-03-11'),
    'מ-00:00 עד 23:00 שעון ישראל (שעון חורף)'
  ),
  // A Friday's note describes the SESSION, 17:00 to 16:00 — not the weekend gap
  // that follows it. A tooltip that said "until Sunday" would be describing the
  // attribution window, which is not a thing a trader has a name for.
  c(
    'a Friday reads like any other day',
    tradingDayWindowNote('2026-01-16'),
    'מ-01:00 עד 00:00 שעון ישראל (שעון חורף)'
  ),
]);

// ── CROSS-SURFACE: item 3 ───────────────────────────────────────────────────
//
// "One trade closed at 01:30 Israel (winter) appears on the same trading day
// everywhere." Everywhere is six surfaces, and this group reaches the REAL
// exported seam each one now calls rather than re-deriving the day:
//
//   dashboard dailyPnl / dayMap   -> tradingDayOfTrade
//   journal calendar cell         -> tradingDayOfTrade
//   stats page daily chart        -> tradingDayOfTrade
//   weekly card + coach prompt    -> computeWeeklyStats, over tradingDayOfTrade
//   rule engine loss + count      -> currentTradingDayStart
//   both alert emails             -> alertRangeStart
//
// The two query seams are asserted to produce the SAME INSTANT, and that
// instant is asserted to contain the trade. That is the whole claim: a figure
// cut at either boundary includes this trade, and a bucket keyed by any of the
// display seams calls it the same day.

const CROSS_TRADE = {
  // Submitted on the Wednesday afternoon, closed at 01:30 Israel the next
  // morning — the exact row §2.2 uses to show the surfaces disagreeing.
  submitted_at: '2026-01-14T15:00:00Z',
  closed_at: WINTER_0130_ISRAEL,
  status: 'closed',
  exit_price: 21_500,
  entry_price: 21_450,
  actual_pnl: 250,
  pnl_amount: null,
  direction: 'long',
  plan_score: 80,
  rr_ratio: 2,
  emotional_state: 4,
  take_profit: null,
  stop_loss: null,
  exit_reason: null,
  post_trade_notes: null,
  strategy: 'ICT',
};

const EXPECTED_DAY = '2026-01-15';

// "Now" is a moment inside that same trading day: 09:00 Chicago on the
// Thursday, which is the hour a trader would actually be looking at these
// screens.
const NOW_INSIDE_THE_DAY = new Date('2026-01-15T15:00:00Z');

const ruleEngineStart = currentTradingDayStart(NOW_INSIDE_THE_DAY);
const emailStart = alertRangeStart('end_of_day', NOW_INSIDE_THE_DAY);

// The weekly card's bars, over the civil week containing the trade. 2026-01-11
// is the Sunday; `computeWeeklyStats` looks up seven civil dates in a map this
// module keys by trading day.
const weekly = computeWeeklyStats([CROSS_TRADE] as never, new Date(Date.UTC(2026, 0, 11)));
const weeklyDayWithMoney = weekly.daily_pnl.filter((d) => d.trades > 0);

group('cross-surface: one trade closed at 01:30 Israel, winter', [
  // The day every display bucket files it under.
  c('dashboard / journal / stats bucket', tradingDayOfTrade(CROSS_TRADE), EXPECTED_DAY),
  c('and the day in progress at 09:00 Chicago that morning', currentTradingDay(NOW_INSIDE_THE_DAY), EXPECTED_DAY),

  // The weekly card's seven bars, which the coach prompt is handed verbatim.
  c('weekly card puts it on one day only', weeklyDayWithMoney.length, 1),
  c('weekly card names that day', weeklyDayWithMoney[0]?.date, EXPECTED_DAY),
  c('weekly card carries its money', weeklyDayWithMoney[0]?.pnl, 250),
  c('the week\'s best trade names the same day', weekly.best_trade?.date, EXPECTED_DAY),

  // The two query seams, which must be one instant.
  c('rule engine and email cut at the same instant', emailStart, ruleEngineStart.toISOString()),
  // And the rule engine's shipped export agrees with the module, right now, on
  // whatever day the suite happens to be run. `startOfTradingDayIso` reads the
  // clock, so this is the one assertion here that cannot take a fixture — and
  // it is the one that would catch the two drifting apart in a later edit.
  c(
    'startOfTradingDayIso is the current day\'s open',
    startOfTradingDayIso(),
    currentTradingDayStart(new Date()).toISOString()
  ),
  c('and that instant is the day\'s open', ruleEngineStart.toISOString(), tradingDayBounds(EXPECTED_DAY).start.toISOString()),
  c('which reads 17:00 Chicago', wallClock(ruleEngineStart.toISOString(), TRADING_DAY_ZONE), '2026-01-14 17:00'),

  // And the trade is inside it, which is the thing that was false before.
  c('the trade is at or after the boundary', Date.parse(CROSS_TRADE.closed_at) >= ruleEngineStart.getTime(), true),
  // The old boundaries, for the record. The dashboard's UTC date and the
  // email's Israel midnight disagreed; both now resolve to the day above.
  c('the old UTC dashboard key disagreed', WINTER_0130_ISRAEL.slice(0, 10) === EXPECTED_DAY, false),
]);

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('trading day: all groups passed');

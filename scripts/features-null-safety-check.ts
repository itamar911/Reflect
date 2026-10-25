/**
 * Null-safety and direction regression suite for the feature layer (REF-107
 * stage 4).
 *
 * THE TWO DEFECTS THIS PINS DOWN, both documented in
 * ~/Desktop/reflect-reports/ref-107-investigation.md:
 *
 *   §0ד — DIRECTION BLINDNESS. Several features derived a trade's direction
 *   from `take_profit >= entry_price` instead of reading the `direction`
 *   column, so a short that made money was counted as a loss. This is not a
 *   future problem: it is wrong today for every manual short, and it is the
 *   same family of bug the header of lib/rules/tradeRuleContext.ts records
 *   having already shipped once.
 *
 *   §0ג — AVERAGES OVER `trades.length`. `avgRR` and `avgEmotional` divided by
 *   the number of trades rather than the number of trades that carried a
 *   value. `Number(null)` is 0, not NaN, so a row without a self-report did
 *   not fail to contribute — it voted zero, and it did so in the strict
 *   direction: toward "Emotional Trader" and "Aggressive Scalper". The broker
 *   rows REF-107 will write carry none of these columns, which is why stage 4
 *   lands before stage 2.
 *
 * The fixtures below are therefore built around one question: does a row with
 * every intent field null change an answer it has no business changing?
 *
 * No network, no Supabase, no credential, no .env. Pure functions and
 * fixtures, following the precedent of scripts/money-format-check.ts and
 * scripts/tradovate-today-check.ts — this repository has no unit-test runner,
 * and adding one for a single ticket would be a larger change than the ticket.
 *
 * Usage: npm run test:null-safety
 * Exits non-zero on the first failing group's summary.
 */

import { computeTraderProfile } from '../src/lib/identity';
import { buildTradeSummary } from '../src/app/api/ai-coach/route';
import {
  computeStats as computeSetupStats,
  type LinkedTrade as SetupLinkedTrade,
} from '../src/components/setups/SetupsClient';
import { computeStats as computeStrategyStats } from '../src/components/strategies/StrategiesClient';
import { computeWeeklyStats, type TradeRow } from '../src/lib/weekly/stats';
import { exportRow, type ExportTrade } from '../src/lib/journal/csv';
import { tradeDirection, tradePointsPnl, tradeMoneyPnl, isWinningTrade, pnlRow } from '../src/lib/pnl';
import { averageOf, rrValue, scaleValue, intentText, intentNumber } from '../src/lib/intent';

// ── Harness ──────────────────────────────────────────────────────────────────

interface Case {
  label: string;
  got: unknown;
  want: unknown;
}

const failures: string[] = [];

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function group(name: string, cases: Case[]) {
  const bad = cases.filter((x) => !same(x.got, x.want));
  console.log(`${bad.length ? 'FAIL  ' : 'ok    '}${name}  (${cases.length - bad.length}/${cases.length})`);
  for (const x of bad) {
    console.log(`         ${x.label}: got ${show(x.got)} want ${show(x.want)}`);
    failures.push(`${name} / ${x.label}`);
  }
}

const c = (label: string, got: unknown, want: unknown): Case => ({ label, got, want });

// ── Fixtures ─────────────────────────────────────────────────────────────────
//
// Four rows, each standing for one thing that can reach the journal:
//
//   LONG_WIN    a manual long that worked — the case that was always right
//   SHORT_WIN   a manual short that worked — THE BUG. Price fell, so
//               `exit_price > entry_price` is false and every direction-blind
//               reader called it a loss. `direction: 'short'` is the only
//               thing that says otherwise.
//   SHORT_LOSS  a manual short that failed, so "short" is not simply a synonym
//               for "win" in these assertions
//   BROKER      a closed, priced round-trip with EVERY intent field null —
//               what a Tradovate pull produces (§0ב). It has a direction and a
//               real dollar figure, and nothing else.

/** One journal row, with every intent column nullable — the stage-2 shape. */
interface Fixture {
  id: string;
  strategy: string | null;
  symbol: string | null;
  status: string;
  direction: 'long' | 'short' | null;
  entry_price: number;
  exit_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  rr_ratio: number | null;
  trade_reason: string | null;
  emotional_state: number | null;
  confidence_level: number | null;
  pnl_amount: number | null;
  actual_pnl: number | null;
  plan_score: number | null;
  submitted_at: string;
  closed_at: string | null;
  exit_reason: string | null;
  post_trade_notes: string | null;
}

const LONG_WIN: Fixture = {
  id: 'long-win',
  strategy: 'Breakout',
  symbol: 'AAPL',
  status: 'closed',
  direction: 'long',
  entry_price: 100,
  exit_price: 110,
  stop_loss: 95,
  take_profit: 115,
  rr_ratio: 3,
  trade_reason: 'פריצה מאושרת',
  emotional_state: 4,
  confidence_level: 4,
  pnl_amount: 1000,
  actual_pnl: 1000,
  plan_score: 80,
  submitted_at: '2026-10-05T10:00:00.000Z',
  closed_at: '2026-10-05T11:00:00.000Z',
  exit_reason: null,
  post_trade_notes: null,
};

// Entry 100, exit 90: the price went DOWN, and the trader was short, so this
// made money. `take_profit` (85) is below entry, which is the only reason the
// old fallback would have got the direction right — `direction` is what makes
// it right regardless.
const SHORT_WIN: Fixture = {
  ...LONG_WIN,
  id: 'short-win',
  strategy: 'Range Reversal',
  direction: 'short',
  entry_price: 100,
  exit_price: 90,
  stop_loss: 105,
  take_profit: 85,
  rr_ratio: 2,
  emotional_state: 5,
  pnl_amount: 1000,
  actual_pnl: 1000,
  submitted_at: '2026-10-06T10:00:00.000Z',
  closed_at: '2026-10-06T11:00:00.000Z',
};

// The same short, the other way: price rose against it.
const SHORT_LOSS: Fixture = {
  ...SHORT_WIN,
  id: 'short-loss',
  exit_price: 108,
  pnl_amount: -800,
  actual_pnl: -800,
  emotional_state: 2,
  submitted_at: '2026-10-07T10:00:00.000Z',
  closed_at: '2026-10-07T11:00:00.000Z',
};

// A SHORT WITH NO take_profit AT ALL — the shape that makes `direction` the
// only available answer. Under the old `Number(null) >= Number(entry)` guess
// this resolved to 'short' by accident; under a `?? 0` placeholder it would
// have resolved to 'short' as well, but a LONG with a null take_profit would
// have flipped. Both are covered below.
const BROKER: Fixture = {
  id: 'broker',
  strategy: null,
  symbol: 'ESZ6',
  status: 'closed',
  direction: 'short',
  entry_price: 5000,
  exit_price: 4990,
  stop_loss: null,
  take_profit: null,
  rr_ratio: null,
  trade_reason: null,
  emotional_state: null,
  confidence_level: null,
  pnl_amount: 500,
  actual_pnl: 500,
  plan_score: null,
  submitted_at: '2026-10-08T10:00:00.000Z',
  closed_at: '2026-10-08T11:00:00.000Z',
  exit_reason: null,
  post_trade_notes: null,
};

const BROKER_LONG: Fixture = {
  ...BROKER,
  id: 'broker-long',
  direction: 'long',
  entry_price: 5000,
  exit_price: 5010,
  pnl_amount: 500,
  actual_pnl: 500,
};

// ── Group 1: direction is read, not guessed ──────────────────────────────────

group('direction comes from the column', [
  c('(1) a manual long is long', tradeDirection(LONG_WIN), 'long'),
  c('(2) a manual short is short', tradeDirection(SHORT_WIN), 'short'),
  // The regression itself: without `direction`, tp(85) < entry(100) happens to
  // give the right answer — so the assertion that matters is the inverse one,
  // where the column disagrees with the comparison.
  c('(3) the column wins over a contradicting take_profit', tradeDirection({
    status: 'closed', entry_price: 100, exit_price: 90, take_profit: 120, direction: 'short',
  }), 'short'),
  c('(4) a broker short with no take_profit is still short', tradeDirection(BROKER), 'short'),
  c('(5) a broker long with no take_profit is still long', tradeDirection(BROKER_LONG), 'long'),
  // A row with neither resolves to long, i.e. the raw exit−entry move. The
  // alternative — Number(null) >= Number(entry) being false — would silently
  // invert the sign of every such row.
  c('(6) neither column nor target: the raw move, not an inverted one', tradeDirection({
    status: 'closed', entry_price: 100, exit_price: 110, take_profit: null, direction: null,
  }), 'long'),
  // The legacy fallback still works for rows written before `direction`.
  c('(7) a pre-direction row still reads its take_profit', tradeDirection({
    status: 'closed', entry_price: 100, exit_price: 90, take_profit: 85, direction: null,
  }), 'short'),
]);

group('a profitable short is a win', [
  c('(1) points P&L of the winning short is positive', tradePointsPnl(SHORT_WIN), 10),
  c('(2) and it is a win', isWinningTrade(SHORT_WIN), true),
  c('(3) the losing short is a loss', isWinningTrade(SHORT_LOSS), false),
  c('(4) the winning long is a win', isWinningTrade(LONG_WIN), true),
  c('(5) the broker short is a win', isWinningTrade(BROKER), true),
  // The naive test, stated explicitly so the fixture's point cannot be lost:
  // on SHORT_WIN it says "loss", and that is exactly the shipped defect.
  c('(6) the comparison this replaces would have said loss',
    Number(SHORT_WIN.exit_price) > Number(SHORT_WIN.entry_price), false),
  c('(7) pnlRow adapts a loose row and reaches the same verdict',
    isWinningTrade(pnlRow(SHORT_WIN as unknown as Record<string, unknown>)), true),
]);

// ── Group 2: averages skip the rows that carry nothing ───────────────────────

const MIXED = [LONG_WIN, SHORT_WIN, SHORT_LOSS, BROKER, BROKER_LONG];

group('intent readers tell null from zero', [
  c('(1) null is not a number', intentNumber(null), null),
  c('(2) empty string is not zero', intentNumber(''), null),
  c('(3) a numeric string is its number (PostgREST sends NUMERIC as text)', intentNumber('2.5'), 2.5),
  c('(4) zero really is zero', intentNumber(0), 0),
  c('(5) a scale value outside 1..5 is dropped', [scaleValue(0), scaleValue(6), scaleValue(3)], [null, null, 3]),
  c('(6) a negative R:R is not a ratio', rrValue(-1), null),
  c('(7) blank text is no text', [intentText('  '), intentText(null), intentText('Breakout')], [null, null, 'Breakout']),
]);

group('averages divide by the rows that carry a value', [
  // Three rows carry an R:R (3, 2, 2); two carry none. 7/3, not 7/5.
  c('(1) avgRR over the mixed set', averageOf(MIXED, (t) => rrValue(t.rr_ratio)), 7 / 3),
  c('(2) and not over every row', averageOf(MIXED, (t) => rrValue(t.rr_ratio)) === 7 / 5, false),
  // Emotional: 4, 5, 2 → 11/3.
  c('(3) avgEmotional over the mixed set', averageOf(MIXED, (t) => scaleValue(t.emotional_state)), 11 / 3),
  // The whole point: an all-null set averages to null, never to 0.
  c('(4) no eligible rows gives null, not 0',
    averageOf([BROKER, BROKER_LONG], (t) => rrValue(t.rr_ratio)), null),
  c('(5) same for the self-report',
    averageOf([BROKER, BROKER_LONG], (t) => scaleValue(t.emotional_state)), null),
  c('(6) an empty set gives null', averageOf([], () => 1), null),
]);

// ── Group 3: the identity verdict ────────────────────────────────────────────
//
// `computeTraderProfile` needs five rows before it says anything, so each
// fixture set below has at least five.

/** Five broker rows: closed, priced, and carrying no intent whatsoever. */
const ALL_BROKER = Array.from({ length: 6 }, (_, i) => ({
  ...BROKER,
  id: `broker-${i}`,
  // Spread across a fortnight so tradesPerWeek lands near 3 — comfortably
  // under the `>= 4` that the Aggressive Scalper branch also requires, so the
  // assertion below is about avgRR being null rather than about the rate.
  submitted_at: `2026-10-${String(1 + i * 2).padStart(2, '0')}T10:00:00.000Z`,
  closed_at: `2026-10-${String(1 + i * 2).padStart(2, '0')}T11:00:00.000Z`,
}));

/** The same six rows, traded six times a week — the Aggressive Scalper rate. */
const ALL_BROKER_FAST = Array.from({ length: 6 }, (_, i) => ({
  ...BROKER,
  id: `fast-${i}`,
  submitted_at: `2026-10-0${1 + i}T10:00:00.000Z`,
  closed_at: `2026-10-0${1 + i}T11:00:00.000Z`,
}));

const brokerProfile = computeTraderProfile(ALL_BROKER);
const brokerFastProfile = computeTraderProfile(ALL_BROKER_FAST);

group('identity falls back to neutral when its inputs are null', [
  // Before stage 4: avgEmotional was 0, `0 <= 2.5` held, and the verdict was
  // 'Emotional Trader' — a label earned by the sync, not by the trading.
  c('(1) no self-report does not make an Emotional Trader', brokerProfile.identity, 'Developing Trader'),
  // And the second trap: avgRR was 0, `0 < 1.8` held, so a trader over the
  // rate threshold got 'Aggressive Scalper' for the same non-reason.
  c('(2) nor an Aggressive Scalper at six trades a week', brokerFastProfile.identity, 'Developing Trader'),
  // No sentence may quote a figure that does not exist.
  c('(3) no strength quotes an R:R or a state',
    brokerProfile.strengths.filter((s) => s.includes('1:0') || s.includes('0.0/5')), []),
  c('(4) no weakness quotes one either',
    brokerProfile.weaknesses.filter((s) => s.includes('1:0') || s.includes('0.0/5')), []),
  c('(5) and neither list is empty',
    [brokerProfile.strengths.length > 0, brokerProfile.weaknesses.length > 0], [true, true]),
]);

/** Five disciplined manual longs — the control: real inputs, real verdict. */
const DISCIPLINED = Array.from({ length: 6 }, (_, i) => ({
  ...LONG_WIN,
  id: `disciplined-${i}`,
  emotional_state: 4,
  rr_ratio: 2,
  submitted_at: `2026-10-${String(1 + i * 2).padStart(2, '0')}T10:00:00.000Z`,
  closed_at: `2026-10-${String(1 + i * 2).padStart(2, '0')}T11:00:00.000Z`,
}));

/** The same trader, with one broker row synced in among them. */
const DISCIPLINED_PLUS_BROKER = [...DISCIPLINED, { ...BROKER, id: 'broker-in-the-mix' }];

group('one broker row does not change a measured verdict', [
  c('(1) the control reads as a Disciplined Sniper',
    computeTraderProfile(DISCIPLINED).identity, 'Disciplined Sniper'),
  // Before stage 4 this one row dragged avgEmotional from 4.0 to ~3.43 (under
  // the 3.8 the Sniper branch needs) and avgRR from 2.0 to ~1.71, and the
  // verdict silently became something else.
  c('(2) and still does with a broker row alongside',
    computeTraderProfile(DISCIPLINED_PLUS_BROKER).identity, 'Disciplined Sniper'),
]);

group('identity counts a profitable short as a win', [
  // Six shorts that all made money. Every one of them has exit < entry, so a
  // direction-blind win test scores this trader at 0%.
  c('(1) six winning shorts do not read as a 0% win rate',
    computeTraderProfile(Array.from({ length: 6 }, (_, i) => ({
      ...SHORT_WIN,
      id: `s-${i}`,
      submitted_at: `2026-10-${String(1 + i * 2).padStart(2, '0')}T10:00:00.000Z`,
      closed_at: `2026-10-${String(1 + i * 2).padStart(2, '0')}T11:00:00.000Z`,
    }))).weaknesses.filter((w) => w.includes('אחוז הצלחה 0%')), []),
]);

// ── Group 4: the weekly summary ──────────────────────────────────────────────

const WEEK_START = new Date('2026-10-04T00:00:00.000Z');

function weekRow(t: Fixture): TradeRow {
  return {
    strategy: t.strategy,
    entry_price: t.entry_price,
    exit_price: t.exit_price,
    take_profit: t.take_profit,
    stop_loss: t.stop_loss,
    emotional_state: t.emotional_state,
    direction: t.direction,
    plan_score: t.plan_score,
    status: t.status,
    pnl_amount: t.pnl_amount,
    actual_pnl: t.actual_pnl,
    closed_at: t.closed_at,
    submitted_at: t.submitted_at,
    exit_reason: t.exit_reason,
    post_trade_notes: t.post_trade_notes,
  };
}

const shortsOnly = computeWeeklyStats([weekRow(SHORT_WIN), weekRow(SHORT_WIN)], WEEK_START);
const weekMixed = computeWeeklyStats(
  [weekRow(LONG_WIN), weekRow(SHORT_WIN), weekRow(SHORT_LOSS), weekRow(BROKER)],
  WEEK_START,
);
const weekBrokerOnly = computeWeeklyStats([weekRow(BROKER), weekRow(BROKER_LONG)], WEEK_START);

group('weekly winRate reads direction', [
  // Two profitable shorts. Before stage 4 `tradePoints` derived direction from
  // tp-vs-entry and `winRate` counted `points > 0`, so a week of winning
  // shorts could be reported as 0%.
  c('(1) a week of two winning shorts is 100%', shortsOnly.win_rate, 100),
  c('(2) and both are counted as wins', shortsOnly.winning_trades, 2),
  c('(3) with no losses', shortsOnly.losing_trades, 0),
  // Mixed: long win, short win, short loss, broker win → 3 of 4.
  c('(4) the mixed week is 3 of 4', [weekMixed.winning_trades, weekMixed.losing_trades, weekMixed.win_rate], [3, 1, 75]),
]);

group('weekly averages and buckets skip null intent', [
  // 4, 5, 2 across the three manual rows; the broker row carries none.
  c('(1) emotional averages over three rows, not four', weekMixed.avg_emotional_state, 3.7),
  // Before stage 4 the filter was `.filter(Number.isFinite)` and `Number(null)`
  // is 0 — a finite number — so the broker row averaged in as a zero: 11/4 = 2.8.
  c('(2) and not as (4+5+2+0)/4', weekMixed.avg_emotional_state === 2.8, false),
  c('(3) a week of broker rows reports null, not 0', weekBrokerOnly.avg_emotional_state, null),
  c('(4) a row with no strategy is not the most-used strategy', weekBrokerOnly.most_used_strategy, null),
  c('(5) and does not become a bucket named null in a mixed week',
    weekMixed.most_used_strategy, 'Range Reversal'),
  c('(6) best/worst name no strategy rather than "null"',
    [weekMixed.best_trade?.strategy !== 'null', weekMixed.worst_trade?.strategy !== 'null'], [true, true]),
  // plan_score already degraded gracefully; asserted so it stays that way.
  c('(7) process score still skips unscored rows', weekBrokerOnly.avg_process_score, null),
]);

// ── Group 5: the CSV export ──────────────────────────────────────────────────

function csvTrade(t: Fixture): ExportTrade {
  return {
    submitted_at: t.submitted_at,
    strategy: t.strategy,
    entry_price: t.entry_price,
    stop_loss: t.stop_loss,
    take_profit: t.take_profit,
    rr_ratio: t.rr_ratio,
    emotional_state: t.emotional_state,
    trade_reason: t.trade_reason,
    status: t.status,
    debrief_answer: null,
  };
}

const brokerCells = exportRow(csvTrade(BROKER));
const longCells = exportRow(csvTrade(LONG_WIN));
// Columns: 0 date, 1 time, 2 strategy, 3 entry, 4 SL, 5 TP, 6 R:R, 7 emotional,
// 8 reason, 9 debrief, 10 status.

group('CSV exports a missing intent field as an empty cell', [
  c('(1) strategy', brokerCells[2], '""'),
  c('(2) stop loss', brokerCells[4], ''),
  c('(3) take profit', brokerCells[5], ''),
  c('(4) R:R', brokerCells[6], ''),
  c('(5) emotional state', brokerCells[7], ''),
  c('(6) entry reason', brokerCells[8], '""'),
  // The two wrong answers, named: a spreadsheet will average a "0" column and
  // will show "null" to the trader as if they had typed it.
  c('(7) never the literal "null"', brokerCells.filter((x) => x.includes('null')), []),
  c('(8) never a fabricated 0', [brokerCells[4], brokerCells[5], brokerCells[6], brokerCells[7]].filter((x) => x === '0' || x === '0.00'), []),
  c('(9) the entry price, which the broker does know, is still there', brokerCells[3], '5000'),
  c('(10) status is still labelled', brokerCells[10], 'סגור'),
]);

group('CSV still exports a filled row in full', [
  c('(1) strategy', longCells[2], '"Breakout"'),
  c('(2) stop loss', longCells[4], '95'),
  c('(3) take profit', longCells[5], '115'),
  c('(4) R:R keeps two decimals', longCells[6], '3.00'),
  c('(5) emotional state', longCells[7], '4'),
  c('(6) entry reason is quoted', longCells[8], '"פריצה מאושרת"'),
  // PostgREST sends NUMERIC as a string; the `typeof v === 'number'` test this
  // replaced silently exported a blank R:R for every such row.
  c('(7) a numeric string is not dropped',
    exportRow({ ...csvTrade(LONG_WIN), rr_ratio: '2.5' as unknown as number })[6], '2.50'),
  // A strategy with a comma must not shift every later column by one.
  c('(8) a comma in a strategy name does not break the row',
    exportRow({ ...csvTrade(LONG_WIN), strategy: 'Breakout, London' }).length, 11),
]);

// ── REF-115 / REF-106: points shown as dollars ───────────────────────────────
//
// THE ONE FIXTURE ROW THAT SEPARATES THE TWO UNITS. A broker round trip whose
// price moved 5 points and whose recorded money is $250 — a $50-a-point
// contract, which is ES. Every site in REF-115 summed the 5 and labelled it
// `$`, so this row reads 250 everywhere after the fix and 5 before it. A row
// where the two numbers coincide could not tell the difference, which is why
// this one is 50x apart.
//
// SHORT, so the same assertions double as the §0ד check: price FELL from 5000
// to 4995, the trader was short, the trade made money. Anything reading
// `exit > entry` calls it a loss.

const POINTS_VS_DOLLARS: Fixture = {
  ...BROKER,
  id: 'five-points-two-fifty',
  // Named, so the STRATEGY breakdown exists as well as the hourly one.
  // Inherited from BROKER this was null, the bucket was skipped, and
  // assertion (11) passed on the hourly breakdown's copy of the same string.
  strategy: 'Range Reversal',
  direction: 'short',
  entry_price: 5000,
  exit_price: 4995,
  pnl_amount: 250,
  actual_pnl: 250,
  rr_ratio: null,
};

/** The same trade with no money recorded at all — the "ללא סכום" shape. */
const NO_MONEY: Fixture = {
  ...POINTS_VS_DOLLARS,
  id: 'priced-by-nothing',
  pnl_amount: null,
  actual_pnl: null,
};

const setupTrade = (f: Fixture, setupId: string | null): SetupLinkedTrade => ({
  id: f.id,
  strategy: f.strategy ?? '',
  symbol: f.symbol,
  entry_price: f.entry_price,
  exit_price: f.exit_price,
  status: f.status,
  setup_id: setupId,
  submitted_at: f.submitted_at,
  rr_ratio: f.rr_ratio,
  take_profit: f.take_profit,
  direction: f.direction,
  pnl_amount: f.pnl_amount,
  actual_pnl: f.actual_pnl,
});

const strategyTrade = (f: Fixture) => ({
  id: f.id,
  strategy: f.strategy ?? '',
  symbol: f.symbol,
  entry_price: f.entry_price,
  exit_price: f.exit_price,
  take_profit: f.take_profit,
  rr_ratio: f.rr_ratio,
  status: f.status,
  direction: f.direction,
  pnl_amount: f.pnl_amount,
  actual_pnl: f.actual_pnl,
  submitted_at: f.submitted_at,
  closed_at: f.closed_at,
});

const SETUP_ID = 'setup-1';
const setupStats = computeSetupStats(SETUP_ID, [setupTrade(POINTS_VS_DOLLARS, SETUP_ID)]);
const setupStatsNoRR = computeSetupStats(SETUP_ID, [
  setupTrade(POINTS_VS_DOLLARS, SETUP_ID),
  setupTrade({ ...LONG_WIN, rr_ratio: 3 }, SETUP_ID),
]);
const strategyStats = computeStrategyStats(
  POINTS_VS_DOLLARS.strategy ?? '',
  [strategyTrade(POINTS_VS_DOLLARS)]
);

const coachSummary = buildTradeSummary([POINTS_VS_DOLLARS as unknown as Record<string, unknown>]);
const coachNoMoney = buildTradeSummary([NO_MONEY as unknown as Record<string, unknown>]);

group('REF-115 / REF-106: five points is $250, not $5', [
  // The two numbers this group is about, stated once so a later reader can
  // see what every assertion below is distinguishing.
  c('(0) the fixture moved 5 points and made $250',
    [tradePointsPnl(POINTS_VS_DOLLARS), tradeMoneyPnl(POINTS_VS_DOLLARS)], [5, 250]),

  // ── Site 3: setups (REF-106) ───────────────────────────────────────────
  c('(1) a setup\'s total P&L is money', setupStats.totalPnl, 250),
  c('(2) and its average is money', setupStats.avgPnl, 250),
  // The profitable short. `exit_price - entry_price` is -5 here, so anything
  // direction-blind reports a loss and a 0% win rate.
  c('(3) a profitable short is a win', setupStats.winRate, 100),
  // §0ג: averaged over the rows that carry a ratio, not over every linked row.
  c('(4) avgRR skips the row with no planned ratio', setupStatsNoRR.avgRR, 3),
  c('(5) and is null when NO row carries one', setupStats.avgRR, null),

  // ── Site 4: strategies ─────────────────────────────────────────────────
  c('(6) a strategy\'s total P&L is money', strategyStats.totalPnl, 250),
  c('(7) and its win rate reads the money', strategyStats.winRate, 100),

  // ── Site 2: ai-coach ───────────────────────────────────────────────────
  // Six figures are labelled for the model and the system prompt tells it to
  // quote them back as dollars. The summary is a string, so these assert on
  // what Claude actually receives.
  c('(8) the coach is told the money total', coachSummary.includes('Total P&L: $250.00'), true),
  // ANCHORED TO THE LABEL, and it has to be (REF-120 §4.2). A bare
  // `includes('5.00')` over the whole summary was meant to catch a points total
  // of 5 formatted as `5.00` — and the fixture's exit price is 4995, so
  // `'4995.00'.includes('5.00')` is TRUE. The moment any price reaches this
  // string with two decimals the check fails, and it fails as a FALSE POSITIVE:
  // it reports "the coach is being told the points total" about an exit price.
  // (`'5000.00'` is clean and a bare `'4995'` is clean; it is specifically the
  // `…995.00` exit that collides.)
  c('(9) and never the points total', coachSummary.includes('Total P&L: $5.00'), false),
  c('(10) the winning-trades line is money', coachSummary.includes('P&L from winning trades: +$250.00'), true),
  c('(11) the strategy breakdown is money',
    coachSummary.includes('"pl":250'), true),
  c('(12) and so is the hourly one',
    (coachSummary.match(/"pl":250/g) ?? []).length, 2),

  // A row with no money contributes 0 — and a FIGURE with nothing behind it
  // says so, rather than reporting a measured $0.00. Without this, a day of
  // hand-closed rows reads as 100% success and $0.00 and the coach is asked
  // to explain it.
  c('(13) a figure with no money behind it reads ללא סכום',
    coachNoMoney.includes('Total P&L: ללא סכום'), true),
  c('(14) and never as a measured zero', coachNoMoney.includes('$0.00'), false),
  c('(15) the breakdowns say it too', coachNoMoney.includes('"pl":"ללא סכום"'), true),
  // It is still a win — isWinningTrade falls back to points — which is
  // exactly why the amount must not read $0.00 beside it.
  c('(16) the row is still counted as a win', coachNoMoney.includes('Win rate: 100%'), true),
]);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failing assertion(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All null-safety and direction groups passed.');

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
import { averageOf, rrValue, scaleValue, intentText, intentNumber, type RawValue } from '../src/lib/intent';
import { readTradeFacts, tradeFactsLine, tradeFactsSummaryLine } from '../src/lib/ai/tradeFacts';
import {
  readStopHistory,
  stopMoveSentence,
  targetMoveLine,
  targetMoveTally,
  TARGET_MOVE_LABEL,
} from '../src/lib/journal/stopHistory';
import { wasPatient } from '../src/lib/journal/patience';
import {
  DASH_TRADE_SELECT,
  mapDashTrade,
  withBrokerColumns,
  type RawTradeRow,
} from '../src/lib/dashboard/trades';
import { disciplinePatience, measuredAxes, patienceInputOf } from '../src/lib/dashboard/radar';
import { dayDiscipline, disciplineEvidenceLine } from '../src/lib/scoring/dayDiscipline';
import { realisedRr, rrLabel, rrRow } from '../src/lib/journal/realisedRr';
import { describeStages } from '../src/lib/journal/stages';
import fs from 'node:fs';
import path from 'node:path';

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

// ── Site 5: the trade serialiser the model reads (REF-120) ───────────────────
//
// `lib/ai/tradeFacts.ts` is the first module in this repository to put broker
// columns into a prompt DELIBERATELY, which is why the negative half of this
// group matters more than the positive half. Until it existed, no check
// anywhere asserted that a prompt string is free of ids, account names or host
// tokens — the repo has exactly this discipline for UI notices
// (broker-import-check.ts:2995) and for log lines (:1131), and never had it for
// prompts. Both AI routes read `select('*')`, so one `JSON.stringify(trade)`
// would leak the lot.
//
// THE FIXTURE DID NOT EXIST BEFORE THIS EITHER. There was no broker-linked row
// anywhere in the repo with the stop evidence populated: `linkStateRow('linked')`
// in broker-import-check.ts is the nearest and leaves `stop_history`,
// `broker_stop_loss` and `broker_stages` absent, `lib/demo/fixtures.ts` has none
// of the three, and `demoApi.ts` stubs both AI routes with canned answers so
// `/demo/*` never builds a prompt at all. So the whole of the stop verdict —
// five sentences — had never been exercised at the prompt level.
//
// SYNTHETIC PRICES, AND DELIBERATELY GREPPABLE SECRETS. Every id below is
// invented and chosen so that a leak is unmistakable in a diff: the account id,
// the trade key with its host token and fill id, the host label, and the prop
// firm's own name for the account. Same construction as the log-leak suite.

const ACCOUNT_ID_LEAK = 1_805_221;
const TRADE_KEY_LEAK = 'demo:88412';
const HOST_LEAK = 'demo';
const ACCOUNT_NAME_LEAK = 'EVAL-A';

/**
 * Every string a facts line must never contain, including the two halves of
 * the trade key separately — the host token and the broker-side fill id are
 * each a leak on their own, which is why `broker_trade_key` is denied rather
 * than trimmed.
 */
const DENIED_STRINGS = [
  String(ACCOUNT_ID_LEAK),
  TRADE_KEY_LEAK,
  HOST_LEAK,
  ACCOUNT_NAME_LEAK,
  '88412',
  'a7f3c1d2',
  'f1e2d3c4',
  'trade-ref-120',
];

/**
 * A linked Tradovate row with the broker's stop and stage evidence on it.
 *
 * The `linkStateRow('linked')` shape — `source`, the trade key, the contract
 * name, a quantity, `link_confirmed_at`, `link_method: 'auto'` and the intent
 * the broker row could never have carried — plus the three columns that shape
 * leaves out, and the four denied fields above.
 *
 * `accounts` IS PLANTED RATHER THAN REALISTIC, and on purpose. `select('*')` on
 * `trade_plans` never returns it; it is here so that "the module does not reach
 * into the account's name" is an assertion about a string rather than a claim
 * about an import graph, which is all `accounts-check.ts` can test.
 */
const LINKED_WITH_STOPS: Record<string, unknown> = {
  id: 'trade-ref-120',
  user_id: 'a7f3c1d2-0000-4000-8000-000000000001',
  status: 'closed',
  // ── denied, every one of them ──
  source: 'tradovate',
  broker_trade_key: TRADE_KEY_LEAK,
  broker_host: HOST_LEAK,
  broker_account_id: ACCOUNT_ID_LEAK,
  account_id: 'f1e2d3c4-0000-4000-8000-000000000002',
  accounts: { display_name: ACCOUNT_NAME_LEAK, nickname: 'הקטן שלי' },
  // ── the facts ──
  symbol: 'MNQZ6',
  quantity: 2,
  direction: 'short',
  entry_price: 29834.75,
  exit_price: 29767.25,
  stop_loss: 29870,
  take_profit: 29700,
  rr_ratio: 2,
  strategy: 'Range Reversal',
  emotional_state: 4,
  actual_pnl: 270,
  pnl_amount: null,
  pnl_currency: '$',
  plan_score: 88,
  submitted_at: '2026-10-15T09:12:00.000Z',
  closed_at: '2026-10-15T09:41:00.000Z',
  unplanned: false,
  link_confirmed_at: '2026-10-16T10:00:00.000Z',
  link_method: 'auto',
  // ── the three columns linkStateRow leaves absent ──
  broker_stop_loss: 29870.25,
  stop_history: {
    verdict: 'moved',
    reason: null,
    initialStop: 29870.25,
    initialStopSide: 'risk',
    finalStop: 29850.5,
    movedCount: 2,
    direction: 'tightened',
    trailing: false,
    stopCount: 1,
    stopAtEntry: true,
    lateStop: null,
    cancelledUnreplaced: false,
  },
  // Two entries, one exit — the shape that earns a sentence at all.
  broker_stages: {
    entries: [{ qty: 1, price: 29834.75 }, { qty: 1, price: 29835.25 }],
    exits: [{ qty: 2, price: 29767.25 }],
  },
};

/** The same row with a verdict we could not read. See assertion (9). */
const LINKED_UNKNOWN_STOP: Record<string, unknown> = {
  ...LINKED_WITH_STOPS,
  id: 'trade-ref-120-unknown',
  stop_history: { verdict: 'unknown', reason: 'interday' },
};

/**
 * A hand-entered row with EVERY broker column absent — not null, absent, which
 * is what `select('*')` returns against a database where 038/040/041 have not
 * run. The file's own reason to exist, applied to the new module.
 */
const MANUAL_NO_BROKER: Record<string, unknown> = {
  id: 'manual-ref-120',
  status: 'closed',
  symbol: 'NQ',
  direction: 'long',
  entry_price: 100,
  exit_price: 110,
  stop_loss: 95,
  take_profit: 115,
  rr_ratio: 3,
  strategy: 'Breakout',
  emotional_state: 4,
  pnl_amount: 1000,
  actual_pnl: 1000,
  plan_score: 80,
  submitted_at: '2026-10-05T10:00:00.000Z',
  closed_at: '2026-10-05T11:00:00.000Z',
};

const linkedLine = tradeFactsLine(readTradeFacts(LINKED_WITH_STOPS)!);
const unknownLine = tradeFactsLine(readTradeFacts(LINKED_UNKNOWN_STOP)!);
const manualLine = tradeFactsLine(readTradeFacts(MANUAL_NO_BROKER)!);

// The sentence the TRADER is shown for this exact document, read through the
// shared function rather than written out here — so the assertion pins the
// shared sentence instead of a paraphrase of it that could drift away from it.
const traderStopSentence = stopMoveSentence(readStopHistory(LINKED_WITH_STOPS.stop_history))!.text;

group('REF-120: the facts a model is given, and the four it never is', [
  // ── The facts the coach was missing entirely ───────────────────────────
  //
  // (1) THE ROOT, NOT THE CONTRACT NAME. `MNQZ6` and `NQH7` are the same
  // instrument two quarters apart, and the expiry buys a coach nothing.
  c('(1) the symbol root is there and the contract name is not',
    [linkedLine.includes('NQ'), linkedLine.includes('MNQZ6')], [true, false]),
  c('(2) the direction is in Hebrew',
    [linkedLine.includes('שורט'), linkedLine.includes('short')], [true, false]),
  // Bare, with no toFixed — see REF-120 §4.2 and assertion (9) of the group
  // above, which a two-decimal price would have failed as a false positive.
  c('(3) the entry price is a bare number', linkedLine.includes('כניסה 29834.75'), true),
  c('(4) and so is the exit price', linkedLine.includes('יציאה 29767.25'), true),
  // (5) THE SHARED SENTENCE AND NOT A SECOND OPINION ABOUT IT. The debrief
  // route built its own English verdict from this same document until REF-120.
  c('(5) the stop verdict is the sentence the trader reads',
    [traderStopSentence, linkedLine.includes(traderStopSentence)],
    ['הסטופ הודק לכיוון הרווח (מ-29870.25 ל-29850.50)', true]),
  c('(6) and the stages sentence is the shared one too',
    [describeStages(2, 1), linkedLine.includes(describeStages(2, 1))],
    ['נכנסת בשני שלבים · יצאת בשלב אחד', true]),

  // ── The half that matters: the deny list, asserted ────────────────────
  //
  // (7) Each of the four is in the fixture and must be in none of the three
  // lines. A `JSON.stringify(trade)` in either AI route fails this instantly,
  // which is the whole reason the list is named in the module header.
  c('(7) no account id, trade key, host token or account name reaches a line',
    [linkedLine, unknownLine, manualLine, tradeFactsSummaryLine(readTradeFacts(LINKED_WITH_STOPS)!)]
      .flatMap((line) => DENIED_STRINGS.filter((secret) => line.includes(secret))),
    []),
  // AND THE FIXTURE STILL CARRIES THEM, so (7) cannot pass because somebody
  // tidied the row rather than because the module is careful. A negative
  // assertion over a fixture nobody re-checks is an assertion about nothing.
  c('(7b) and the fixture really does carry every one of them',
    DENIED_STRINGS.filter((secret) => !JSON.stringify(LINKED_WITH_STOPS).includes(secret)), []),

  // ── Null safety, which is what this file is for ────────────────────────
  //
  // (8) The template this module replaces printed `R:R — מצב-רגשי:—` on every
  // broker row. Null means SAY NOTHING: no empty label, no literal "null", no
  // stack of dashes, and no sentence about evidence that was never read.
  c('(8) a manual row with no broker columns says nothing about them',
    [
      manualLine.includes('null'),
      manualLine.includes('—'),
      manualLine.includes(': ·'),
      manualLine.endsWith(':'),
      manualLine.includes('הסטופ'),
      manualLine.includes('שלבים'),
      manualLine.includes('מקור'),
      // And it still carries everything the trader DID type.
      manualLine.includes('[רווח] NQ לונג'),
      manualLine.includes('R:R 3'),
    ],
    [false, false, false, false, false, false, false, true, true]),

  // (9) `'kept'` AND `'unknown'` ARE THE PAIR THAT MATTERS (stopHistory.ts:34).
  // Without its own sentence, a failed read reads exactly like a stop that was
  // left alone — a claim about the trader's discipline made out of our own
  // missing data. Not silence either: the trader is told we could not look.
  c('(9) an unknown verdict says so, and does not say the stop was kept',
    [
      unknownLine.includes('לא הצלחנו לקרוא את פקודות הסטופ'),
      unknownLine.includes('הסטופ לא הוזז'),
      unknownLine.includes('הודק'),
    ],
    [true, false, false]),
]);

// ── REF-123: the realised R:R ────────────────────────────────────────────────
//
// `|exit - entry| / |entry - broker_stop_loss|` — what the trade returned
// against the stop the position actually OPENED under, rather than against the
// one the trader typed into a form.
//
// THE FIXTURES ARE BUILT ON ONE TRADE WITH ONE RISK so that every ratio below
// can be checked by eye: a long from 100 with its broker stop at 95 is risking
// FIVE POINTS, so the exit price alone decides the answer. Four of the six
// cases assert a null, which is the proportion this file exists to defend —
// a ratio is only worth printing when every one of its three inputs is real.

/** The stop document for a stop that was placed, held and read cleanly. */
const rrStopDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  verdict: 'kept',
  reason: null,
  initialStop: 95,
  initialStopSide: 'risk',
  finalStop: 95,
  movedCount: 0,
  direction: null,
  trailing: false,
  stopCount: 1,
  stopAtEntry: true,
  lateStop: null,
  cancelledUnreplaced: false,
  ...over,
});

/** A long from 100, five points of real risk, exited wherever the case needs. */
const rrRow100 = (exit: number | null, doc: Record<string, unknown> | null = rrStopDoc()) => ({
  id: 'rr-123',
  status: exit === null ? 'open' : 'closed',
  symbol: 'NQ',
  direction: 'long' as const,
  entry_price: 100,
  exit_price: exit,
  stop_loss: 96,
  take_profit: 112,
  rr_ratio: 3,
  broker_stop_loss: 95,
  stop_history: doc,
  submitted_at: '2026-10-20T10:00:00.000Z',
  closed_at: exit === null ? null : '2026-10-20T11:00:00.000Z',
});

const rrOf = (row: Record<string, unknown>) =>
  realisedRr(readStopHistory(row.stop_history), row.broker_stop_loss, row.entry_price as RawValue,
    row.exit_price as RawValue);

group('REF-123: the R:R the trade actually returned', [
  // (1) THE WIN. 10.5 points made on 5 risked. The planned figure on this row
  // is 3, so the pair is also the sentence the coach could not previously say:
  // the trader planned 1:3 and banked 1:2.1.
  c('(1) a win reports the realised ratio, to one decimal',
    [rrOf(rrRow100(110.5)), rrRow(3, rrOf(rrRow100(110.5)))],
    [2.1, 'תוכנן 1:3 · בפועל 1:2.1']),

  // (2) A LOSS SHORT OF THE STOP: out at 98, so two of the five points at risk
  // were lost and the ratio is below one. IT IS NOT NEGATIVE AND NOT ZERO —
  // the magnitude is the fact, and `[הפסד]` beside it in the facts line is
  // what says which way it went (lib/journal/realisedRr.ts).
  c('(2) a sub-1R loss keeps its ratio rather than reading as a win of 0',
    [rrOf(rrRow100(98)), rrLabel(rrOf(rrRow100(98))!)],
    [0.4, '1:0.4']),

  // (3) NO STOP WAS PLACED. There is no risk denominator to divide by — not a
  // zero, not the planned stop two columns over. `brokerStopToShow` already
  // refuses the price for this verdict and the ratio refuses with it.
  c('(3) a trade with no broker stop states no realised ratio',
    [
      rrOf(rrRow100(110.5, rrStopDoc({ verdict: 'none', initialStop: null }))),
      rrOf(rrRow100(110.5, null)),
      rrOf({ ...rrRow100(110.5), broker_stop_loss: null, stop_history: null }),
    ],
    [null, null, null]),

  // (4) THE WRONG-SIDE STOP, which is the case that would have shipped a
  // confident falsehood. On 19.10 a long stored an initial stop ABOVE its
  // entry; that distance is not risk, and 10.5 divided by it is a precise
  // meaningless number. Asserted through the document, as the UI reads it.
  c('(4) a wrong-side stop states no ratio, however readable its price',
    [rrOf(rrRow100(110.5, rrStopDoc({ initialStopSide: 'wrong', initialStop: 148 })))],
    [null]),

  // (5) A ZERO DENOMINATOR. `calcRR` answers 0 here and is right to, for a form
  // that needs a number in a box; a realised 0 would be a MEASUREMENT reading
  // "this trade returned nothing".
  c('(5) entry and stop at the same price state no ratio, not zero',
    [rrOf({ ...rrRow100(110.5), broker_stop_loss: 100,
            stop_history: rrStopDoc({ initialStop: 100, finalStop: 100 }) })],
    [null]),

  // (6) AN OPEN TRADE HAS NO REALISED ANYTHING, and the row renders exactly
  // what it has always rendered — the bare planned number, with no `בפועל`
  // half and no dash standing in for one.
  c('(6) an open trade adds nothing, and the planned-only row is unchanged',
    [rrOf(rrRow100(null)), rrRow(3, null), rrRow(null, null)],
    [null, '3', null]),

  // (7) THE COACH IS TOLD, in the one line it reads per trade, and the figure
  // is the same function's — not a second implementation of the division.
  // 67.5 points on 35.5 risked, off the REF-120 fixture above.
  c('(7) the facts line carries the realised ratio beside the planned one',
    [
      linkedLine.includes('R:R 2 · יחס בפועל 1:1.9'),
      readTradeFacts(LINKED_WITH_STOPS)!.realisedRr,
      // And a wrong-side document silences it in the prompt too, so the model
      // is never handed a ratio the trader was not shown.
      readTradeFacts({
        ...LINKED_WITH_STOPS,
        stop_history: { ...(LINKED_WITH_STOPS.stop_history as object), initialStopSide: 'wrong' },
      })!.realisedRr,
      // THE PIECE THIS TICKET ADDS IS A RATIO AND NOT A PRICE, asserted on the
      // piece itself rather than by grepping the line for the stop price: the
      // broker's stop already reaches the prompt inside `stopMoveSentence`'s
      // from→to range (`הסטופ הודק לכיוון הרווח (מ-29870.25 ...)`), which
      // REF-113 shipped and REF-120 reused on purpose. A bare substring test
      // for it would also match `סטופ מתוכנן 29870` — the TRADER'S planned
      // stop, which belongs there — and that is the exact landmine the header
      // of lib/ai/tradeFacts.ts records this file stepping on once already.
      linkedLine.split(' · ').find((p) => p.startsWith('יחס בפועל')),
    ],
    [true, 1.9, null, 'יחס בפועל 1:1.9']),
]);

// ── Group 6: the dashboard radar's סבלנות axis ───────────────────────────────
//
// REF-130 part א fixed `סבלנות` on /stats and on the trade card and LEFT THE
// DASHBOARD RADAR BEHIND, which is the follow-up this group pins. The axis read
// `exited_early` alone — a self-report no broker row ever answers — so an
// imported journal scored it from an empty denominator.
//
// THE ROWS GO THROUGH `mapDashTrade`, not hand-built as `DashTrade` objects.
// That is deliberate and it is half of what broke: the wire mapping coerced a
// NULL `take_profit` to 0 with a bare `Number()`, and `intentNumber(0)` is 0,
// so a fabricated zero target would have WON the precedence in
// lib/journal/patience.ts and shut the broker's real target out. A fixture that
// skipped the mapping would have asserted a path the app does not take.

/** The wire shape of one imported row: priced, with no intent recorded. */
const dashRow = (over: Partial<RawTradeRow> = {}): RawTradeRow => ({
  id: 'dash-1',
  strategy: 'ORB',
  symbol: 'MNQZ6',
  entry_price: 30_000,
  exit_price: 29_900,
  // NULL, as migration 034 allows and as every imported row really is.
  stop_loss: null,
  take_profit: null,
  rr_ratio: 2,
  emotional_state: 3,
  trade_reason: '',
  status: 'closed',
  direction: 'short',
  exit_reason: null,
  submitted_at: '2026-10-15T10:00:00.000Z',
  closed_at: '2026-10-15T11:00:00.000Z',
  quantity: 1,
  pnl_amount: 200,
  actual_pnl: 200,
  pnl_currency: 'USD',
  plan_score: null,
  followed_plan: null,
  strategy_conditions_checked: null,
  moved_sl: null,
  exited_early: null,
  fomo_entry: null,
  revenge_trade: null,
  broker_take_profit: null,
  broker_stop_loss: null,
  ...over,
});
const dash = (over: Partial<RawTradeRow> = {}) => mapDashTrade(dashRow(over));

/** A short that reached the broker's target. The ticket's own case. */
const HIT_BROKER_TARGET = dash({
  exit_price: 29_790,
  broker_take_profit: 29_800,
  broker_stop_loss: 30_100,
});

const dashboardSource = fs.readFileSync(
  path.join(process.cwd(), 'src/components/dashboard/DashboardClient.tsx'),
  'utf8'
);

group('REF-130 follow-up: the radar measures סבלנות instead of defaulting it', [
  // ── (1) THE DEFECT ITSELF ───────────────────────────────────────────────
  //
  // An imported short that ran all the way to the broker's target. The row
  // answers `exited_early` nowhere, so the old axis saw an empty denominator
  // and scored it from its default — a number with no measurement under it.
  // The prices answer it outright.
  c('(1) a broker row that reached its target is measured, and is patience',
    disciplinePatience([HIT_BROKER_TARGET]), 100),

  // ── (2) THE ZERO THAT WOULD HAVE ACCUSED THE TRADER ─────────────────────
  //
  // The two halves in one case, so the assertion is the CONSEQUENCE and not
  // two facts. `Number(null)` is 0 and `intentNumber(0)` is 0, so a coerced
  // target wins the plan-beats-broker precedence and reports the trade above —
  // which hit its target — as having left early. That verdict is the one thing
  // lib/journal/patience.ts is written never to say on this evidence.
  c('(2) the intent prices stay null through the mapping, and a 0 would flip the verdict', [
    HIT_BROKER_TARGET.take_profit,
    HIT_BROKER_TARGET.stop_loss,
    patienceInputOf(HIT_BROKER_TARGET).planTarget,
    wasPatient(patienceInputOf(HIT_BROKER_TARGET)),
    wasPatient({ ...patienceInputOf(HIT_BROKER_TARGET), planTarget: 0 }),
  ], [null, null, null, true, false]),

  // ── (3) NOTHING MEASURED IS NULL — NOT 0, AND NOT 100 ───────────────────
  //
  // No target on the row at all, from either column, so there is nothing to
  // have waited for. The four self-reported axes beside this one answer 100 to
  // an empty denominator and are right to; this one has to say nothing, which
  // is what lets the call site drop the axis and draw the dash.
  c('(3) a row with no target anywhere is not measured at all',
    disciplinePatience([dash()]), null),
  c('(3b) and neither is an empty journal',
    disciplinePatience([]), null),

  // ── (4) THE TRADER'S OWN ANSWER STILL WINS, IN BOTH DIRECTIONS ──────────
  //
  // The property that keeps a manual journal scoring exactly as it did before
  // any of this shipped. Both rows carry prices that say the OPPOSITE of the
  // self-report, so the assertion is the precedence rather than the arithmetic:
  // (a) is out in profit short of its target — the prices say `early` — and the
  // trader denied it; (b) reached the target and the trader says they left
  // early anyway.
  c('(4) a self-report outranks the prices that contradict it', [
    disciplinePatience([dash({ take_profit: 29_800, exited_early: false })]),
    disciplinePatience([{ ...HIT_BROKER_TARGET, exited_early: true }]),
  ], [100, 0]),

  // ── (5) THE DENOMINATOR IS MEASURED ROWS ────────────────────────────────
  //
  // Four rows, two of them measurable, one of those patient: 50%. The two
  // exclusions are one per reason — no target anywhere, and a loss that reached
  // no stop we can name — and neither drags the rate down, which is the whole
  // claim. Dividing by four would answer 25 and read as a trader half as
  // patient as they are.
  c('(5) unmeasurable rows leave the rate alone rather than voting zero',
    disciplinePatience([
      HIT_BROKER_TARGET,
      dash({ broker_take_profit: 29_800, exit_price: 29_900 }),
      dash(),
      dash({ exit_price: 30_050 }),
    ]), 50),

  // ── (6) THE AXIS-DROPPING RULE ──────────────────────────────────────────
  //
  // `measuredAxes` is where this change can go wrong invisibly: the radar is
  // five index-aligned arrays, an unmeasured axis has to leave all five, and
  // `סבלנות` at index 3 is the first optional axis that is not the last one.
  c('(6) every axis measured keeps every axis',
    measuredAxes([50, 80, 100, 75, 100, 100]), [0, 1, 2, 3, 4, 5]),
  c('(6b) an unmeasured סבלנות leaves the chart',
    measuredAxes([50, 80, 100, null, 100, 100]), [0, 1, 2, 4, 5]),
  // TWO AT ONCE, which is the shape the old hand-written slice could not
  // express — `[D_LABELS[0], ...D_LABELS.slice(2)]` has the index 1 written
  // into it and there is no second form of it for index 3.
  c('(6c) and so do both optional axes together',
    measuredAxes([50, null, 100, null, 100, 100]), [0, 2, 4, 5]),
  // THE MINI-CARD'S TRANSLATION, in the other direction. Every axis keeps a
  // card whether it was measured or not, and a card hovers a position in the
  // SHORTENED arrays. With index 1 gone, axis 2's card must hover position 1 —
  // asserted as the arithmetic the call site does, because a card that hovered
  // its own position would quietly show its neighbour's label and tip.
  c('(6d) a surviving axis hovers its new position, not its old one',
    [0, 2, 4, 5].map((i) => measuredAxes([50, null, 100, null, 100, 100]).indexOf(i)),
    [0, 1, 2, 3]),
  c('(6e) and a dropped axis has no position to hover',
    measuredAxes([50, null, 100, null, 100, 100]).indexOf(3), -1),

  // ── (7) THE OLD PATH IS GONE FROM BOTH READERS ──────────────────────────
  //
  // Source-level, for `stopTriggerGroup`'s reason: the defect was a formula in
  // a closure inside a `'use client'` component, and the proof it is gone is
  // that the expression is ABSENT. Two copies existed — the axis and the 30-day
  // trend window — and fixing one would have left the trend reporting a
  // movement that was only the two formulas disagreeing.
  c('(7) no reader of the radar counts exited_early by hand any more',
    ['t.exited_early', 'withExitedEarly'].filter((n) => dashboardSource.includes(n)), []),
  // And the hand-written label slice with index 1 written into it.
  c('(7b) nor slices the label arrays by a hardcoded index',
    dashboardSource.includes('D_LABELS.slice(2)'), false),
  // The greps are only worth anything if the file is the one in hand.
  c('(7c) and the needles are read off a file that really renders the radar',
    [dashboardSource.includes('function RadarCard'),
     dashboardSource.includes('disciplinePatience')], [true, true]),
]);

// ── Group 7: the target-move row is drawn before it has a figure ─────────────
//
// `tp_history` is written ON IMPORT and has no backfill, so the denominator of
// REF-130 part ג's tally is zero for every trader on the day it ships and stays
// zero until their next sync. The row was conditional on having a figure, so a
// shipped feature and an unbuilt one looked identical — which is what the first
// trader to go looking for it reported.

const chipsSource = fs.readFileSync(
  path.join(process.cwd(), 'src/components/stats/BehaviorChips.tsx'),
  'utf8'
);

/**
 * A tally with one row measured and moved, for the figure's own shape.
 *
 * THE OUTER `verdict` IS NOT DECORATION. `readStopHistory` returns null for a
 * document that does not carry one, so a fixture holding `tp_history` alone
 * measures NOTHING and would have asserted the dash it was written to rule out.
 * `'kept'` for the stop and `'moved'` for the target is also the realistic row:
 * the two sub-documents answer independently.
 */
const MOVED_ONE = targetMoveTally([
  {
    stop_history: {
      verdict: 'kept',
      movedCount: 0,
      tp_history: {
        verdict: 'moved',
        initialTp: 29_790,
        finalTp: 29_780,
        targetSide: 'gain',
        movedCount: 1,
        direction: 'closer',
        targetCount: 1,
      },
    },
  },
]);

group('REF-130 follow-up: הזזת יעד exists on /stats before it has a number', [
  // ── (1) THE STATE EVERY TRADER IS IN TODAY ──────────────────────────────
  //
  // A journal of hand-logged trades carries no `tp_history` on any row, so
  // nothing is measurable and the figure is null. That is unchanged and
  // correct: what changed is that null no longer means "render nothing".
  c('(1) a journal with no imported rows measures nothing', [
    targetMoveTally([{}, { stop_history: null }, { stop_history: {} }]).measured,
    targetMoveLine(targetMoveTally([{}, { stop_history: null }])),
  ], [0, null]),

  // ── (2) ZERO MEASURED AND ZERO MOVED ARE DIFFERENT CLAIMS ───────────────
  //
  // The case that says why the dash is not a formatted `0 מתוך 0`. A trader
  // with four measured rows who moved no target gets a real sentence; a trader
  // with nothing measured gets no sentence at all, and the page pairs that with
  // the dash and a reason. Collapsing them would tell the second trader they
  // had been measured and found disciplined.
  c('(2) a measured zero states its figure, where an unmeasured one states none', [
    targetMoveLine({ measured: 4, moved: 0, closer: 0, farther: 0 }),
    targetMoveLine({ measured: 0, moved: 0, closer: 0, farther: 0 }),
  ], ['הזזת יעד: 0 מתוך 4 עסקאות', null]),

  // ── (3) THE LABEL CANNOT DRIFT FROM THE PLACEHOLDER'S ───────────────────
  //
  // The row is now named in two places — here and in the component, which
  // prints `${TARGET_MOVE_LABEL}: —` — so the label is one exported constant
  // and this pins that the figure really is built from it. A second spelling is
  // a row that renames itself the moment a trader's first import lands.
  c('(3) the figure and the placeholder are named by the same constant', [
    targetMoveLine(MOVED_ONE)?.startsWith(`${TARGET_MOVE_LABEL}: `),
    targetMoveLine(MOVED_ONE),
    chipsSource.includes('${TARGET_MOVE_LABEL}: —'),
  ], [true, 'הזזת יעד: 1 מתוך 1 עסקאות (קורב 1 · הורחק 0)', true]),

  // ── (4) THE ROW IS NO LONGER CONDITIONAL ON HAVING A FIGURE ─────────────
  //
  // Source-level, for group 6 (7)'s reason: the defect is a JSX guard and the
  // proof is that it is absent. The old form rendered the paragraph only
  // `{targetMoveLine !== null && (...)}`.
  c('(4) the paragraph is not guarded on the figure existing',
    chipsSource.includes('{targetMoveLine !== null && ('), false),
  // And the trader is told WHEN the figure arrives, in the future tense —
  // not that something is wrong with their journal, which is what the
  // patience chip's `אין מספיק נתונים` would have said.
  c('(4b) and the dash carries a reason that points forward', [
    chipsSource.includes('ייכתב מעסקאות חדשות'),
    chipsSource.includes("title={targetMoveLine === null ? TARGET_MOVE_PENDING : undefined}"),
  ], [true, true]),
  c('(4c) the needles are read off the file that really draws the chips',
    chipsSource.includes('export default function BehaviorChips'), true),
]);

// ── Group 8: the day's discipline number ─────────────────────────────────────
//
// REF-125's follow-up (item 2) gave the product ONE day-discipline function and
// put its result in the share snapshot as a field, so that the public card, the
// public page and the dashboard all print the same number for the same day.
// This group pins the three rules that number lives by — all three of them
// "null is not zero" rules, which is this suite's subject.
//
// IT ALSO PINS THE DASHBOARD'S WIRE, which is where the fix could regress
// silently: `stopHeldOutcome` prefers the `stop_history` DOCUMENT over the
// `moved_sl` self-report, so a dashboard that did not SELECT that column would
// compute the day's score from a different denominator than the card minted
// from the same trades — two numbers for one day, which is the complaint item 2
// answers. A React render cannot be driven here, so the select string and the
// call site are asserted at the source level, the same way group 7 asserts
// BehaviorChips'.

const dayDisciplineSource = fs.readFileSync(
  path.join(process.cwd(), 'src/lib/scoring/dayDiscipline.ts'),
  'utf8'
);

/** A closed row that answered BOTH questions, as the share builder reads one. */
const answered = (over: Record<string, unknown> = {}) => ({
  followed_plan: true,
  moved_sl: false,
  ...over,
});

group('REF-125 follow-up: one discipline number, and null is not zero', [
  // ── (1) NOTHING ANSWERED IS NULL, NEVER ZERO ────────────────────────────
  //
  // The rule the share card was built on and the reason the dashboard card
  // prints `—`: a day whose trades recorded no self-report and carry no broker
  // document has no discipline score. A zero would read as a measured collapse
  // on a day the trader has simply not debriefed, in public.
  c('(1) five unanswered trades score null, not 0',
    dayDiscipline([{}, {}, {}, {}, {}]).score, null),
  c('(1) an empty day scores null too', dayDiscipline([]).score, null),
  c('(1) and the evidence line is empty rather than "0/0"',
    disciplineEvidenceLine(dayDiscipline([{}, {}])), ''),

  // ── (2) `answered` IS NEVER `rows.length` ───────────────────────────────
  //
  // tradeScore.ts:218-237's hazard: the discipline booleans default to
  // not-violated, so a trade with no evidence against it collects the whole
  // block. Here three of five trades answered nothing and are in NEITHER half
  // — the score is over the two that did.
  c('(2) three silent trades beside two answered ones are not counted',
    dayDiscipline([answered(), answered({ followed_plan: false }), {}, {}, {}]).followedPlan,
    { met: 1, answered: 2 }),
  c('(2) …and the score is 75%, not 45% and not 90%',
    // 1 of 2 plans + 2 of 2 stops = 3 of 4 answered questions.
    dayDiscipline([answered(), answered({ followed_plan: false }), {}, {}, {}]).score, 75),

  // ── (3) POOLED, NOT AVERAGED ────────────────────────────────────────────
  //
  // Averaging a 1/1 and a 2/10 gives 60%, which is not a thing that happened to
  // anybody. Pooling counts every answered question once: 3 of 11.
  c('(3) 1/1 beside 2/10 is 27%, not 60%',
    dayDiscipline([
      { followed_plan: true },
      ...Array.from({ length: 2 }, () => ({ moved_sl: false })),
      ...Array.from({ length: 8 }, () => ({ moved_sl: true })),
    ]).score,
    27),

  // ── (4) A TRADE TAKEN WITH NO STOP IS NOT PERFECT STOP DISCIPLINE ───────
  //
  // `verdict: 'none'` is the broker telling us there was no stop at all, and
  // `'unknown'` is our own read failing. Crediting either would be the most
  // flattering thing this number could say.
  c('(4) no stop at all is not counted, in either half',
    dayDiscipline([{ stop_history: { verdict: 'none' } }]).stopHeld, null),
  c('(4) an unreadable verdict is not counted either',
    dayDiscipline([{ stop_history: { verdict: 'unknown' } }]).stopHeld, null),
  c('(4) a tightening IS held — Imri, 19.10',
    dayDiscipline([{ stop_history: { verdict: 'moved', direction: 'tightened' } }]).stopHeld,
    { met: 1, answered: 1 }),

  // ── (5) THE DASHBOARD READS THE SAME ROWS THE CARD DOES ─────────────────
  //
  // A broker row answers `moved_sl` nowhere and carries the document instead.
  // Through `mapDashTrade` — the real wire — the document survives, so the
  // dashboard's number is the card's number. Before item 2 the column was not
  // selected at all and this fixture would have scored null.
  c('(5) a mapped broker row answers the stop question from its document',
    dayDiscipline([dash({ stop_history: { verdict: 'kept' } })]).stopHeld,
    { met: 1, answered: 1 }),
  c('(5) a widened stop on a mapped broker row counts against',
    dayDiscipline([dash({ stop_history: { verdict: 'moved', direction: 'widened' } })]).score, 0),
  c('(5) and the same rows give the same score through either shape',
    dayDiscipline([dash({ stop_history: { verdict: 'kept' }, followed_plan: true })]).score,
    dayDiscipline([{ stop_history: { verdict: 'kept' }, followed_plan: true }]).score),

  // ── (6) THE SELECT AND THE CALL SITE ────────────────────────────────────
  //
  // `withBrokerColumns` is the gate: with the flag on the document is in the
  // statement, with it off the dashboard issues the query it issued before any
  // of this, because naming a column before its migration is a 42703 and a
  // page that will not open.
  c('(6) the gated select asks for stop_history',
    withBrokerColumns(DASH_TRADE_SELECT, true).includes('stop_history'), true),
  c('(6) …and does not ask for it with the gate shut',
    withBrokerColumns(DASH_TRADE_SELECT, false).includes('stop_history'), false),
  c('(6) the dashboard computes the day from the shared function',
    dashboardSource.includes('dayDiscipline(todayTrades)'), true),
  c('(6) the dashboard renders it as משמעת היום',
    dashboardSource.includes('משמעת היום'), true),
  c('(6) the radar is labelled as the all-time score, not the day\'s',
    dashboardSource.includes('title="ניקוד כולל"'), true),
  c('(6) …and carries a period note',
    /periodNote="[^"]*500/.test(dashboardSource), true),

  // ── (7) THE MODULE STAYS PURE AND BROWSER-SAFE ──────────────────────────
  //
  // One caller is a `'use client'` component and another is a route handler, so
  // an import of `process.env`, a Supabase client or a clock here would break
  // one of them — and would make this group undrivable, which is how the defect
  // it pins survived inside a 200-line closure in the first place.
  c('(7) no environment access', /process\.env/.test(dayDisciplineSource), false),
  c('(7) no clock of its own', /new Date\(|Date\.now/.test(dayDisciplineSource), false),
  c('(7) no supabase import', /supabase/i.test(dayDisciplineSource), false),
]);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failing assertion(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All null-safety and direction groups passed.');

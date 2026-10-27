/**
 * The weekly summary's numbers, as a pure function of the week's rows.
 *
 * Lifted out of app/api/weekly-summary/route.ts (REF-107 stage 4) so these can
 * be asserted without an Anthropic API key — the route constructs its client
 * at module load, which makes the handler unimportable from a check script.
 * The route keeps auth, the queries and the Claude call; everything here is
 * arithmetic over `TradeRow`.
 *
 * Two rules this module is responsible for, and both were broken before:
 *   - win/loss is read from the `direction` column via the shared helpers,
 *     never from `take_profit >= entry_price` (REF-107 §0ד);
 *   - averages divide by the rows that carry a value, never by the row count
 *     (§0ג) — `Number(null)` is 0, not NaN, so a row with no self-report used
 *     to be averaged in as a zero.
 */
import { tradeMoneyPnl, tradePointsPnl, isWinningTrade } from '@/lib/pnl';
import { averageOf, scaleValue, intentText } from '@/lib/intent';
import { tradingDayOfTrade } from '@/lib/tradingDay';

export interface DailyPnl {
  date: string;
  pnl: number;
  trades: number;
}

export interface BestWorstTrade {
  strategy: string;
  pnl: number;
  date: string;
}

export interface WeeklyStats {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number | null;
  total_pnl: number;
  // REF-99: a `pnl_currency` field sat here, set from the first trade in the
  // week that happened to carry one and then stamped on the whole week's
  // total. It is gone rather than pinned to '$': this object is persisted as a
  // JSONB blob in weekly_summaries.stats, so summaries generated before this
  // change still have '₪' inside them, and the only way to stop that
  // misreporting a dollar total is for the display side to not read it. See
  // WeeklyDayCard in components/dashboard/DashboardClient.tsx.
  avg_process_score: number | null;
  daily_pnl: DailyPnl[];
  avg_emotional_state: number | null;
  best_trade: BestWorstTrade | null;
  worst_trade: BestWorstTrade | null;
  most_used_strategy: string | null;
}

export interface TradeRow {
  strategy: string | null;
  entry_price: number | string;
  exit_price: number | string | null;
  take_profit: number | string | null;
  stop_loss: number | string | null;
  emotional_state: number | string | null;
  // `direction` is the column; the tp-vs-entry comparison this row shape used
  // to run instead is the REF-107 §0ד bug — it reads every profitable short as
  // a loss, which is wrong for manual shorts today and would be the default
  // once futures rows land.
  direction: 'long' | 'short' | null;
  plan_score: number | null;
  status: string;
  pnl_amount: number | string | null;
  actual_pnl: number | string | null;
  closed_at: string | null;
  submitted_at: string;
  exit_reason: string | null;
  post_trade_notes: string | null;
}

export const TRADE_SELECT_FIELDS = 'strategy,entry_price,exit_price,take_profit,stop_loss,emotional_state,direction,plan_score,status,pnl_amount,actual_pnl,closed_at,submitted_at,exit_reason,post_trade_notes';

/**
 * Direction-aware price points, via the shared helper. `take_profit` reaches
 * it only as the pre-`direction` fallback; a row carrying neither is resolved
 * there rather than guessed here.
 */
function tradePoints(t: TradeRow): number {
  return tradePointsPnl(t) ?? 0;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function computeWeeklyStats(trades: TradeRow[], weekStart: Date): WeeklyStats {
  // `win` is the canonical test (money first, points second) rather than a
  // second opinion computed from points alone, so a week's win count can never
  // disagree with the same trade's row on the stats page or in the journal.
  const rows = trades.map(t => ({
    trade: t,
    pnl: tradeMoneyPnl(t),
    points: tradePoints(t),
    win: isWinningTrade(t),
  }));

  const winning = rows.filter(r => r.win === true);
  // Still a three-way split: an exactly-flat trade is neither a win nor a
  // loss, as before. What changed is that a closed row with no exit price now
  // falls into the same gap instead of being counted as a loss the size of its
  // entry price, which is what `Number(null) - entry` produced.
  const losing = rows.filter(r => r.win === false && (r.pnl < 0 || (r.pnl === 0 && r.points < 0)));
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const winRate = trades.length > 0 ? Math.round((winning.length / trades.length) * 100) : null;

  const scored = trades.filter(t => t.plan_score != null);
  const avgProcessScore = scored.length > 0
    ? Math.round(scored.reduce((s, t) => s + Number(t.plan_score), 0) / scored.length)
    : null;

  // Keyed by TRADING DAY (REF-125), where this used to take the UTC date off
  // the ISO string. The weekly card draws these seven bars and the coach's
  // prompt is handed the same array, so a trade closed at 01:30 Israel landed
  // on the previous bar here and on the correct day in the journal — and the
  // AI then reasoned out loud about a Monday loss the trader remembers taking
  // on Tuesday.
  //
  // THE WEEK'S OWN BOUNDS ARE UNCHANGED and still Sunday-to-Saturday civil
  // dates from `weekStart`; `dailyPnl` below looks up those seven dates in
  // this map. The two agree because a trading day is NAMED by a civil date, so
  // Monday's session — which opens on Sunday evening — is keyed "Monday" and
  // lands in the right slot. Sunday's slot is now structurally always empty,
  // which is true: the Sunday 17:00 open is Monday's.
  const dayMap: Record<string, number> = {};
  const dayCountMap: Record<string, number> = {};
  for (const r of rows) {
    const day = tradingDayOfTrade(r.trade);
    if (day === null) continue;
    dayMap[day] = (dayMap[day] ?? 0) + r.pnl;
    dayCountMap[day] = (dayCountMap[day] ?? 0) + 1;
  }
  const dailyPnl: DailyPnl[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    const key = dateStr(d);
    return { date: key, pnl: Math.round((dayMap[key] ?? 0) * 100) / 100, trades: dayCountMap[key] ?? 0 };
  });

  // `Number(null)` is 0 and 0 is finite, so the previous `.filter(isFinite)`
  // kept every row without a self-report and averaged it in as a zero — the
  // strictest possible reading of "not recorded". `scaleValue` drops anything
  // outside the column's own 1..5 CHECK, null included.
  const avgEmotionalRaw = averageOf(trades, t => scaleValue(t.emotional_state));
  const avgEmotionalState = avgEmotionalRaw !== null ? Math.round(avgEmotionalRaw * 10) / 10 : null;

  let best: typeof rows[number] | null = null;
  let worst: typeof rows[number] | null = null;
  for (const r of rows) {
    if (!best || r.pnl > best.pnl) best = r;
    if (!worst || r.pnl < worst.pnl) worst = r;
  }
  const toBestWorst = (r: typeof rows[number]): BestWorstTrade => ({
    strategy: intentText(r.trade.strategy) ?? '',
    pnl: Math.round(r.pnl * 100) / 100,
    // The same day the bar chart above filed this trade under, so "the week's
    // worst trade" and the bar it came out of cannot name two dates.
    date: tradingDayOfTrade(r.trade) ?? (r.trade.closed_at ?? r.trade.submitted_at).slice(0, 10),
  });

  // A row with no strategy is not a strategy named "null" — it gets no bucket,
  // and "most used" stays null if that is all the week contains.
  const strategyCounts: Record<string, number> = {};
  for (const t of trades) {
    const s = intentText(t.strategy);
    if (s !== null) strategyCounts[s] = (strategyCounts[s] ?? 0) + 1;
  }
  const mostUsedStrategy = Object.entries(strategyCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    total_trades: trades.length,
    winning_trades: winning.length,
    losing_trades: losing.length,
    win_rate: winRate,
    total_pnl: Math.round(totalPnl * 100) / 100,
    avg_process_score: avgProcessScore,
    daily_pnl: dailyPnl,
    avg_emotional_state: avgEmotionalState,
    best_trade: best ? toBestWorst(best) : null,
    worst_trade: worst ? toBestWorst(worst) : null,
    most_used_strategy: mostUsedStrategy,
  };
}

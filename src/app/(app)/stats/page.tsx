import { redirect } from 'next/navigation';
import { createClient, getCachedUser } from '@/lib/supabase/server';
import PnlChart, { type PeriodPoint } from '@/components/stats/PnlChart';
import DistributionSection, { type DistBar } from '@/components/stats/DistributionSection';
import MindStateSection, { type ScaleBucket, type ScalePanelData } from '@/components/stats/MindStateSection';
import KpiHero from '@/components/stats/KpiHero';
import PerformanceTable from '@/components/stats/PerformanceTable';
import BehaviorChips from '@/components/stats/BehaviorChips';
import RecordsGrid from '@/components/stats/RecordsGrid';
import { MUTED, TEXT, fmt, Section } from '@/components/stats/shared';
import type { TradePlan } from '@/lib/types';
import AccountFilterChip from '@/components/accounts/AccountFilterChip';
import { visibleTrades } from '@/lib/trades/visible';
import { isImportEnabled } from '@/lib/tradovate/import';
import { resolveAccountParam, tradesInAccount, type RawSearchParams } from '@/lib/portfolios/filter';
import { readPortfolioLabel } from '@/lib/portfolios/read';
import { tradePointsPnl, tradeMoneyPnl, hasMoneyPnl, isWinningTrade } from '@/lib/pnl';
import { tradingDayOfTrade } from '@/lib/tradingDay';
import { averageOf, rrValue, intentText, type RawValue } from '@/lib/intent';
import { patienceRate, patienceTally } from '@/lib/journal/patience';
import { behaviourDisciplineScore } from '@/lib/scoring/disciplineAggregate';
import {
  targetMoveLine,
  targetMoveTally,
  type TargetHistoryRow,
} from '@/lib/journal/stopHistory';
import { TrendingUp, BarChart2, Target, CandlestickChart } from 'lucide-react';
import '@/components/stats/stats.css';

export const metadata = { title: 'סטטיסטיקה — Reflect' };

// ── Constants ─────────────────────────────────────────────────────────────────
const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// ── Helpers ───────────────────────────────────────────────────────────────────
const pnlOf = tradePointsPnl;
const pnlIls = tradeMoneyPnl;

// ── Page ──────────────────────────────────────────────────────────────────────
export default async function StatsPage({ searchParams }: {
  /** A Promise on Next 16 — see the note in app/(app)/trades/page.tsx. */
  searchParams: Promise<RawSearchParams>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) redirect('/login');

  // ── ?account= — IN MEMORY HERE, and only here (REF-110 §D.3) ─────────────
  //
  // The read below is UNBOUNDED, so filtering the array it returns is exact
  // and costs one pass. On /trades and /journal the same choice would be a
  // bug: those two cap at 1,000 rows before any filter runs, so the filter
  // has to be in the WHERE clause there. The split is forced by the queries,
  // not by preference.
  const accountId = resolveAccountParam((await searchParams).account, isImportEnabled());
  const accountLabel = await readPortfolioLabel(supabase, user.id, accountId);

  // Every figure on this page is a statistic about trades the user took, and
  // several of them (avgRR, the symbol and strategy tables, the
  // confidence/emotion buckets, the headline trade count) are computed over
  // every row rather than only the closed ones. A 'not_entered' plan is not a
  // trade (REF-82 §5.2), so it is excluded here once instead of at each of
  // them.
  const { data: raw } = await supabase
    .from('trade_plans')
    .select('*')
    .eq('user_id', user.id)
    .neq('status', 'not_entered')
    .order('submitted_at', { ascending: true });

  // A row the trader deleted is not in their statistics (REF-107 E12). This
  // page reads select('*'), so the column arrives for free and the filter is
  // the whole change.
  // `select('*')` above, so `account_id` arrives for free and the filter is
  // the whole change — the same shape as `visibleTrades` beside it, and like
  // it, the identity when there is nothing to drop.
  const trades  = tradesInAccount(visibleTrades((raw ?? []) as unknown as TradePlan[]), accountId);
  const closed  = trades.filter(t => t.status === 'closed' && t.exit_price != null);

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (trades.length === 0) {
    return (
      <div dir="rtl" className="stats-page min-h-screen px-4 py-6 flex flex-col gap-8">
        <PageHeader />
        {/* The chip belongs on the empty state more than anywhere else: a
            filtered portfolio with no trades renders the same "אין עדיין
            נתונים" a brand-new account does, and without this line the only
            reading is that the statistics have been lost. */}
        {accountLabel !== null && <AccountFilterChip label={accountLabel} clearHref="/stats" />}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center py-16">
            <div className="mb-4" style={{ color: MUTED }}><BarChart2 aria-hidden="true" size={48} /></div>
            <p style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>אין עדיין נתונים</p>
            <p style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
              {accountLabel === null ? 'תעד עסקאות כדי לראות סטטיסטיקות' : 'אין עסקאות בתיק הזה'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Core stats ──────────────────────────────────────────────────────────────
  const closedCount  = closed.length;
  const totalPnl     = closed.reduce((s, t) => s + pnlIls(t), 0);
  const wins         = closed.filter(t => isWinningTrade(t));
  const winRate      = closedCount > 0 ? Math.round(wins.length / closedCount * 100) : 0;
  // Averaged over the rows that carry an R:R, not over every row. The old
  // denominator was `trades.length`, and `Number(null)` is 0 — so one row
  // without a planned ratio pulled the headline figure down as if the trader
  // had planned a 1:0. Null here renders as "—"; it is not 0.
  const avgRR        = averageOf(trades, t => rrValue(t.rr_ratio));
  // Money aggregates classify by the money value itself, so a trade's win/loss
  // bucket can never disagree with the amount being averaged.
  const moneyClosed  = closed.filter(hasMoneyPnl);
  const moneyWins    = moneyClosed.filter(t => pnlIls(t) > 0);
  const moneyLosses  = moneyClosed.filter(t => pnlIls(t) < 0);
  const grossProfit  = moneyWins.reduce((s, t) => s + pnlIls(t), 0);
  const grossLoss    = moneyLosses.reduce((s, t) => s + pnlIls(t), 0);
  const avgWin       = moneyWins.length > 0 ? grossProfit / moneyWins.length : 0;
  const avgLoss      = moneyLosses.length > 0 ? grossLoss / moneyLosses.length : 0;
  const profitFactor = Math.abs(grossLoss) > 0 ? grossProfit / Math.abs(grossLoss) : 0;

  // ── P&L chart data ──────────────────────────────────────────────────────────
  const dailyMap   = new Map<string, PeriodPoint>();
  const weeklyMap  = new Map<string, PeriodPoint>();
  const monthlyMap = new Map<string, PeriodPoint>();

  for (const t of closed) {
    const p    = pnlIls(t);
    const win  = isWinningTrade(t) ? 1 : 0;
    const date = new Date(t.submitted_at);

    // THE DAILY BUCKET IS A TRADING DAY NOW, AND IT CHANGED COLUMN (REF-125).
    // It was `t.submitted_at.slice(0, 10)` — the UTC date a plan was LOGGED on
    // — which made this chart the only daily P&L in the product keyed by
    // submission while the dashboard, the journal and the weekly card all keyed
    // by the close. A trade planned on Monday evening and closed Tuesday showed
    // its money on Monday's bar here and on Tuesday's everywhere else.
    //
    // `tradingDayOfTrade` resolves both at once: `closed_at` when there is one,
    // and the day boundary is 17:00 Chicago. The weekly and monthly buckets
    // below are deliberately LEFT on `submitted_at` — they are period charts
    // whose grain is far wider than the shift, and re-cutting a trader's
    // historical weeks is a product change rather than this consistency fix.
    const dKey = tradingDayOfTrade(t);
    if (dKey !== null) {
      const dLbl = new Date(`${dKey}T00:00:00Z`).toLocaleDateString('he-IL', {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'numeric',
      });
      const dPrev = dailyMap.get(dKey) ?? { label: dLbl, pnl: 0, trades: 0, wins: 0 };
      dailyMap.set(dKey, { ...dPrev, pnl: dPrev.pnl + p, trades: dPrev.trades + 1, wins: dPrev.wins + win });
    }

    const yr   = date.getFullYear();
    const wNum = Math.ceil(((date.getTime() - new Date(yr, 0, 1).getTime()) / 86400000 + new Date(yr, 0, 1).getDay() + 1) / 7);
    const wKey = `${yr}-W${String(wNum).padStart(2, '0')}`;
    const wPrev = weeklyMap.get(wKey) ?? { label: `W${wNum}`, pnl: 0, trades: 0, wins: 0 };
    weeklyMap.set(wKey, { ...wPrev, pnl: wPrev.pnl + p, trades: wPrev.trades + 1, wins: wPrev.wins + win });

    const mKey  = t.submitted_at.slice(0, 7);
    const mLbl  = date.toLocaleDateString('he-IL', { month: 'short', year: '2-digit' });
    const mPrev = monthlyMap.get(mKey) ?? { label: mLbl, pnl: 0, trades: 0, wins: 0 };
    monthlyMap.set(mKey, { ...mPrev, pnl: mPrev.pnl + p, trades: mPrev.trades + 1, wins: mPrev.wins + win });
  }

  const sortKeys = ([a]: [string, unknown], [b]: [string, unknown]) => a < b ? -1 : 1;
  const daily   = [...dailyMap.entries()].sort(sortKeys).map(([, v]) => v).slice(-60);
  const weekly  = [...weeklyMap.entries()].sort(sortKeys).map(([, v]) => v).slice(-26);
  const monthly = [...monthlyMap.entries()].sort(sortKeys).map(([, v]) => v);

  // ── Strategy breakdown ──────────────────────────────────────────────────────
  // A row with no strategy gets no bucket at all. It used to be filed under
  // 'אחר', which is indistinguishable from a strategy the trader actually
  // named 'אחר' and puts broker rows into a group they were never part of.
  // `rrN` is the per-bucket count of rows that carry an R:R, for the same
  // reason the global average has one.
  const stratMap = new Map<string, { trades: number; wins: number; closedN: number; pnl: number; rr: number; rrN: number }>();
  for (const t of trades) {
    const s = intentText(t.strategy);
    if (s === null) continue;
    const prev = stratMap.get(s) ?? { trades: 0, wins: 0, closedN: 0, pnl: 0, rr: 0, rrN: 0 };
    const p    = pnlOf(t);
    const rr   = rrValue(t.rr_ratio);
    stratMap.set(s, {
      trades:  prev.trades + 1,
      closedN: prev.closedN + (p != null ? 1 : 0),
      wins:    prev.wins + (isWinningTrade(t) ? 1 : 0),
      pnl:     prev.pnl + pnlIls(t),
      rr:      prev.rr + (rr ?? 0),
      rrN:     prev.rrN + (rr !== null ? 1 : 0),
    });
  }
  const strategies = [...stratMap.entries()]
    .map(([name, v]) => ({ name, ...v, avgRR: v.rrN > 0 ? v.rr / v.rrN : null }))
    .sort((a, b) => b.trades - a.trades);

  // ── Behavioral / discipline metrics ─────────────────────────────────────────
  const withFollowed = closed.filter(t => t.followed_plan !== null);
  const deviatedPct = withFollowed.length
    ? Math.round((withFollowed.filter(t => t.followed_plan === false).length / withFollowed.length) * 100) : null;

  const withMovedSl = closed.filter(t => t.moved_sl !== null);
  const movedSlPct = withMovedSl.length
    ? Math.round((withMovedSl.filter(t => t.moved_sl === true).length / withMovedSl.length) * 100) : null;

  const withFomo = closed.filter(t => t.fomo_entry !== null);
  const fomoPct = withFomo.length
    ? Math.round((withFomo.filter(t => t.fomo_entry === true).length / withFomo.length) * 100) : null;

  const withRevenge = closed.filter(t => t.revenge_trade !== null);
  const revengePct = withRevenge.length
    ? Math.round((withRevenge.filter(t => t.revenge_trade === true).length / withRevenge.length) * 100) : null;

  // ── סבלנות, from the prices rather than from a flag (REF-130 part א) ──────
  //
  // `closed` AND NOT `trades`, like the four rates above: an open position has
  // not finished being exited.
  //
  // THE DENOMINATOR IS MEASURED TRADES AND ZERO RENDERS AS A DASH. A trader
  // whose every row is unanswerable has not been measured at 0% patience; see
  // `patienceTally`, which is also where "the trader's own `exited_early`
  // answer wins when there is one" lives — so a manual trade counts exactly as
  // it would have before this existed, and the derivation is reached only by
  // the rows that answered nothing.
  //
  // THE TWO BROKER COLUMNS ARE NOT ON `TradePlan`, which is why this reads
  // through a loose record: `select('*')` returns them and the type does not
  // declare them, exactly as it does not declare `stop_history`. `intentNumber`
  // inside the module validates every one of them.
  const patience = patienceRate(
    patienceTally(
      closed.map((t) => {
        const raw = t as unknown as Record<string, unknown>;
        return {
          direction: t.direction,
          entryPrice: t.entry_price,
          exitPrice: t.exit_price,
          planTarget: t.take_profit,
          brokerTarget: raw.broker_take_profit as RawValue,
          planStop: t.stop_loss,
          brokerStop: raw.broker_stop_loss as RawValue,
          exitedEarly: t.exited_early,
        };
      })
    )
  );

  // ── What the broker saw happen to the TARGET (REF-130 part ג, item 3) ─────
  //
  // `closed` AND NOT `trades`, like the four rates above it: an open position's
  // target has not finished being moved.
  //
  // THE COUNTING RULE IS IN THE MODULE AND NOT HERE. Which verdicts are an
  // answer — `'moved'` and `'kept'`, never a missing sub-document, a `'none'` or
  // an `'unknown'` — is a reading of the column, and lib/journal/stopHistory.ts
  // is where it can be driven by a regression script. The cast is the same one
  // `select('*')` forces everywhere on this page: `stop_history` is a column
  // `TradePlan` does not declare, and `readStopHistory` validates every field it
  // reads off it.
  const targetMoves = targetMoveLine(
    targetMoveTally(closed as unknown as TargetHistoryRow[])
  );

  // The formula is unchanged and now lives in lib/scoring/disciplineAggregate.ts.
  // The AI chat coach quoted a DIFFERENT number under the same name (REF-120
  // §2.4) and a trader could see both in one session; one function, two readers.
  const disciplineScore = behaviourDisciplineScore(closed);

  // ── Confidence / emotional-state breakdowns ─────────────────────────────────
  function buildScaleBuckets(field: 'confidence_level' | 'emotional_state'): ScaleBucket[] {
    return [1, 2, 3, 4, 5].map((level) => {
      const allAtLevel = trades.filter(t => Number(t[field]) === level);
      const closedAtLevel = closed.filter(t => Number(t[field]) === level);
      const wins = closedAtLevel.filter(t => isWinningTrade(t)).length;
      return {
        level,
        trades: allAtLevel.length,
        closedN: closedAtLevel.length,
        wins,
        pnl: closedAtLevel.reduce((s, t) => s + pnlIls(t), 0),
      };
    });
  }
  const confidenceBuckets = buildScaleBuckets('confidence_level');
  const emotionBuckets = buildScaleBuckets('emotional_state');

  function insightSentences(buckets: ScaleBucket[], label: string): string[] {
    const out: string[] = [];
    const high = buckets.filter(b => b.level >= 4);
    const highClosed = high.reduce((s, b) => s + b.closedN, 0);
    const highWins = high.reduce((s, b) => s + b.wins, 0);
    if (highClosed > 0) {
      out.push(`${Math.round((highWins / highClosed) * 100)}% מהעסקאות עם ${label} 4-5 הסתיימו ברווח`);
    }
    const low = buckets.filter(b => b.level <= 2);
    const lowClosed = low.reduce((s, b) => s + b.closedN, 0);
    const lowLosses = low.reduce((s, b) => s + (b.closedN - b.wins), 0);
    if (lowClosed > 0) {
      out.push(`${Math.round((lowLosses / lowClosed) * 100)}% מהעסקאות עם ${label} 2 ומטה הסתיימו בהפסד`);
    }
    return out;
  }
  const confidenceInsights = insightSentences(confidenceBuckets, 'רמת ביטחון');
  const emotionInsights = insightSentences(emotionBuckets, 'מצב רגשי');
  const hasConfidenceData = confidenceBuckets.some(b => b.trades > 0);
  const hasEmotionData = emotionBuckets.some(b => b.trades > 0);

  // ── Day / hour distribution ─────────────────────────────────────────────────
  const dayBars: DistBar[] = HE_DAYS.map((label, i) => {
    const dayT  = closed.filter(t => new Date(t.submitted_at).getDay() === i);
    const winsN = dayT.filter(t => isWinningTrade(t)).length;
    return {
      label,
      pnl: dayT.reduce((s, t) => s + pnlIls(t), 0),
      trades: dayT.length,
      winRate: dayT.length > 0 ? Math.round(winsN / dayT.length * 100) : null,
    };
  });

  const hourMap = new Map<number, { pnl: number; trades: number; wins: number }>();
  for (const t of closed) {
    const h    = new Date(t.submitted_at).getHours();
    const prev = hourMap.get(h) ?? { pnl: 0, trades: 0, wins: 0 };
    hourMap.set(h, {
      pnl:    prev.pnl + pnlIls(t),
      trades: prev.trades + 1,
      wins:   prev.wins + (isWinningTrade(t) ? 1 : 0),
    });
  }
  const hourBars: DistBar[] = [...hourMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([h, v]) => ({
      label: `${String(h).padStart(2, '0')}:00`,
      pnl: v.pnl,
      trades: v.trades,
      winRate: v.trades > 0 ? Math.round(v.wins / v.trades * 100) : null,
    }));

  // ── Symbol breakdown ─────────────────────────────────────────────────────────
  const symbolMap = new Map<string, { trades: number; wins: number; closedN: number; pnl: number; rr: number; rrN: number }>();
  for (const t of trades) {
    const sym = t.symbol?.trim().toUpperCase();
    if (!sym) continue;
    const prev = symbolMap.get(sym) ?? { trades: 0, wins: 0, closedN: 0, pnl: 0, rr: 0, rrN: 0 };
    const p    = pnlOf(t);
    const rr   = rrValue(t.rr_ratio);
    symbolMap.set(sym, {
      trades:  prev.trades + 1,
      closedN: prev.closedN + (p != null ? 1 : 0),
      wins:    prev.wins + (isWinningTrade(t) ? 1 : 0),
      pnl:     prev.pnl + pnlIls(t),
      rr:      prev.rr + (rr ?? 0),
      rrN:     prev.rrN + (rr !== null ? 1 : 0),
    });
  }
  const symbols = [...symbolMap.entries()]
    .map(([name, v]) => ({ name, ...v, avgRR: v.rrN > 0 ? v.rr / v.rrN : null }))
    .sort((a, b) => b.trades - a.trades);

  // ── Streaks ──────────────────────────────────────────────────────────────────
  let curW = 0, maxW = 0, curL = 0, maxL = 0;
  for (const t of closed) {
    if (isWinningTrade(t)) { curW++; maxW = Math.max(maxW, curW); curL = 0; }
    else                { curL++; maxL = Math.max(maxL, curL); curW = 0; }
  }
  const currentStreak = curW > 0 ? { type: 'win' as const, count: curW }
    : curL > 0 ? { type: 'loss' as const, count: curL }
    : null;

  const bestTrade  = closed.length ? closed.reduce((b, t) => pnlIls(t) > pnlIls(b) ? t : b) : null;
  const worstTrade = closed.length ? closed.reduce((w, t) => pnlIls(t) < pnlIls(w) ? t : w) : null;
  const bestDay    = daily.length  ? daily.reduce((b, d)  => d.pnl > b.pnl ? d : b) : null;
  const worstDay   = daily.length  ? daily.reduce((b, d)  => d.pnl < b.pnl ? d : b) : null;

  // ── Presentation-only mappings ──────────────────────────────────────────────
  const strategyRows = strategies.map(s => ({
    name: s.name,
    trades: s.trades,
    winRate: s.closedN > 0 ? Math.round(s.wins / s.closedN * 100) : null,
    avgRR: s.avgRR,
    pnl: s.pnl,
  }));
  const symbolRows = symbols.map(s => ({
    name: s.name,
    trades: s.trades,
    winRate: s.closedN > 0 ? Math.round(s.wins / s.closedN * 100) : null,
    avgRR: s.avgRR,
    pnl: s.pnl,
  }));

  const mindPanels: ScalePanelData[] = [
    ...(hasConfidenceData ? [{ title: 'רמת ביטחון', buckets: confidenceBuckets, insights: confidenceInsights }] : []),
    ...(hasEmotionData ? [{ title: 'מצב רגשי', buckets: emotionBuckets, insights: emotionInsights }] : []),
  ];

  return (
    <div dir="rtl" className="stats-page min-h-screen px-4 py-6 flex flex-col gap-8">

      {/* ── Header ─────────────────────────────────────────────── */}
      <PageHeader />
      {accountLabel !== null && <AccountFilterChip label={accountLabel} clearHref="/stats" />}

      {/* ── Section 1: KPI hero band ───────────────────────────── */}
      <KpiHero
        totalPnl={totalPnl}
        closedCount={closedCount}
        winRate={winRate}
        winsCount={wins.length}
        profitFactor={profitFactor}
        avgRR={avgRR}
        disciplineScore={disciplineScore}
        avgWin={avgWin}
        avgLoss={avgLoss}
        currentStreak={currentStreak}
        daily={daily}
      />

      {/* ── Section 2: Equity curve ────────────────────────────── */}
      <Section title="רווח/הפסד לאורך זמן" icon={<TrendingUp aria-hidden="true" size={18} />}>
        <PnlChart daily={daily} weekly={weekly} monthly={monthly} />
      </Section>

      {/* ── Section 3: Strategy & symbol tables ────────────────── */}
      {(strategies.length > 0 || symbols.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start">
          {strategies.length > 0 && (
            <PerformanceTable
              title="ביצועים לפי אסטרטגיה"
              icon={<Target aria-hidden="true" size={18} />}
              unitLabel="אסטרטגיות"
              rows={strategyRows}
              showRR
            />
          )}
          {symbols.length > 0 && (
            <PerformanceTable
              title="התפלגות לפי סמל"
              icon={<CandlestickChart aria-hidden="true" size={18} />}
              unitLabel="סמלים"
              rows={symbolRows}
              showRR
            />
          )}
        </div>
      )}

      {/* ── Section 4: Inner state (confidence + emotion) ──────── */}
      {mindPanels.length > 0 && <MindStateSection panels={mindPanels} />}

      {/* ── Section 5: Behavioral metrics ──────────────────────── */}
      <BehaviorChips
        deviatedPct={deviatedPct}
        movedSlPct={movedSlPct}
        fomoPct={fomoPct}
        revengePct={revengePct}
        patiencePct={patience}
        targetMoveLine={targetMoves}
      />

      {/* ── Section 6: Day/hour distribution + records ─────────── */}
      {closedCount > 0 && (
        <DistributionSection dayBars={dayBars} hourBars={hourBars} />
      )}

      {closedCount > 0 && (
        <RecordsGrid
          maxWinStreak={maxW}
          maxLossStreak={maxL}
          bestTrade={bestTrade ? { value: fmt(pnlIls(bestTrade)), sub: intentText(bestTrade.strategy) ?? undefined } : null}
          worstTrade={worstTrade ? { value: fmt(pnlIls(worstTrade)), sub: intentText(worstTrade.strategy) ?? undefined } : null}
          bestDay={bestDay && bestDay.pnl > 0 ? { value: fmt(bestDay.pnl), sub: bestDay.label } : null}
          worstDay={worstDay && worstDay.pnl < 0 ? { value: fmt(worstDay.pnl), sub: worstDay.label } : null}
        />
      )}

    </div>
  );
}

// ── Small sub-components ──────────────────────────────────────────────────────

function PageHeader() {
  return (
    <div className="flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: 'rgba(0,210,210,0.12)', border: '1px solid rgba(0,210,210,0.2)' }}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00d2d2" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
          <line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>
        </svg>
      </div>
      <div>
        <h1 className="text-xl font-bold" style={{ color: 'var(--color-tg-text)' }}>סטטיסטיקה</h1>
        <p className="text-xs" style={{ color: 'var(--color-tg-muted)', fontWeight: 600 }}>ניתוח מלא של ביצועי המסחר שלך</p>
      </div>
    </div>
  );
}

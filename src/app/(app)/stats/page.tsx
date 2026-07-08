import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PnlChart, { type PeriodPoint } from '@/components/stats/PnlChart';
import DistributionSection, { type DistBar } from '@/components/stats/DistributionSection';
import MindStateSection, { type ScaleBucket, type ScalePanelData } from '@/components/stats/MindStateSection';
import KpiHero from '@/components/stats/KpiHero';
import PerformanceTable from '@/components/stats/PerformanceTable';
import BehaviorChips from '@/components/stats/BehaviorChips';
import RecordsGrid from '@/components/stats/RecordsGrid';
import { MUTED, TEXT, fmt, Section } from '@/components/stats/shared';
import type { TradePlan } from '@/lib/types';
import { tradePointsPnl, tradeMoneyPnl, hasMoneyPnl } from '@/lib/pnl';
import { TrendingUp, BarChart2, Target, CandlestickChart } from 'lucide-react';
import '@/components/stats/stats.css';

export const metadata = { title: 'סטטיסטיקה — Reflect' };

// ── Constants ─────────────────────────────────────────────────────────────────
const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// ── Helpers ───────────────────────────────────────────────────────────────────
const pnlOf = tradePointsPnl;
const pnlIls = tradeMoneyPnl;

// ── Page ──────────────────────────────────────────────────────────────────────
export default async function StatsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: raw } = await supabase
    .from('trade_plans')
    .select('*')
    .eq('user_id', user.id)
    .order('submitted_at', { ascending: true });

  const trades  = (raw ?? []) as TradePlan[];
  const closed  = trades.filter(t => t.status === 'closed' && t.exit_price != null);

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (trades.length === 0) {
    return (
      <div dir="rtl" className="stats-page min-h-screen px-4 py-6 flex flex-col gap-8">
        <PageHeader />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center py-16">
            <div className="mb-4" style={{ color: MUTED }}><BarChart2 size={48} /></div>
            <p style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>אין עדיין נתונים</p>
            <p style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>תעד עסקאות כדי לראות סטטיסטיקות</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Core stats ──────────────────────────────────────────────────────────────
  const closedCount  = closed.length;
  const totalPnl     = closed.reduce((s, t) => s + pnlIls(t), 0);
  const wins         = closed.filter(t => pnlOf(t)! > 0);
  const winRate      = closedCount > 0 ? Math.round(wins.length / closedCount * 100) : 0;
  const avgRR        = trades.length > 0
    ? trades.reduce((s, t) => s + Number(t.rr_ratio), 0) / trades.length : 0;
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
    const win  = pnlOf(t)! > 0 ? 1 : 0;
    const date = new Date(t.submitted_at);

    const dKey = t.submitted_at.slice(0, 10);
    const dLbl = date.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
    const dPrev = dailyMap.get(dKey) ?? { label: dLbl, pnl: 0, trades: 0, wins: 0 };
    dailyMap.set(dKey, { ...dPrev, pnl: dPrev.pnl + p, trades: dPrev.trades + 1, wins: dPrev.wins + win });

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
  const stratMap = new Map<string, { trades: number; wins: number; closedN: number; pnl: number; rr: number }>();
  for (const t of trades) {
    const s    = String(t.strategy || 'אחר');
    const prev = stratMap.get(s) ?? { trades: 0, wins: 0, closedN: 0, pnl: 0, rr: 0 };
    const p    = pnlOf(t);
    stratMap.set(s, {
      trades:  prev.trades + 1,
      closedN: prev.closedN + (p != null ? 1 : 0),
      wins:    prev.wins + (p != null && p > 0 ? 1 : 0),
      pnl:     prev.pnl + pnlIls(t),
      rr:      prev.rr + Number(t.rr_ratio),
    });
  }
  const strategies = [...stratMap.entries()]
    .map(([name, v]) => ({ name, ...v, avgRR: v.rr / v.trades }))
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

  const disciplineComponents = [
    withFollowed.length ? withFollowed.filter(t => t.followed_plan === true).length / withFollowed.length : null,
    withMovedSl.length  ? withMovedSl.filter(t => t.moved_sl === false).length / withMovedSl.length : null,
    withFomo.length     ? withFomo.filter(t => t.fomo_entry === false).length / withFomo.length : null,
    withRevenge.length  ? withRevenge.filter(t => t.revenge_trade === false).length / withRevenge.length : null,
  ].filter((v): v is number => v !== null);
  const disciplineScore = disciplineComponents.length
    ? Math.round((disciplineComponents.reduce((s, v) => s + v, 0) / disciplineComponents.length) * 100) : null;

  // ── Confidence / emotional-state breakdowns ─────────────────────────────────
  function buildScaleBuckets(field: 'confidence_level' | 'emotional_state'): ScaleBucket[] {
    return [1, 2, 3, 4, 5].map((level) => {
      const allAtLevel = trades.filter(t => Number(t[field]) === level);
      const closedAtLevel = closed.filter(t => Number(t[field]) === level);
      const wins = closedAtLevel.filter(t => pnlOf(t)! > 0).length;
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
    const winsN = dayT.filter(t => pnlOf(t)! > 0).length;
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
      wins:   prev.wins + (pnlOf(t)! > 0 ? 1 : 0),
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
  const symbolMap = new Map<string, { trades: number; wins: number; closedN: number; pnl: number; rr: number }>();
  for (const t of trades) {
    const sym = t.symbol?.trim().toUpperCase();
    if (!sym) continue;
    const prev = symbolMap.get(sym) ?? { trades: 0, wins: 0, closedN: 0, pnl: 0, rr: 0 };
    const p    = pnlOf(t);
    symbolMap.set(sym, {
      trades:  prev.trades + 1,
      closedN: prev.closedN + (p != null ? 1 : 0),
      wins:    prev.wins + (p != null && p > 0 ? 1 : 0),
      pnl:     prev.pnl + pnlIls(t),
      rr:      prev.rr + Number(t.rr_ratio),
    });
  }
  const symbols = [...symbolMap.entries()]
    .map(([name, v]) => ({ name, ...v, avgRR: v.rr / v.trades }))
    .sort((a, b) => b.trades - a.trades);

  // ── Streaks ──────────────────────────────────────────────────────────────────
  let curW = 0, maxW = 0, curL = 0, maxL = 0;
  for (const t of closed) {
    if (pnlOf(t)! > 0) { curW++; maxW = Math.max(maxW, curW); curL = 0; }
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

      {/* ── Section 1: KPI hero band ───────────────────────────── */}
      <KpiHero
        totalPnl={totalPnl}
        closedCount={closedCount}
        winRate={winRate}
        winsCount={wins.length}
        profitFactor={profitFactor}
        avgRR={avgRR}
        tradesCount={trades.length}
        disciplineScore={disciplineScore}
        avgWin={avgWin}
        avgLoss={avgLoss}
        currentStreak={currentStreak}
        daily={daily}
      />

      {/* ── Section 2: Equity curve ────────────────────────────── */}
      <Section title="רווח/הפסד לאורך זמן" icon={<TrendingUp size={18} />}>
        <PnlChart daily={daily} weekly={weekly} monthly={monthly} />
      </Section>

      {/* ── Section 3: Strategy & symbol tables ────────────────── */}
      {(strategies.length > 0 || symbols.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          {strategies.length > 0 && (
            <PerformanceTable
              title="ביצועים לפי אסטרטגיה"
              icon={<Target size={18} />}
              unitLabel="אסטרטגיות"
              rows={strategyRows}
              showRR
            />
          )}
          {symbols.length > 0 && (
            <PerformanceTable
              title="התפלגות לפי סמל"
              icon={<CandlestickChart size={18} />}
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
      />

      {/* ── Section 6: Day/hour distribution + records ─────────── */}
      {closedCount > 0 && (
        <DistributionSection dayBars={dayBars} hourBars={hourBars} />
      )}

      {closedCount > 0 && (
        <RecordsGrid
          maxWinStreak={maxW}
          maxLossStreak={maxL}
          bestTrade={bestTrade ? { value: fmt(pnlIls(bestTrade), bestTrade.pnl_currency ?? '₪'), sub: bestTrade.strategy } : null}
          worstTrade={worstTrade ? { value: fmt(pnlIls(worstTrade), worstTrade.pnl_currency ?? '₪'), sub: worstTrade.strategy } : null}
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
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00d2d2" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
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

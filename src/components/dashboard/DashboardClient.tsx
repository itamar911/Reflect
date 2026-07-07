'use client';

import { useState, useMemo, useEffect, useCallback, useSyncExternalStore } from 'react';
import { Sparkles, TrendingUp, TrendingDown, RefreshCw, CheckCircle, AlertCircle, AlertTriangle, Heart, Target, ChevronRight, ChevronLeft, Quote, Clock, Lock } from 'lucide-react';
import { formatPnlIls, formatPnlPoints } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { DASH_TRADE_SELECT, mapDashTrade } from '@/lib/dashboard/trades';
import type { DashTrade } from '@/lib/dashboard/trades';
import { tradeMoneyPnl, hasMoneyPnl } from '@/lib/pnl';
import { getPlanLimits, type PlanTier } from '@/lib/plans/config';
import UpgradeModal from '@/components/plans/UpgradeModal';

export type { DashTrade } from '@/lib/dashboard/trades';

// ── Tokens ────────────────────────────────────────────────────────────────────
const ACCENT  = '#00d2d2';
const SURF    = 'var(--color-tg-surface)';
const SURF2   = 'var(--color-tg-surface-2)';
const BORDER  = 'var(--color-tg-border)';
const TEXT    = 'var(--color-tg-text)';
const TEXT2   = 'var(--color-tg-text-2)';
const MUTED   = 'var(--color-tg-muted)';
const GREEN   = '#22c55e';
const RED     = '#ef4444';
const YELLOW  = '#eab308';
const DEEP    = 'var(--color-tg-surface)';
const SUBTLE  = 'var(--color-tg-border)';
const ICON_GRAY = '#6b7280';

// Fixed, deterministic stand-in for "now" used before the client has mounted,
// so the server render and the first client render produce identical output.
const EPOCH = new Date(0);

// Reports false during SSR and the first client render, then true after
// hydration — the recommended way to gate "now"-dependent output without
// causing a hydration mismatch.
function subscribeNoop() { return () => {}; }
function useMounted(): boolean {
  return useSyncExternalStore(subscribeNoop, () => true, () => false);
}

// ── Pure helpers ──────────────────────────────────────────────────────────────
function tradeDir(t: DashTrade): 'long' | 'short' {
  return t.take_profit >= t.entry_price ? 'long' : 'short';
}
function calcPnl(t: DashTrade): number | null {
  if (t.status !== 'closed' || t.exit_price == null) return null;
  return tradeDir(t) === 'long' ? t.exit_price - t.entry_price : t.entry_price - t.exit_price;
}
function dayKey(iso: string) { return iso.slice(0, 10); }
function fmtPnl(v: number) { return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`; }
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
}
function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

// ── Series builders ───────────────────────────────────────────────────────────
type BarItem = { label: string; value: number };

function buildDailySeries(dm: Record<string, number>, n: number, now: Date): BarItem[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now); d.setDate(d.getDate() - (n - 1 - i));
    const k = d.toISOString().slice(0, 10);
    return { label: k.slice(5).replace('-', '/'), value: dm[k] ?? 0 };
  });
}
function buildWeeklySeries(dm: Record<string, number>, n: number, now: Date): BarItem[] {
  return Array.from({ length: n }, (_, i) => {
    const start = new Date(now);
    start.setDate(start.getDate() - start.getDay() - (n - 1 - i) * 7);
    let sum = 0;
    for (let d = 0; d < 7; d++) {
      const day = new Date(start); day.setDate(start.getDate() + d);
      sum += dm[day.toISOString().slice(0, 10)] ?? 0;
    }
    return { label: `W${i + 1}`, value: sum };
  });
}
function buildMonthlySeries(dm: Record<string, number>, n: number, now: Date): BarItem[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 1);
    const yr = d.getFullYear(), mo = d.getMonth();
    const sum = Object.keys(dm).reduce<number>((s, k) => {
      const kd = new Date(k);
      return kd.getFullYear() === yr && kd.getMonth() === mo ? s + (dm[k] ?? 0) : s;
    }, 0);
    return { label: `${mo + 1}/${String(yr).slice(2)}`, value: sum };
  });
}
function buildCumulativeSeries(dm: Record<string, number>, n: number, now: Date): BarItem[] {
  let cum = 0;
  return buildDailySeries(dm, n, now).map(d => { cum += d.value; return { label: d.label, value: cum }; });
}

// ── Window scoring helper (for trend computation) ─────────────────────────────
function windowAvgScores(wClosed: DashTrade[]): { disc: number; perf: number } {
  const boolPct = (get: (t: DashTrade) => boolean | null) => {
    const w = wClosed.filter(t => get(t) != null);
    return w.length > 0 ? w.filter(t => get(t) === false).length / w.length * 100 : 100;
  };

  // Discipline
  const withPlan  = wClosed.filter(t => t.plan_score != null);
  const procS     = withPlan.length > 0 ? withPlan.reduce((s, t) => s + t.plan_score!, 0) / withPlan.length : 50;
  const withStrat = wClosed.filter(t => Array.isArray(t.strategy_conditions_checked) && t.strategy_conditions_checked.length > 0);
  const stratS    = withStrat.length > 0
    ? withStrat.reduce((s, t) => {
        const a = t.strategy_conditions_checked!;
        return s + a.filter(x => x.checked).length / a.length * 100;
      }, 0) / withStrat.length
    : null;
  const discArr = [
    procS,
    ...(stratS !== null ? [stratS] : []),
    boolPct(t => t.moved_sl),
    boolPct(t => t.exited_early),
    boolPct(t => t.fomo_entry),
    boolPct(t => t.revenge_trade),
  ];
  const disc = Math.round(discArr.reduce((s, v) => s + v, 0) / discArr.length);

  // Performance
  const wins   = wClosed.filter(t => (calcPnl(t) ?? 0) > 0);
  const losses = wClosed.filter(t => (calcPnl(t) ?? 0) < 0);
  const wc = wins.length; const lc = losses.length;
  const wMoneyWins   = wClosed.map(tradeMoneyPnl).filter(v => v > 0);
  const wMoneyLosses = wClosed.map(tradeMoneyPnl).filter(v => v < 0);
  const gp = wMoneyWins.reduce((s, v) => s + v, 0);
  const gl = wMoneyLosses.reduce((s, v) => s + v, 0);
  const aw = wMoneyWins.length > 0 ? gp / wMoneyWins.length : 0;
  const al = wMoneyLosses.length > 0 ? gl / wMoneyLosses.length : 0;
  const wDayMap: Record<string, number> = {};
  for (const t of wClosed) {
    const k = dayKey(t.closed_at ?? t.submitted_at);
    wDayMap[k] = (wDayMap[k] ?? 0) + tradeMoneyPnl(t);
  }
  const wDayVals    = Object.values(wDayMap);
  const wTotalDays  = wDayVals.length;
  const wProfitDays = wDayVals.filter(v => v > 0).length;
  let wCum = 0, wPeak = 0, wMaxDD = 0;
  for (const k of Object.keys(wDayMap).sort()) {
    wCum += wDayMap[k];
    if (wCum > wPeak) wPeak = wCum;
    const dd = wPeak - wCum;
    if (dd > wMaxDD) wMaxDD = dd;
  }
  const wWinRate = (wc + lc) > 0 ? wc / (wc + lc) * 100 : 0;
  const wPf      = Math.abs(gl) > 0.001 ? gp / Math.abs(gl) : gp > 0 ? 3 : 0;
  const wConsist = wTotalDays > 0 ? wProfitDays / wTotalDays * 100 : 0;
  const wWlRatio = Math.abs(al) > 0.001 ? aw / Math.abs(al) : aw > 0 ? 2 : 0;
  const wDdCtrl  = wMaxDD === 0 ? 100 : wPeak > 0.001 ? Math.max(100 - wMaxDD / wPeak * 100, 0) : 0;
  const perfArr  = [
    Math.min(wWinRate, 100),
    Math.min(wPf / 3 * 100, 100),
    Math.min(wConsist, 100),
    Math.min(wWlRatio / 2 * 100, 100),
    ...(wTotalDays >= 5 ? [Math.max(wDdCtrl, 0)] : []),
  ];
  const perf = Math.round(perfArr.reduce((s, v) => s + v, 0) / perfArr.length);

  return { disc, perf };
}

// ── Compute all stats ─────────────────────────────────────────────────────────
function computeAll(trades: DashTrade[], now: Date) {
  const closed = trades.filter(t => t.status === 'closed' && t.exit_price != null);
  const pnls   = closed.map(t => calcPnl(t)!);
  // Win/loss classification is sign-based, so it's identical whether derived from
  // points or from ₪ — keep it on points since that's always available.
  const winTrades  = closed.filter(t => calcPnl(t)! > 0);
  const lossTrades = closed.filter(t => calcPnl(t)! < 0);

  const winCount      = winTrades.length;
  const lossCount     = lossTrades.length;
  const neutralTrades = pnls.filter(p => p === 0).length;
  // Monetary (₪/$) aggregates — driven by actual_pnl (falling back to pnl_amount),
  // classified by the money value's own sign so buckets match the amounts averaged
  const moneyWins     = closed.filter(t => tradeMoneyPnl(t) > 0);
  const moneyLosses   = closed.filter(t => tradeMoneyPnl(t) < 0);
  const grossProfit   = moneyWins.reduce((s, t) => s + tradeMoneyPnl(t), 0);
  const grossLoss     = moneyLosses.reduce((s, t) => s + tradeMoneyPnl(t), 0);
  const totalPnl      = closed.reduce((s, t) => s + tradeMoneyPnl(t), 0);
  const avgWin        = moneyWins.length   > 0 ? grossProfit / moneyWins.length   : 0;
  const avgLoss       = moneyLosses.length > 0 ? grossLoss   / moneyLosses.length : 0;
  const totalPnlPoints = pnls.reduce((s, p) => s + p, 0);

  const closedWithAmount = closed.filter(hasMoneyPnl);
  const hasPnlAmount     = closedWithAmount.length > 0;
  const pnlCurrencies    = Array.from(new Set(closedWithAmount.map(t => t.pnl_currency ?? '₪')));
  const pnlCurrency      = pnlCurrencies.length === 1 ? pnlCurrencies[0] : '₪';

  // Period P&L = current calendar month
  const periodPnl = closed.reduce((s, t) => {
    const d = new Date(t.closed_at ?? t.submitted_at);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      ? s + tradeMoneyPnl(t) : s;
  }, 0);

  const todayStr    = now.toISOString().slice(0, 10);
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const todayTrades   = closed.filter(t => (t.closed_at ?? t.submitted_at).slice(0, 10) === todayStr);
  const weekTrades    = closed.filter(t => new Date(t.closed_at ?? t.submitted_at) >= startOfWeek);
  const monthTrades   = closed.filter(t => {
    const d = new Date(t.closed_at ?? t.submitted_at);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const dailyPnl    = todayTrades.reduce((s, t) => s + tradeMoneyPnl(t), 0);
  const dailyCount  = todayTrades.length;
  const weeklyPnl   = weekTrades.reduce((s, t) => s + tradeMoneyPnl(t), 0);
  const weeklyCount = weekTrades.length;
  const monthlyPnl  = monthTrades.reduce((s, t) => s + tradeMoneyPnl(t), 0);
  const monthlyCount = monthTrades.length;
  const totalCount  = closed.length;

  const dayMap: Record<string, number> = {};
  for (const t of closed) {
    const k = dayKey(t.closed_at ?? t.submitted_at);
    dayMap[k] = (dayMap[k] ?? 0) + tradeMoneyPnl(t);
  }

  let profitDays = 0, lossDays = 0, neutralDays = 0;
  for (const v of Object.values(dayMap)) {
    if (v > 0) profitDays++; else if (v < 0) lossDays++; else neutralDays++;
  }

  // Drawdown: walk sorted daily equity curve; track high-water mark and largest peak→trough drop
  let cum = 0, peak = 0, maxDD = 0;
  for (const k of Object.keys(dayMap).sort()) {
    cum += dayMap[k];
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  // No drawdown ever → 100; equity never went positive → 0; otherwise invert drawdown/peak ratio
  const ddCtrl = maxDD === 0 ? 100 : peak > 0.001 ? Math.max(100 - (maxDD / peak) * 100, 0) : 0;

  const totalDays = profitDays + lossDays + neutralDays;
  const winRate   = (winCount + lossCount) > 0 ? winCount / (winCount + lossCount) * 100 : 0;
  const pf        = Math.abs(grossLoss) > 0.001 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? 3 : 0;
  const consist   = totalDays > 0 ? profitDays / totalDays * 100 : 0;
  const wlRatio   = Math.abs(avgLoss) > 0.001 ? avgWin / Math.abs(avgLoss) : avgWin > 0 ? 2 : 0;

  // ── Discipline scores (process-based) ─────────────────────────────────────
  const withPlanScore   = closed.filter(t => t.plan_score != null);
  const processScore    = withPlanScore.length > 0
    ? Math.round(withPlanScore.reduce((s, t) => s + t.plan_score!, 0) / withPlanScore.length)
    : 50;

  const withStratCond   = closed.filter(t => Array.isArray(t.strategy_conditions_checked) && t.strategy_conditions_checked.length > 0);
  const hasStrategyConditions = withStratCond.length > 0;
  const strategyLoyalty = hasStrategyConditions
    ? Math.round(
        withStratCond.reduce((s, t) => {
          const arr = t.strategy_conditions_checked!;
          return s + (arr.filter(x => x.checked).length / arr.length) * 100;
        }, 0) / withStratCond.length
      )
    : null;

  const withMovedSlD    = closed.filter(t => t.moved_sl != null);
  const slKeeping       = withMovedSlD.length > 0
    ? Math.round(withMovedSlD.filter(t => t.moved_sl === false).length / withMovedSlD.length * 100)
    : 100;

  const withExitedEarly = closed.filter(t => t.exited_early != null);
  const patience        = withExitedEarly.length > 0
    ? Math.round(withExitedEarly.filter(t => t.exited_early === false).length / withExitedEarly.length * 100)
    : 100;

  const withFomoEntry   = closed.filter(t => t.fomo_entry != null);
  const cleanEntries    = withFomoEntry.length > 0
    ? Math.round(withFomoEntry.filter(t => t.fomo_entry === false).length / withFomoEntry.length * 100)
    : 100;

  const withRevengeTrade  = closed.filter(t => t.revenge_trade != null);
  const emotionalControl  = withRevengeTrade.length > 0
    ? Math.round(withRevengeTrade.filter(t => t.revenge_trade === false).length / withRevengeTrade.length * 100)
    : 100;

  const disciplineScores  = [
    processScore,
    ...(strategyLoyalty !== null ? [strategyLoyalty] : []),
    slKeeping,
    patience,
    cleanEntries,
    emotionalControl,
  ];

  // ── Performance scores (results-based) ────────────────────────────────────
  // Drawdown control needs ≥5 distinct trading days to be meaningful
  const hasDrawdownCtrl   = totalDays >= 5;
  const performanceScores = [
    Math.round(Math.min(winRate, 100)),
    Math.round(Math.min(pf / 3 * 100, 100)),
    Math.round(Math.min(consist, 100)),
    Math.round(Math.min(wlRatio / 2 * 100, 100)),
    ...(hasDrawdownCtrl ? [Math.round(Math.max(ddCtrl, 0))] : []),
  ];

  // ── Trend: last 30 days vs 31–60 days ago ────────────────────────────────
  const nowMs  = now.getTime();
  const ms30   = 30 * 24 * 60 * 60 * 1000;
  const recent = closed.filter(t => nowMs - new Date(t.closed_at ?? t.submitted_at).getTime() <= ms30);
  const prev   = closed.filter(t => {
    const age = nowMs - new Date(t.closed_at ?? t.submitted_at).getTime();
    return age > ms30 && age <= ms30 * 2;
  });
  const rW = recent.length >= 3 ? windowAvgScores(recent) : null;
  const pW = prev.length   >= 3 ? windowAvgScores(prev)   : null;
  const disciplineTrend  = rW && pW ? rW.disc - pW.disc : null;
  const performanceTrend = rW && pW ? rW.perf - pW.perf : null;

  const profitDayPct = totalDays > 0 ? Math.round(profitDays / totalDays * 100) : 0;
  const winPct       = (winCount + lossCount) > 0 ? Math.round(winCount / (winCount + lossCount) * 100) : 0;

  return {
    profitDays, lossDays, neutralDays, profitDayPct,
    winTrades: winCount, lossTrades: lossCount, neutralTrades, winPct,
    avgWin, avgLoss, grossProfit, grossLoss, totalPnl, totalPnlPoints,
    hasPnlAmount, pnlCurrency, periodPnl,
    dailyPnl, dailyCount, weeklyPnl, weeklyCount, monthlyPnl, monthlyCount, totalCount,
    disciplineScores, performanceScores, hasStrategyConditions, hasDrawdownCtrl,
    disciplineTrend, performanceTrend,
    dayMap,
    dailySeries:      buildDailySeries(dayMap, 30, now),
    weeklySeries:     buildWeeklySeries(dayMap, 12, now),
    monthlySeries:    buildMonthlySeries(dayMap, 12, now),
    cumulativeSeries: buildCumulativeSeries(dayMap, 60, now),
  };
}

// ── SemiGauge (semicircle, multi-segment) ────────────────────────────────────
function semiArcPoint(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy - r * Math.sin(rad)];
}
function semiArcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = semiArcPoint(cx, cy, r, a0);
  const [x1, y1] = semiArcPoint(cx, cy, r, a1);
  const largeArc = Math.abs(a0 - a1) > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1}`;
}
function SemiGauge({ segments, width = 140, strokeWidth = 12 }: {
  segments: { value: number; color: string }[]; width?: number; strokeWidth?: number;
}) {
  const r      = (width - strokeWidth) / 2;
  const cx     = width / 2;
  const cy     = r + strokeWidth / 2;
  const height = cy + strokeWidth / 2;
  const total  = segments.reduce((s, sg) => s + Math.max(sg.value, 0), 0);

  if (total <= 0) {
    return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ flexShrink: 0, display: 'block' }} />;
  }

  const validSegs = segments.filter(sg => Math.max(sg.value, 0) > 0);
  let cursor = 180;
  const segsWithEnd = validSegs.map((sg, idx) => {
    const span = (Math.max(sg.value, 0) / total) * 180;
    const end  = idx === validSegs.length - 1 ? 0 : cursor - span;
    cursor = end;
    return { color: sg.color, end };
  });

  // Painter's algorithm: draw last segment first as a full 180°→0° arc, then each
  // preceding segment paints over from 180° to its own end angle. Any sub-pixel gap
  // at a junction shows the correct underlying color, never the card background.
  const layers = [...segsWithEnd].reverse().map(sg => ({
    d: semiArcPath(cx, cy, r, 180, sg.end),
    color: sg.color,
  }));

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      style={{ flexShrink: 0, display: 'block' }}>
      {layers.map((l, i) => (
        <path key={i} d={l.d} fill="none" stroke={l.color}
          strokeWidth={strokeWidth} strokeLinecap="butt" />
      ))}
    </svg>
  );
}

// ── SplitBar (horizontal, two-tone) ───────────────────────────────────────────
function SplitBar({ left, right, leftColor, rightColor, height = 10 }: {
  left: number; right: number; leftColor: string; rightColor: string; height?: number;
}) {
  const total    = left + right;
  const leftPct  = total > 0.001 ? (left / total) * 100 : 50;
  return (
    <div className="flex w-full overflow-hidden" style={{ height, borderRadius: 999 }}>
      <div style={{ width: `${leftPct}%`, background: leftColor }} />
      <div style={{ width: `${100 - leftPct}%`, background: rightColor }} />
    </div>
  );
}

// ── Score color by value ──────────────────────────────────────────────────────
function scoreColor(score: number): string {
  if (score >= 67) return '#00C853';
  if (score >= 34) return '#FF9800';
  return '#FF3B30';
}

function miniNumColor(score: number): string {
  return score >= 60 ? '#00C853' : '#FF3B30';
}

// ── Discipline radar config ───────────────────────────────────────────────────
const D_LABELS = ['ציון תהליך', 'נאמנות לאסטרטגיה', 'שמירה על SL', 'סבלנות', 'כניסות נקיות', 'שליטה רגשית'];
const D_DESCS  = [
  'ממוצע ציון תהליך לעסקאות סגורות',
  'אחוז עסקאות שבהן נשמרה האסטרטגיה',
  'אחוז עסקאות שבהן לא הוזז ה-Stop Loss',
  'אחוז עסקאות שלא הסתיימו מוקדם מהיעד',
  'אחוז עסקאות שנכנסו בלי לחץ FOMO',
  'אחוז עסקאות שנכנסו בלי נקמה אחרי הפסד',
];
const D_TIPS = [
  'מלא ציון תהליך לכל עסקה לפני כניסה',
  'בדוק את כל תנאי האסטרטגיה לפני כניסה',
  'הגדר Stop Loss ואל תזיז אותו לעולם',
  'המתן לסיום היעד המלא לפני יציאה',
  'כנס רק להגדרות מוכרות, לא מדחף רגשי',
  'קח הפסקה אחרי הפסד לפני עסקה הבאה',
];

// ── Performance radar config ──────────────────────────────────────────────────
const P_LABELS = ['אחוז הצלחה', 'פקטור רווח', 'עקביות', 'יחס רווח/הפסד', 'שליטה בירידת ערך'];
const P_DESCS  = [
  'אחוז הצלחה מבין עסקאות סגורות',
  'רווח גולמי חלקי הפסד גולמי',
  'אחוז ימים רווחיים מכלל ימי מסחר',
  'ממוצע רווח חלקי ממוצע הפסד',
  'שליטה בירידה המקסימלית מהשיא',
];
const P_TIPS = [
  'שפר את בחירת ההגדרות ותרכז על איכות',
  'הגדל את יחס RR המינימלי לכל עסקה',
  'הגדר מכסת הפסד יומית ועצור כשמגיעים',
  'הרץ רווחים רחוק יותר וחתוך הפסדים מהר',
  'הגדר מכסת ירידה שבועית וכבד אותה',
];

// ── Radar card (shared for both discipline and performance) ───────────────────
function RadarCard({
  title,
  labels,
  descs,
  tips,
  scores,
  gradId,
  miniCards,
  trend,
}: {
  title: string;
  labels: string[];
  descs: string[];
  tips: string[];
  scores: number[];
  gradId: string;
  miniCards?: { label: string; score: number | null }[];
  trend?: number | null;
}) {
  const [hov, setHov] = useState<number | null>(null);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setAnimated(true), 60);
    return () => clearTimeout(id);
  }, []);

  const N   = scores.length;
  const cx  = 120; const cy = 120; const R = 80;
  const ang = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / N;
  const pt  = (i: number, s: number): [number, number] =>
    [cx + R * s * Math.cos(ang(i)), cy + R * s * Math.sin(ang(i))];
  const poly     = (s: number) => Array.from({ length: N }, (_, i) => pt(i, s).join(',')).join(' ');
  const dataPoly = scores.map((v, i) => pt(i, Math.min(v, 100) / 100).join(',')).join(' ');
  const avgScore = Math.round(scores.reduce((s, v) => s + v, 0) / N);
  const color    = scoreColor(avgScore);

  const allMiniCards = miniCards ?? labels.map((l, i) => ({ label: l, score: scores[i] }));
  const scoredCards  = allMiniCards.filter((mc): mc is { label: string; score: number } => mc.score !== null);
  const maxS = scoredCards.length >= 2 ? Math.max(...scoredCards.map(mc => mc.score)) : null;
  const minS = scoredCards.length >= 2 ? Math.min(...scoredCards.map(mc => mc.score)) : null;
  const showInsight = maxS !== null && minS !== null && maxS !== minS;
  const bestCard  = showInsight ? scoredCards.find(mc => mc.score === maxS)! : null;
  const worstCard = showInsight ? [...scoredCards].reverse().find(mc => mc.score === minS)! : null;

  return (
    <Card>
      {/* Header — title + score circle + trend indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <p style={{ fontSize: 15, fontWeight: 700, color: TEXT }}>{title}</p>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          background: `${color}22`,
          border: `2px solid ${color}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 16, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>{avgScore}</span>
        </div>
        {trend != null && (
          <span style={{
            fontSize: 12, fontWeight: 700,
            color: trend > 0 ? '#00C853' : trend < 0 ? '#FF3B30' : MUTED,
          }}>
            {trend > 0 ? `▲ +${trend}` : trend < 0 ? `▼ ${trend}` : '—'}
          </span>
        )}
      </div>

      {/* SVG radar — brand teal throughout */}
      <svg width="100%" viewBox="0 0 240 240" preserveAspectRatio="xMidYMid meet"
        style={{ maxWidth: 300, display: 'block', margin: '0 auto', overflow: 'visible' }}>
        <defs>
          <radialGradient id={gradId} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor={ACCENT} stopOpacity={0.25} />
            <stop offset="100%" stopColor={ACCENT} stopOpacity={0.05} />
          </radialGradient>
        </defs>

        {/* Grid rings */}
        {[0.25, 0.5, 0.75, 1].map(s => (
          <polygon key={s} points={poly(s)} fill="none" stroke={BORDER} strokeWidth={0.8} />
        ))}

        {/* Axis lines */}
        {Array.from({ length: N }, (_, i) => {
          const [x, y] = pt(i, 1);
          return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={BORDER} strokeWidth={0.8} />;
        })}

        {/* Animated data layer — fixed teal */}
        <g style={{
          transformOrigin: `${cx}px ${cy}px`,
          transform: animated ? 'scale(1)' : 'scale(0)',
          transition: 'transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}>
          <polygon points={dataPoly} fill={`url(#${gradId})`} stroke={ACCENT} strokeWidth={1.5} />
          {scores.map((v, i) => {
            const [x, y] = pt(i, Math.min(v, 100) / 100);
            const isHov  = hov === i;
            return (
              <g key={i} style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHov(i)}
                onMouseLeave={() => setHov(null)}
                onClick={() => setHov(isHov ? null : i)}>
                <circle cx={x} cy={y} r={9}  fill={ACCENT} opacity={isHov ? 0.3 : 0.12} />
                <circle cx={x} cy={y} r={4}  fill={ACCENT} />
              </g>
            );
          })}
        </g>

        {/* Axis labels */}
        {Array.from({ length: N }, (_, i) => {
          const [x, y] = pt(i, 1.3);
          return (
            <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
              fontSize={13} fontWeight={600}
              fill={hov === i ? ACCENT : MUTED}>
              {labels[i]}
            </text>
          );
        })}
      </svg>

      {/* Insight line or hover tooltip — share the same space */}
      <div style={{ minHeight: 44, marginTop: 4 }}>
        {hov !== null ? (
          <div className="rounded-xl px-3 py-2"
            style={{ background: SURF2, border: `1px solid ${BORDER}` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: ACCENT }}>{labels[hov]}</span>
              <span style={{ fontSize: 15, fontWeight: 800, color: ACCENT, fontVariantNumeric: 'tabular-nums' }}>{scores[hov]}</span>
            </div>
            <p style={{ fontSize: 11, color: MUTED, fontWeight: 600, marginTop: 2 }}>{descs[hov]}</p>
            <p style={{ fontSize: 11, color: TEXT2, fontWeight: 600, marginTop: 2 }}>→ {tips[hov]}</p>
          </div>
        ) : showInsight ? (
          <p style={{ textAlign: 'center', fontSize: 11, color: MUTED, fontWeight: 600, lineHeight: 1.6 }}>
            {'נקודת החוזק שלך: '}
            <span style={{ color: '#00C853', fontWeight: 700 }}>{bestCard!.label} ({bestCard!.score})</span>
            {' · דורש שיפור: '}
            <span style={{ color: worstCard!.score >= 60 ? '#FF9800' : '#FF3B30', fontWeight: 700 }}>{worstCard!.label} ({worstCard!.score})</span>
          </p>
        ) : null}
      </div>

      {/* Mini-cards — binary color on score number, no side bar */}
      <div className="grid grid-cols-3 gap-1 mt-1">
        {allMiniCards.map(({ label, score }, i) => {
          if (score === null) {
            return (
              <div key={label} style={{ background: SURF2, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 10px' }}>
                <p style={{ fontSize: 12, color: MUTED, fontWeight: 600, lineHeight: 1.3 }}>{label}</p>
                <p style={{ fontSize: 10, color: MUTED, fontWeight: 600, lineHeight: 1.4, marginTop: 2 }}>אין מספיק נתונים</p>
              </div>
            );
          }
          return (
            <div key={label}
              style={{
                background: SURF2,
                border: `1px solid ${BORDER}`,
                borderRadius: 8,
                padding: '8px 10px',
                cursor: 'pointer',
              }}
              onMouseEnter={() => setHov(i)}
              onMouseLeave={() => setHov(null)}
              onClick={() => setHov(hov === i ? null : i)}>
              <p style={{ fontSize: 12, color: MUTED, fontWeight: 600, lineHeight: 1.3 }}>{label}</p>
              <p style={{ fontSize: 19, fontWeight: 800, color: miniNumColor(score), fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>{score}</p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Bar chart ─────────────────────────────────────────────────────────────────
function BarChart({ data }: { data: BarItem[] }) {
  const maxAbs = Math.max(...data.map(d => Math.abs(d.value)), 0.001);
  const W = 400; const H = 100; const bw = Math.max(2, Math.floor(W / data.length) - 2);
  const step = Math.max(1, Math.floor(data.length / 8));
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H + 18}`} preserveAspectRatio="none">
      <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke={BORDER} strokeWidth={0.8} />
      {data.map((d, i) => {
        const x  = (i / data.length) * W + 1;
        const h  = (Math.abs(d.value) / maxAbs) * (H * 0.44);
        const y  = d.value >= 0 ? H / 2 - h : H / 2;
        return (
          <g key={i}>
            <rect x={x} y={y} width={Math.max(bw, 2)} height={Math.max(h, 1)}
              fill={d.value === 0 ? SURF2 : d.value > 0 ? GREEN : RED} opacity={0.85} rx={1} />
            {i % step === 0 && (
              <text x={x + bw / 2} y={H + 13} textAnchor="middle" fontSize={7} fill={MUTED}>
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Line chart ────────────────────────────────────────────────────────────────
function LineChart({ data }: { data: BarItem[] }) {
  if (data.length < 2) return null;
  const vals = data.map(d => d.value);
  const minV = Math.min(...vals); const maxV = Math.max(...vals);
  const span = Math.max(maxV - minV, 0.001);
  const W = 400; const H = 100; const pd = 4;
  const toX = (i: number) => (i / (data.length - 1)) * W;
  const toY = (v: number) => H - pd - ((v - minV) / span) * (H - pd * 2);
  const pts  = data.map((d, i) => [toX(i), toY(d.value)] as [number, number]);
  const lineD = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaD = `${lineD} L${W},${H} L0,${H} Z`;
  const isUp  = vals[vals.length - 1] >= vals[0];
  const col   = isUp ? ACCENT : RED;
  const step  = Math.max(1, Math.floor(data.length / 8));
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H + 18}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="lcGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={col} stopOpacity={0.2} />
          <stop offset="100%" stopColor={col} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#lcGrad)" />
      <path d={lineD} fill="none" stroke={col} strokeWidth={1.8}
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {data.map((d, i) => i % step === 0 ? (
        <text key={i} x={toX(i)} y={H + 13} textAnchor="middle" fontSize={7} fill={MUTED}>
          {d.label}
        </text>
      ) : null)}
    </svg>
  );
}

// ── Month Calendar ────────────────────────────────────────────────────────────
const MONTHS_HE = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
const DAYS_SH   = ['א','ב','ג','ד','ה','ו','ש'];

function MonthCalendar({
  dayMap, calDate, onPrev, onNext,
}: {
  dayMap: Record<string, number>;
  calDate: Date;
  onPrev: () => void;
  onNext: () => void;
}) {
  const yr = calDate.getFullYear(); const mo = calDate.getMonth();
  const firstDow = new Date(yr, mo, 1).getDay();
  const daysInM  = new Date(yr, mo + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(firstDow).fill(null)];
  for (let d = 1; d <= daysInM; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  function key(d: number) {
    return `${yr}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function dayPnl(d: number) { return dayMap[key(d)] ?? 0; }
  function hasTrade(d: number) { return key(d) in dayMap; }
  function bg(pnl: number) {
    if (pnl === 0) return 'rgba(255,255,255,0.03)';
    const i = Math.min(Math.abs(pnl) / 3, 1);
    return pnl > 0 ? `rgba(34,197,94,${0.12 + i * 0.45})` : `rgba(239,68,68,${0.12 + i * 0.45})`;
  }

  const monthPnl  = Array.from({ length: daysInM }, (_, i) => dayPnl(i + 1)).reduce((s, v) => s + v, 0);
  const tradeDays = Array.from({ length: daysInM }, (_, i) => i + 1).filter(d => hasTrade(d)).length;
  const profitDs  = Array.from({ length: daysInM }, (_, i) => dayPnl(i + 1)).filter(v => v > 0).length;

  return (
    <div className="flex flex-col gap-2">
      {/* Nav */}
      <div className="flex items-center justify-between mb-1">
        <button onClick={onPrev} className="p-3 rounded-lg" style={{ background: SURF2, color: TEXT2 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <p className="text-sm font-semibold" style={{ color: TEXT }}>{MONTHS_HE[mo]} {yr}</p>
        <button onClick={onNext} className="p-3 rounded-lg" style={{ background: SURF2, color: TEXT2 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
      </div>

      {/* Day headers + Weeks — horizontally scrollable on mobile */}
      <div className="overflow-x-auto md:overflow-visible" style={{ WebkitOverflowScrolling: 'touch' }}>
        <div style={{ minWidth: 480 }}>
          {/* Day headers */}
          <div className="grid gap-0.5" style={{ gridTemplateColumns: 'repeat(8, 1fr)' }}>
            {DAYS_SH.map(d => (
              <div key={d} className="text-center text-[9px] font-semibold" style={{ color: MUTED, fontWeight: 600 }}>{d}</div>
            ))}
            <div className="text-center text-[9px] font-semibold" style={{ color: MUTED, fontWeight: 600 }}>שבוע</div>
          </div>

          {/* Weeks */}
          {weeks.map((week, wi) => {
            const weekPnl = week.reduce<number>((s, d) => s + (d != null ? dayPnl(d) : 0), 0);
            return (
              <div key={wi} className="grid gap-0.5 mt-0.5" style={{ gridTemplateColumns: 'repeat(8, 1fr)' }}>
                {week.map((day, di) => {
                  const pnl = day ? dayPnl(day) : 0;
                  const has = day ? hasTrade(day) : false;
                  return (
                    <div key={di} className="rounded flex flex-col items-center justify-center py-0.5"
                      style={{ background: day ? bg(pnl) : 'transparent', minHeight: 30, border: `1px solid ${BORDER}`, borderRadius: 6 }}>
                      {day && (
                        <>
                          <span className="text-[10px] font-medium leading-none"
                            style={{ color: has ? (pnl >= 0 ? GREEN : RED) : MUTED, fontWeight: 600 }}>{day}</span>
                          {has && (
                            <span className="text-[8px] font-semibold leading-none mt-0.5"
                              style={{ color: pnl >= 0 ? GREEN : RED }}>
                              {pnl > 0 ? '+' : ''}{pnl.toFixed(0)}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
                <div className="flex items-center justify-center rounded px-0.5"
                  style={{ background: SURF2, minHeight: 30 }}>
                  <span className="text-[9px] font-bold"
                    style={{ color: weekPnl > 0 ? GREEN : weekPnl < 0 ? RED : MUTED }}>
                    {weekPnl > 0 ? '+' : ''}{weekPnl.toFixed(0)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Monthly summary */}
      <div className="grid grid-cols-3 gap-2 mt-1">
        {[
          { label: 'P&L חודשי', value: formatPnlIls(monthPnl), color: monthPnl >= 0 ? GREEN : RED },
          { label: 'ימי מסחר', value: String(tradeDays), color: TEXT },
          { label: 'ימים רווחיים', value: tradeDays > 0 ? `${Math.round(profitDs / tradeDays * 100)}%` : '—', color: GREEN },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl p-2 text-center" style={{ background: SURF2 }}>
            <p className="text-[9px]" style={{ color: MUTED, fontWeight: 600 }}>{label}</p>
            <p className="text-xs font-bold" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Trade detail panel ────────────────────────────────────────────────────────
function TradeDetailPanel({ trade, onClose, aiReview, aiLoading, onAiReview }: {
  trade: DashTrade;
  onClose: () => void;
  aiReview: string | null;
  aiLoading: boolean;
  onAiReview: () => void;
}) {
  const pnl = calcPnl(trade);
  const dir = tradeDir(trade);

  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}>
      <div className="w-full max-h-[88vh] overflow-y-auto rounded-t-2xl"
        style={{ background: '#0d1117', border: `1px solid ${BORDER}` }}
        onClick={e => e.stopPropagation()}>
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full" style={{ background: BORDER }} />
        </div>
        <div dir="rtl" className="px-4 pb-8 flex flex-col gap-4">

          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <p className="text-base font-bold" style={{ color: TEXT }}>{trade.strategy}</p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {trade.symbol && (
                  <span className="text-xs px-2 py-0.5 rounded-md font-semibold font-mono"
                    style={{ background: 'rgba(0,210,210,0.12)', color: ACCENT }}>{trade.symbol}</span>
                )}
                <span className="text-xs px-2 py-0.5 rounded-md font-semibold"
                  style={{
                    background: dir === 'long' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                    color: dir === 'long' ? GREEN : RED,
                  }}>
                  {dir === 'long' ? 'לונג ↑' : 'שורט ↓'}
                </span>
                <span className="text-[10px]" style={{ color: MUTED, fontWeight: 600 }}>{fmtDateTime(trade.submitted_at)}</span>
              </div>
            </div>
            {pnl !== null && (
              <p className="text-2xl font-bold" style={{ color: pnl >= 0 ? GREEN : RED }}>
                {trade.pnl_amount != null ? (
                  <>
                    {formatPnlIls(trade.pnl_amount, trade.pnl_currency ?? '₪')}
                    <span className="text-sm font-semibold" style={{ opacity: 0.6 }}> ({formatPnlPoints(pnl)})</span>
                  </>
                ) : fmtPnl(pnl)}
              </p>
            )}
          </div>

          {/* Prices */}
          <div className="grid grid-cols-3 gap-2">
            {([['כניסה', trade.entry_price.toFixed(2), TEXT],
               ['Stop Loss', trade.stop_loss.toFixed(2), RED],
               ['Take Profit', trade.take_profit.toFixed(2), GREEN]] as [string,string,string][]).map(([l,v,c]) => (
              <div key={l} className="rounded-xl p-2.5 text-center" style={{ background: SURF2 }}>
                <p className="text-[10px]" style={{ color: MUTED, fontWeight: 600 }}>{l}</p>
                <p className="text-sm font-bold font-mono" style={{ color: c }}>{v}</p>
              </div>
            ))}
          </div>

          {trade.exit_price != null && (
            <div className="rounded-xl px-3 py-2.5 flex items-center justify-between"
              style={{ background: pnl != null && pnl >= 0 ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)' }}>
              <div>
                <p className="text-[10px]" style={{ color: MUTED, fontWeight: 600 }}>מחיר יציאה</p>
                <p className="text-sm font-bold font-mono"
                  style={{ color: pnl != null && pnl >= 0 ? GREEN : RED }}>
                  {Number(trade.exit_price).toFixed(2)}
                </p>
              </div>
              <div className="text-left">
                <p className="text-[10px]" style={{ color: MUTED, fontWeight: 600 }}>R:R</p>
                <p className="text-sm font-bold" style={{ color: ACCENT }}>1:{trade.rr_ratio.toFixed(1)}</p>
              </div>
              {trade.closed_at && (
                <div className="text-left">
                  <p className="text-[10px]" style={{ color: MUTED, fontWeight: 600 }}>נסגרה</p>
                  <p className="text-xs" style={{ color: TEXT2, fontWeight: 600 }}>{fmtDate(trade.closed_at)}</p>
                </div>
              )}
            </div>
          )}

          {trade.trade_reason && (
            <div className="rounded-xl p-3" style={{ background: SURF2, borderRight: `2px solid ${ACCENT}` }}>
              <p className="text-[10px] font-semibold mb-1" style={{ color: MUTED, fontWeight: 600 }}>סיבת כניסה</p>
              <p className="text-xs leading-relaxed" style={{ color: TEXT2, fontWeight: 600 }}>{trade.trade_reason}</p>
            </div>
          )}

          {trade.exit_reason && (
            <div className="rounded-xl p-3" style={{ background: SURF2, borderRight: `2px solid ${BORDER}` }}>
              <p className="text-[10px] font-semibold mb-1" style={{ color: MUTED, fontWeight: 600 }}>סיבת יציאה</p>
              <p className="text-xs leading-relaxed" style={{ color: TEXT2, fontWeight: 600 }}>{trade.exit_reason}</p>
            </div>
          )}

          {/* AI Review */}
          {!aiReview && !aiLoading && (
            <button onClick={onAiReview}
              className="w-full py-2.5 rounded-xl text-sm font-semibold transition-opacity hover:opacity-80 flex items-center justify-center gap-1.5"
              style={{ background: 'rgba(0,210,210,0.12)', color: ACCENT, border: `1px solid rgba(0,210,210,0.25)` }}>
              <Sparkles size={14} /> ניתוח AI על העסקה
            </button>
          )}
          {aiLoading && (
            <div className="flex flex-col gap-2">
              {[80, 60, 70].map((w, i) => (
                <div key={i} className="h-3 rounded animate-pulse" style={{ background: SURF2, width: `${w}%` }} />
              ))}
            </div>
          )}
          {aiReview && (
            <div>
              <p className="text-xs font-semibold mb-2" style={{ color: MUTED, fontWeight: 600 }}>ניתוח AI</p>
              <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: TEXT2, fontWeight: 600 }}>{aiReview}</p>
            </div>
          )}

          <button onClick={onClose} className="py-2.5 rounded-xl text-sm font-medium"
            style={{ background: SURF2, color: TEXT2, fontWeight: 600 }}>סגור</button>
        </div>
      </div>
    </div>
  );
}

// ── Card wrapper ──────────────────────────────────────────────────────────────
function Card({ children, className = '', style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`rounded-xl p-5 ${className}`}
      style={{
        background: SURF,
        border: `1px solid ${BORDER}`,
        boxShadow: '0 1px 3px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.03)',
        ...style,
      }}>
      {children}
    </div>
  );
}

function SectionTitle({ children, large }: { children: React.ReactNode; large?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
      <div style={{ width: 3, height: 14, background: ACCENT, borderRadius: 99, flexShrink: 0 }} />
      <p style={{
        fontSize: large ? 16 : 12, fontWeight: 600, letterSpacing: '0.06em',
        textTransform: 'uppercase', color: large ? TEXT2 : MUTED,
      }}>
        {children}
      </p>
    </div>
  );
}

// ── Weekly summary types ──────────────────────────────────────────────────────
interface WeeklyDailyPnl {
  date: string;
  pnl: number;
  trades: number;
}

interface WeeklyBestWorstTrade {
  strategy: string;
  pnl: number;
  date: string;
}

interface WeeklyStats {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number | null;
  total_pnl: number;
  pnl_currency: string;
  avg_process_score: number | null;
  daily_pnl: WeeklyDailyPnl[];
  avg_emotional_state: number | null;
  best_trade: WeeklyBestWorstTrade | null;
  worst_trade: WeeklyBestWorstTrade | null;
  most_used_strategy: string | null;
}

interface WeeklySummary {
  week_start: string;
  week_end: string;
  summary_text: string | null;
  stats: WeeklyStats;
  created_at: string;
}

// ── Weekly summary markdown rendering ──────────────────────────────────────────
const SECTION_ICONS: { match: string; icon: typeof CheckCircle; color: string }[] = [
  { match: 'מה עבד טוב', icon: CheckCircle, color: GREEN },
  { match: 'דפוסים', icon: AlertTriangle, color: RED },
  { match: 'מצב רגשי', icon: Heart, color: YELLOW },
  { match: 'המלצה', icon: Target, color: ACCENT },
  { match: 'מה שאמרת', icon: Quote, color: ICON_GRAY },
];

// Checkmark/cross-mark and other emoji code points the AI might still produce.
const CHECK_CHARS = '✅✔✓☑';
const CROSS_CHARS = '✖✗✘❌❎';
const INLINE_SPLIT_RE = new RegExp(`(\\*\\*[^*]+\\*\\*|[${CHECK_CHARS}${CROSS_CHARS}]|\\p{Extended_Pictographic}|\\uFE0F)`, 'gu');
const CHECK_RE = new RegExp(`^[${CHECK_CHARS}]$`, 'u');
const CROSS_RE = new RegExp(`^[${CROSS_CHARS}]$`, 'u');
const EMOJI_RE = new RegExp('^(\\p{Extended_Pictographic}|\\uFE0F)$', 'u');

// Render `**bold**` spans within a line of text, swapping ✓/✗ and other emoji for icons.
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split(INLINE_SPLIT_RE).map((part, i) => {
    if (!part) return null;
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    if (m) return <strong key={`${keyPrefix}-${i}`} style={{ fontWeight: 700, color: TEXT }}>{m[1]}</strong>;
    if (CHECK_RE.test(part)) {
      return <CheckCircle key={`${keyPrefix}-${i}`} size={14} style={{ color: ICON_GRAY, display: 'inline-block', verticalAlign: 'middle', margin: '0 2px' }} />;
    }
    if (CROSS_RE.test(part)) {
      return <AlertCircle key={`${keyPrefix}-${i}`} size={14} style={{ color: ICON_GRAY, display: 'inline-block', verticalAlign: 'middle', margin: '0 2px' }} />;
    }
    if (EMOJI_RE.test(part)) return null;
    return part;
  }).filter(part => part !== null && part !== '');
}

// Splits the AI weekly summary into per-##-heading segments, dropping any
// intro/greeting text that appears before the first heading.
function segmentSummaryByHeading(text: string): { heading: string; lines: string[] }[] {
  const segments: { heading: string; lines: string[] }[] = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const rawLine of text.split('\n')) {
    const headingMatch = rawLine.trim().match(/^#{1,6}\s+(.*)/);
    if (headingMatch) {
      current = { heading: headingMatch[1].trim(), lines: [] };
      segments.push(current);
      continue;
    }
    current?.lines.push(rawLine);
  }
  return segments;
}

// Joins markdown lines into a single plain-text blob, stripping list/quote/hr markers,
// for compact line-clamped rendering.
function joinSummaryLines(lines: string[]): string {
  return lines
    .map(l => l.trim())
    .filter(l => l && !/^(-{3,}|\*{3,})\s*$/.test(l))
    .map(l => l
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(new RegExp(`^[${CHECK_CHARS}${CROSS_CHARS}]\\s*`, 'u'), ''))
    .join(' ');
}

// One compact card per AI-summary section: icon + bold heading + up to 3 lines of body text.
function SummarySectionCard({ heading, lines }: { heading: string; lines: string[] }) {
  const section = SECTION_ICONS.find(s => heading.includes(s.match));
  if (section?.match === 'מה שאמרת') return null;

  const Icon = section?.icon;
  const color = section?.color ?? ACCENT;
  const text = joinSummaryLines(lines);
  if (!text) return null;

  return (
    <div style={{
      background: SURF,
      border: `1px solid ${SUBTLE}`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 8,
      padding: '10px 12px',
    }}>
      <div className="flex items-center gap-1.5 mb-1">
        {Icon && <Icon size={14} style={{ color: ICON_GRAY, flexShrink: 0 }} />}
        <p style={{ fontSize: 12, fontWeight: 700, color: TEXT }}>{heading}</p>
      </div>
      <p style={{
        fontSize: 12, lineHeight: 1.5, color: TEXT2, fontWeight: 500,
        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        {renderInline(text, `sec-${heading}`)}
      </p>
    </div>
  );
}

// Renders the optional "what you told yourself" quote in italic, if the AI included one.
function SummaryQuote({ segments }: { segments: { heading: string; lines: string[] }[] }) {
  const seg = segments.find(s => s.heading.includes('מה שאמרת'));
  const text = seg ? joinSummaryLines(seg.lines) : '';
  if (!text) return null;

  return (
    <div style={{
      background: SURF,
      border: `1px solid ${SUBTLE}`,
      borderLeft: `3px solid ${ICON_GRAY}`,
      borderRadius: 8,
      padding: '10px 12px',
    }}>
      <p style={{ fontSize: 12, lineHeight: 1.6, color: MUTED, fontWeight: 600, fontStyle: 'italic', textAlign: 'center', padding: '2px 8px' }}>
        <Quote size={12} style={{ display: 'inline-block', verticalAlign: 'middle', marginInlineEnd: 4, color: ICON_GRAY }} />
        {renderInline(text, 'quote')}
      </p>
    </div>
  );
}

// One compact day card for the weekly daily-breakdown column: green if profitable,
// red if a loss, gray if no trades, with a thin bar showing relative size vs other days.
function WeeklyDayCard({ label, pnl, trades, currency, maxAbs }: { label: string; pnl: number; trades: number; currency: string; maxAbs: number }) {
  const tone = trades === 0 || pnl === 0 ? 'neutral' : pnl > 0 ? 'pos' : 'neg';
  const color = tone === 'pos' ? GREEN : tone === 'neg' ? RED : MUTED;
  const borderColor = tone === 'pos' ? GREEN : tone === 'neg' ? RED : SUBTLE;
  const barPct = maxAbs > 0 ? (Math.abs(pnl) / maxAbs) * 100 : 0;

  return (
    <div style={{ background: SURF, border: `1px solid ${SUBTLE}`, borderLeft: `3px solid ${borderColor}`, borderRadius: 8, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="flex items-center justify-between">
        <span style={{ fontSize: 13, fontWeight: 700, color: TEXT2 }}>{label}</span>
        <div className="flex items-baseline gap-2">
          <span style={{ fontSize: 15, fontWeight: 700, color }}>
            {trades === 0 ? '—' : formatPnlIls(pnl, currency)}
          </span>
          <span style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>
            {trades} עסקאות
          </span>
        </div>
      </div>
      <div style={{ height: 3, borderRadius: 2, background: SUBTLE, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${barPct}%`, background: color, opacity: 0.6, borderRadius: 2 }} />
      </div>
    </div>
  );
}

// Small "vs last week" delta badge for the weekly summary stat pills.
function WeekDelta({ diff, format }: { diff: number; format: (d: number) => string }) {
  if (diff === 0) return null;
  const Icon = diff > 0 ? TrendingUp : TrendingDown;
  const color = diff > 0 ? GREEN : RED;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 10, fontWeight: 600, color, marginTop: 2 }}>
      <Icon size={10} />
      {format(diff)} vs שבוע קודם
    </span>
  );
}

// Color thresholds for the weekly process score: discipline/process quality, not P&L.
function processScoreColor(score: number | null): string {
  if (score == null) return TEXT;
  if (score >= 70) return GREEN;
  if (score >= 50) return YELLOW;
  return RED;
}

// Stat pill for the weekly summary: label on top, large value below, border matching value color.
function StatPill({ label, value, color, delta }: { label: string; value: React.ReactNode; color?: string; delta?: React.ReactNode }) {
  return (
    <div className="text-center" style={{ background: DEEP, border: `1px solid ${color ?? SUBTLE}`, borderRadius: 10, padding: '10px 8px' }}>
      <p style={{ fontSize: 11, color: MUTED, fontWeight: 600, marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 18, fontWeight: 700, color: color ?? TEXT }}>{value}</p>
      {delta}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function DashboardClient({
  trades: initialTrades,
  displayName,
  userId,
  plan,
}: {
  trades: DashTrade[];
  displayName: string;
  userId: string;
  plan: PlanTier;
}) {
  const limits = getPlanLimits(plan);
  const [trades,   setTrades]   = useState<DashTrade[]>(initialTrades);
  const [barMode,  setBarMode]  = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [pnlPeriod, setPnlPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'total'>('total');
  const [lineMode, setLineMode] = useState<'cumulative' | 'daily'>('cumulative');
  const [calDate,  setCalDate]  = useState<Date | null>(null);
  const [selTrade, setSelTrade] = useState<DashTrade | null>(null);
  const [tradeAi,  setTradeAi]  = useState<Record<string, string>>({});
  const [tradeAiL, setTradeAiL] = useState<Record<string, boolean>>({});
  const [weeklySummary, setWeeklySummary] = useState<WeeklySummary | null>(null);
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [weeklyError, setWeeklyError] = useState<string | null>(null);
  const [weeklyUpgradeOpen, setWeeklyUpgradeOpen] = useState(false);
  const [viewedWeekStart, setViewedWeekStart] = useState<string | null>(null);
  const [viewedWeekEnd, setViewedWeekEnd] = useState<string | null>(null);
  const [isCurrentWeek, setIsCurrentWeek] = useState(false);
  const [latestWeekStart, setLatestWeekStart] = useState<string | null>(null);
  const [previousStats, setPreviousStats] = useState<WeeklyStats | null>(null);
  const [isMobile, setIsMobile] = useState(true);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    setIsMobile(media.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, []);

  // "Now" is null during SSR and the first client render (matching), then
  // becomes a real Date once mounted — avoids hydration mismatches from
  // anything date-dependent (greeting, calendar, date-based series).
  const mounted = useMounted();
  const now = useMemo(() => mounted ? new Date() : null, [mounted]);

  const stats = useMemo(() => computeAll(trades, now ?? EPOCH), [trades, now]);
  const dLabels = stats.hasStrategyConditions ? D_LABELS : [D_LABELS[0], ...D_LABELS.slice(2)];
  const dDescs  = stats.hasStrategyConditions ? D_DESCS  : [D_DESCS[0],  ...D_DESCS.slice(2)];
  const dTips   = stats.hasStrategyConditions ? D_TIPS   : [D_TIPS[0],   ...D_TIPS.slice(2)];
  const pLabels    = stats.hasDrawdownCtrl ? P_LABELS : P_LABELS.slice(0, 4);
  const pDescs     = stats.hasDrawdownCtrl ? P_DESCS  : P_DESCS.slice(0, 4);
  const pTips      = stats.hasDrawdownCtrl ? P_TIPS   : P_TIPS.slice(0, 4);
  const pMiniCards = P_LABELS.map((label, i) => ({
    label,
    score: i < stats.performanceScores.length ? stats.performanceScores[i] : null,
  }));
  const effectiveCalDate = calDate ?? now;

  // Re-fetch trades from Supabase (used by the real-time subscription below)
  const fetchTrades = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('trade_plans')
      .select(DASH_TRADE_SELECT)
      .eq('user_id', userId)
      .order('submitted_at', { ascending: false })
      .limit(500);

    if (data) setTrades(data.map(mapDashTrade));
  }, [userId]);

  // Subscribe to trade_plans changes so the dashboard stays in sync with edits
  // made elsewhere (journal close/edit/delete, new trade plans, other tabs).
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel('dashboard-trade-plans')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'trade_plans',
        filter: `user_id=eq.${userId}`,
      }, () => {
        fetchTrades();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, fetchTrades]);

  // Fetch a given week's summary (or the latest completed week if omitted).
  const loadWeek = useCallback(async (weekStart?: string) => {
    setWeeklyLoading(true);
    try {
      const url = weekStart ? `/api/weekly-summary?week_start=${weekStart}` : '/api/weekly-summary';
      const res = await fetch(url);
      const data = await res.json().catch(() => null);
      if (res.status === 403 && data?.error === 'PLAN_LIMIT') {
        setWeeklyUpgradeOpen(true);
        return null;
      }
      if (!res.ok || !data) {
        console.error('[weekly-summary] GET failed', res.status, data);
        setWeeklyError(data?.error ?? `שגיאה בטעינת הסיכום (קוד ${res.status})`);
        return null;
      }
      setWeeklyError(null);
      setWeeklySummary(data.summary ?? null);
      setViewedWeekStart(data.week_start ?? null);
      setViewedWeekEnd(data.week_end ?? null);
      setIsCurrentWeek(data.is_current_week ?? false);
      setPreviousStats(data.previous_stats ?? null);
      setLatestWeekStart(data.latest_week_start ?? null);
      return data;
    } catch (err) {
      console.error('[weekly-summary] GET request failed', err);
      setWeeklyError('שגיאה בטעינת הסיכום השבועי.');
      return null;
    } finally {
      setWeeklyLoading(false);
    }
  }, []);

  // Load this week's AI summary; on Sundays, generate one if it doesn't exist yet.
  useEffect(() => {
    if (!limits.weeklySummary) return;
    let cancelled = false;
    (async () => {
      const data = await loadWeek();
      if (cancelled || !data || data.summary || new Date().getDay() !== 0) return;
      setWeeklyLoading(true);
      try {
        const genRes = await fetch('/api/weekly-summary', { method: 'POST' });
        const genData = await genRes.json().catch(() => null);
        if (genRes.status === 403 && genData?.error === 'PLAN_LIMIT') {
          if (!cancelled) setWeeklyUpgradeOpen(true);
          return;
        }
        if (!genRes.ok || !genData?.summary) {
          console.error('[weekly-summary] auto-generate failed', genRes.status, genData);
          if (!cancelled) setWeeklyError(genData?.error ?? `שגיאה ביצירת הסיכום (קוד ${genRes.status})`);
          return;
        }
        if (!cancelled) {
          setWeeklyError(null);
          setWeeklySummary(genData.summary);
        }
      } catch (err) {
        console.error('[weekly-summary] auto-generate request failed', err);
        if (!cancelled) setWeeklyError('שגיאה ביצירת הסיכום השבועי.');
      } finally {
        if (!cancelled) setWeeklyLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadWeek, limits.weeklySummary]);

  async function refreshWeeklySummary() {
    if (!limits.weeklySummary) { setWeeklyUpgradeOpen(true); return; }
    setWeeklyLoading(true);
    setWeeklyError(null);
    try {
      const url = viewedWeekStart ? `/api/weekly-summary?week_start=${viewedWeekStart}` : '/api/weekly-summary';
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (res.status === 403 && data?.error === 'PLAN_LIMIT') {
        setWeeklyUpgradeOpen(true);
        return;
      }
      if (!res.ok || !data?.summary) {
        console.error('[weekly-summary] POST failed', res.status, data);
        setWeeklyError(data?.error ?? `שגיאה ביצירת הסיכום (קוד ${res.status})`);
        return;
      }
      await loadWeek(data.summary.week_start);
    } catch (err) {
      console.error('[weekly-summary] POST request failed', err);
      setWeeklyError('שגיאה ביצירת הסיכום. נסה שוב.');
    } finally {
      setWeeklyLoading(false);
    }
  }

  function goToPrevWeek() {
    if (!viewedWeekStart) return;
    const d = new Date(`${viewedWeekStart}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - 7);
    loadWeek(d.toISOString().slice(0, 10));
  }

  function goToNextWeek() {
    if (!viewedWeekStart || viewedWeekStart === latestWeekStart) return;
    const d = new Date(`${viewedWeekStart}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    loadWeek(d.toISOString().slice(0, 10));
  }

  async function fetchTradeAi(t: DashTrade) {
    setTradeAiL(p => ({ ...p, [t.id]: true }));
    try {
      const res = await fetch('/api/ai-trade-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade: t, pnl: calcPnl(t) }),
      });
      const { review } = await res.json();
      setTradeAi(p => ({ ...p, [t.id]: review || 'לא ניתן לטעון ניתוח.' }));
    } catch {
      setTradeAi(p => ({ ...p, [t.id]: 'שגיאה בטעינת ניתוח AI.' }));
    }
    setTradeAiL(p => ({ ...p, [t.id]: false }));
  }

  const pnlPeriodMap = {
    daily:   { pnl: stats.dailyPnl,   count: stats.dailyCount },
    weekly:  { pnl: stats.weeklyPnl,  count: stats.weeklyCount },
    monthly: { pnl: stats.monthlyPnl, count: stats.monthlyCount },
    total:   { pnl: stats.totalPnl,   count: stats.totalCount },
  };
  const { pnl: selPeriodPnl, count: selPeriodCount } = pnlPeriodMap[pnlPeriod];
  const selPeriodDisplay = !stats.hasPnlAmount && pnlPeriod === 'total'
    ? fmtPnl(stats.totalPnlPoints)
    : formatPnlIls(selPeriodPnl, stats.pnlCurrency);

  const barData  = barMode === 'daily' ? stats.dailySeries : barMode === 'weekly' ? stats.weeklySeries : stats.monthlySeries;
  const lineData = lineMode === 'cumulative' ? stats.cumulativeSeries : stats.dailySeries;
  const recent   = trades.slice(0, 10);

  const summarySegments = weeklySummary?.summary_text ? segmentSummaryByHeading(weeklySummary.summary_text) : [];
  const weeklyDayMaxAbs = weeklySummary
    ? Math.max(...weeklySummary.stats.daily_pnl.map(d => Math.abs(d.pnl)), 0.001)
    : 0.001;
  const weeklyDaysReversed = weeklySummary ? [...weeklySummary.stats.daily_pnl].reverse() : [];
  const weeklyLabelsReversed = [...DAYS_SH].reverse();

  const dateStr  = now ? now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  const hour     = now ? now.getHours() : null;
  const greeting = hour === null ? '' : hour < 5 ? 'לילה טוב' : hour < 12 ? 'בוקר טוב' : hour < 17 ? 'צהריים טובים' : 'ערב טוב';

  function prevMonth() {
    const base = calDate ?? now ?? new Date();
    setCalDate(new Date(base.getFullYear(), base.getMonth() - 1, 1));
  }
  function nextMonth() {
    const base = calDate ?? now ?? new Date();
    setCalDate(new Date(base.getFullYear(), base.getMonth() + 1, 1));
  }

  return (
    <div dir="rtl" className="min-h-screen px-5 py-6 flex flex-col gap-4">

      {/* ── Greeting ──────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 4 }}>
        <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: MUTED, marginBottom: 4 }}>
          {dateStr}
        </p>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: TEXT, letterSpacing: '-0.02em', lineHeight: 1 }}>
          {greeting && `${greeting}, `}<span style={{ color: ACCENT }}>{displayName}</span>
        </h1>
      </div>

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {trades.length === 0 && (
        <Card className="text-center py-12 flex flex-col items-center gap-3">
          <TrendingUp size={48} />
          <p className="text-base font-semibold" style={{ color: TEXT }}>ברוך הבא ל-Reflect</p>
          <p className="text-sm" style={{ color: TEXT2, fontWeight: 600 }}>תעד עסקה ראשונה כדי להתחיל</p>
        </Card>
      )}

      {trades.length > 0 && (
        <>
          {/* ── Top 4 stat cards ─────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">

            {/* Card 1: Profitable Days */}
            <Card>
              <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: isMobile ? undefined : 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, width: isMobile ? '100%' : undefined }}>
                  <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: TEXT2 }}>ימים רווחיים</p>
                  <p style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: stats.profitDays >= stats.lossDays ? GREEN : RED }}>
                    {stats.profitDayPct}%
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 14, fontWeight: 800, color: GREEN, fontVariantNumeric: 'tabular-nums' }}>{stats.profitDays}</span>
                    <span style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>|</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: TEXT2, fontVariantNumeric: 'tabular-nums' }}>{stats.neutralDays}</span>
                    <span style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>|</span>
                    <span style={{ fontSize: 14, fontWeight: 800, color: RED, fontVariantNumeric: 'tabular-nums' }}>{stats.lossDays}</span>
                  </div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <SemiGauge width={isMobile ? 88 : 140} strokeWidth={12} segments={[
                    { value: stats.profitDays, color: GREEN },
                    { value: stats.lossDays,   color: RED },
                  ]} />
                </div>
              </div>
            </Card>

            {/* Card 2: Win Rate */}
            <Card>
              <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: isMobile ? undefined : 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, width: isMobile ? '100%' : undefined }}>
                  <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: TEXT2 }}>אחוזי הצלחה</p>
                  <p style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: stats.winPct >= 50 ? GREEN : RED }}>
                    {stats.winPct}%
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 14, fontWeight: 800, color: GREEN, fontVariantNumeric: 'tabular-nums' }}>{stats.winTrades}</span>
                    <span style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>|</span>
                    <span style={{ fontSize: 14, fontWeight: 800, color: RED, fontVariantNumeric: 'tabular-nums' }}>{stats.lossTrades}</span>
                  </div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <SemiGauge width={isMobile ? 88 : 140} strokeWidth={12} segments={[
                    { value: stats.winPct,       color: GREEN },
                    { value: 100 - stats.winPct, color: RED },
                  ]} />
                </div>
              </div>
            </Card>

            {/* Card 3: Avg Win/Loss ratio */}
            <Card>
              <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: TEXT2, marginBottom: 14 }}>יחס רווח/הפסד ממוצע</p>
              <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'center', gap: isMobile ? 8 : 16 }}>
                <span style={{ fontSize: isMobile ? 15 : 18, fontWeight: 700, color: TEXT2, fontVariantNumeric: 'tabular-nums' }}>
                  {stats.avgLoss < -0.001 ? (stats.avgWin / Math.abs(stats.avgLoss)).toFixed(2) : '—'}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: isMobile ? undefined : 1 }}>
                  <SplitBar left={stats.avgWin} right={Math.abs(stats.avgLoss)} leftColor={GREEN} rightColor={RED} />
                  <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'flex-start' : 'center', gap: isMobile ? 2 : undefined, justifyContent: isMobile ? undefined : 'space-between' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: GREEN, fontVariantNumeric: 'tabular-nums' }}>{formatPnlIls(stats.avgWin, stats.pnlCurrency)}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: RED, fontVariantNumeric: 'tabular-nums' }}>{formatPnlIls(stats.avgLoss, stats.pnlCurrency)}</span>
                  </div>
                </div>
              </div>
            </Card>

            {/* Card 4: P&L Balance */}
            <Card>
              <p style={{ fontSize: 13, fontWeight: 700, color: TEXT2, marginBottom: 8 }}>מאזן P&L</p>
              <div style={{ display: 'flex', flexDirection: 'row', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
                {(['total', 'monthly', 'weekly', 'daily'] as const).map(p => (
                  <button key={p} onClick={() => setPnlPeriod(p)}
                    style={{
                      background: pnlPeriod === p ? 'rgba(0,210,210,0.12)' : 'transparent',
                      color: pnlPeriod === p ? ACCENT : TEXT2,
                      border: pnlPeriod === p ? `1px solid rgba(0,210,210,0.3)` : `1px solid ${BORDER}`,
                      borderRadius: 6,
                      padding: '5px 10px',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}>
                    {p === 'total' ? 'כללי' : p === 'monthly' ? 'חודשי' : p === 'weekly' ? 'שבועי' : 'יומי'}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: isMobile ? 20 : 36, fontWeight: 800, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', color: selPeriodPnl >= 0 ? GREEN : RED }}>
                  {selPeriodDisplay}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: TEXT2 }}>
                  ({selPeriodCount} עסקאות)
                </span>
              </div>
            </Card>
          </div>

          {/* ── Radar cards ───────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <RadarCard
              title="ניקוד משמעת"
              labels={dLabels}
              descs={dDescs}
              tips={dTips}
              scores={stats.disciplineScores}
              gradId="radarGradDisc"
              trend={stats.disciplineTrend}
            />
            <RadarCard
              title="ניקוד ביצועים"
              labels={pLabels}
              descs={pDescs}
              tips={pTips}
              scores={stats.performanceScores}
              gradId="radarGradPerf"
              miniCards={pMiniCards}
              trend={stats.performanceTrend}
            />
          </div>

          {/* ── Bar + Line charts ─────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

            {/* Bar chart */}
            <Card>
              <div className="flex items-center justify-between mb-3">
                <SectionTitle>רווח/הפסד</SectionTitle>
                <div className="flex gap-1">
                  {(['daily', 'weekly', 'monthly'] as const).map(m => (
                    <button key={m} onClick={() => setBarMode(m)}
                      className="transition-all"
                      style={{
                        background: barMode === m ? 'rgba(0,210,210,0.12)' : 'transparent',
                        color: barMode === m ? ACCENT : MUTED,
                        border: barMode === m ? `1px solid rgba(0,210,210,0.3)` : '1px solid transparent',
                        borderRadius: 6,
                        padding: '3px 10px',
                        fontSize: 11,
                        fontWeight: 600,
                      }}>
                      {m === 'daily' ? 'יומי' : m === 'weekly' ? 'שבועי' : 'חודשי'}
                    </button>
                  ))}
                </div>
              </div>
              <BarChart data={barData} />
            </Card>

            {/* Line chart */}
            <Card>
              <div className="flex items-center justify-between mb-3">
                <SectionTitle>P&L עקומה</SectionTitle>
                <div className="flex gap-1">
                  {(['cumulative', 'daily'] as const).map(m => (
                    <button key={m} onClick={() => setLineMode(m)}
                      className="transition-all"
                      style={{
                        background: lineMode === m ? 'rgba(0,210,210,0.12)' : 'transparent',
                        color: lineMode === m ? ACCENT : MUTED,
                        border: lineMode === m ? `1px solid rgba(0,210,210,0.3)` : '1px solid transparent',
                        borderRadius: 6,
                        padding: '3px 10px',
                        fontSize: 11,
                        fontWeight: 600,
                      }}>
                      {m === 'cumulative' ? 'מצטבר' : 'יומי'}
                    </button>
                  ))}
                </div>
              </div>
              <LineChart data={lineData} />
              {lineData.length > 0 && (
                <p className="text-xs font-bold mt-2"
                  style={{ color: lineData[lineData.length - 1].value >= 0 ? GREEN : RED }}>
                  {formatPnlIls(lineData[lineData.length - 1].value)}
                </p>
              )}
            </Card>
          </div>

          {/* ── Bottom: Calendar + Recent trades ─────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

            {/* Calendar */}
            <Card>
              <SectionTitle>לוח שנה חודשי</SectionTitle>
              {effectiveCalDate ? (
                <MonthCalendar dayMap={stats.dayMap} calDate={effectiveCalDate}
                  onPrev={prevMonth} onNext={nextMonth} />
              ) : (
                <div style={{ minHeight: 260 }} />
              )}
            </Card>

            {/* Recent trades */}
            <Card>
              <SectionTitle>עסקאות אחרונות</SectionTitle>
              <div className="flex flex-col gap-0">
                {recent.length === 0 ? (
                  <p className="text-sm text-center py-6" style={{ color: MUTED, fontWeight: 600 }}>אין עסקאות</p>
                ) : recent.map((t, i) => {
                  const pnl  = calcPnl(t);
                  const dir  = tradeDir(t);
                  return (
                    <div key={t.id} className="flex items-center gap-2 py-3 cursor-pointer"
                      style={{ borderTop: i > 0 ? `1px solid ${BORDER}` : undefined }}
                      onClick={() => setSelTrade(t)}>
                      {/* Date + asset */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-sm font-semibold truncate" style={{ color: TEXT }}>
                            {t.symbol ?? t.strategy}
                          </span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold"
                            style={{
                              background: dir === 'long' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                              color: dir === 'long' ? GREEN : RED,
                            }}>
                            {dir === 'long' ? '↑ לונג' : '↓ שורט'}
                          </span>
                        </div>
                        <p className="text-[10px] mt-0.5" style={{ color: MUTED, fontWeight: 600 }}>
                          {fmtDateTime(t.submitted_at)} · כניסה {t.entry_price.toFixed(2)}
                          {t.exit_price != null ? ` · יציאה ${t.exit_price.toFixed(2)}` : ''}
                        </p>
                      </div>
                      {/* P&L (+ button on desktop only) */}
                      <div className="flex items-center gap-2 shrink-0">
                        {pnl !== null ? (
                          <p className="text-[11px] sm:text-sm font-bold" style={{ color: pnl >= 0 ? GREEN : RED }}>
                            {t.pnl_amount != null ? (
                              <>
                                {formatPnlIls(t.pnl_amount, t.pnl_currency ?? '₪')}
                                <span className="text-[8px] sm:text-xs font-semibold" style={{ opacity: 0.6 }}> ({formatPnlPoints(pnl)})</span>
                              </>
                            ) : fmtPnl(pnl)}
                          </p>
                        ) : (
                          <p className="text-xs font-semibold" style={{ color: ACCENT }}>פתוח</p>
                        )}
                        <button onClick={e => { e.stopPropagation(); setSelTrade(t); }}
                          className="hidden md:flex text-[10px] px-2 rounded-lg font-medium transition-opacity hover:opacity-80 min-h-[44px] items-center"
                          style={{ background: SURF2, color: TEXT2, fontWeight: 600, whiteSpace: 'nowrap' }}>
                          פרטים
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        </>
      )}

      {/* ── Weekly summary ───────────────────────────────────────────────── */}
      {!limits.weeklySummary ? (
        <Card>
          <div className="flex flex-col items-center text-center gap-3 py-4">
            <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: 'rgba(0,210,210,0.12)' }}>
              <Lock size={22} style={{ color: ACCENT }} />
            </div>
            <p style={{ fontSize: 13, fontWeight: 700, color: TEXT }}>סיכום שבועי AI זמין ב-Pro בלבד</p>
            <p style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>שדרג ל-Pro כדי לקבל ניתוח AI שבועי מלא עם תובנות והשוואה לשבועות קודמים</p>
            <button onClick={() => setWeeklyUpgradeOpen(true)}
              className="transition-all active:scale-95"
              style={{
                background: 'rgba(0,210,210,0.12)',
                color: ACCENT,
                border: `1px solid rgba(0,210,210,0.3)`,
                borderRadius: 6,
                padding: '6px 16px',
                fontSize: 12,
                fontWeight: 600,
              }}>
              שדרוג ל-Pro
            </button>
          </div>
        </Card>
      ) : (
      <Card>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2 -mx-5 -mt-5 px-5 py-3 rounded-t-xl"
          style={{ background: `linear-gradient(135deg, rgba(0,210,210,0.16) 0%, rgba(0,210,210,0.03) 100%)`, borderBottom: `1px solid ${BORDER}` }}>
          <div>
            <p style={{ fontSize: 13, fontWeight: 700, color: TEXT }}>
              סיכום שבועי
              {isCurrentWeek && <span style={{ color: MUTED, fontWeight: 600 }}> | השבוע הנוכחי</span>}
            </p>
            {viewedWeekStart && viewedWeekEnd && (
              <p style={{ fontSize: 11, color: MUTED, fontWeight: 600, marginTop: 2 }}>
                {fmtDate(viewedWeekStart)} - {fmtDate(viewedWeekEnd)}
              </p>
            )}
          </div>
          <button onClick={refreshWeeklySummary} disabled={weeklyLoading}
            className="flex items-center gap-1.5 transition-all active:scale-95 disabled:opacity-50">
            <RefreshCw size={12} className={weeklyLoading ? 'animate-spin' : ''} />
            <span style={{
              background: 'rgba(0,210,210,0.12)',
              color: ACCENT,
              border: `1px solid rgba(0,210,210,0.3)`,
              borderRadius: 6,
              padding: '3px 10px',
              fontSize: 11,
              fontWeight: 600,
            }}>
              רענן סיכום
            </span>
          </button>
        </div>

        {weeklyError && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg"
            style={{ background: 'rgba(239,68,68,0.1)', border: `1px solid rgba(239,68,68,0.3)` }}>
            <AlertCircle size={14} style={{ color: RED, flexShrink: 0 }} />
            <p style={{ fontSize: 12, color: TEXT2, fontWeight: 600 }}>{weeklyError}</p>
          </div>
        )}

        <div className="flex items-center justify-between mb-3">
          <button onClick={goToPrevWeek} disabled={weeklyLoading}
            className="p-3 rounded-lg transition-opacity disabled:opacity-40"
            style={{ background: SURF2, color: TEXT2 }}>
            <ChevronRight size={16} />
          </button>
          {weeklySummary && !isCurrentWeek ? (
            <p style={{ fontSize: 11, color: MUTED, fontWeight: 600 }}>
              נוצר ב-{fmtDate(weeklySummary.created_at)}
            </p>
          ) : <span />}
          <button onClick={goToNextWeek} disabled={weeklyLoading || viewedWeekStart === latestWeekStart}
            className="p-3 rounded-lg transition-opacity disabled:opacity-40"
            style={{ background: SURF2, color: TEXT2 }}>
            <ChevronLeft size={16} />
          </button>
        </div>

        {weeklySummary ? (
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            {/* LEFT — daily breakdown (40%) */}
            <div className="md:col-span-2 flex flex-col gap-2">
              <SectionTitle large>ביצועים יומיים</SectionTitle>
              {weeklyDaysReversed.map((d, i) => (
                <WeeklyDayCard
                  key={d.date}
                  label={weeklyLabelsReversed[i]}
                  pnl={d.pnl}
                  trades={d.trades ?? 0}
                  currency={weeklySummary.stats.pnl_currency}
                  maxAbs={weeklyDayMaxAbs}
                />
              ))}
            </div>

            {/* RIGHT — AI analysis (60%) */}
            <div className="md:col-span-3 flex flex-col gap-2">
              <SectionTitle large>ניתוח AI שבועי</SectionTitle>

              <div className="grid grid-cols-3 gap-2 mb-1">
                <StatPill
                  label="אחוז הצלחה"
                  value={weeklySummary.stats.win_rate != null ? `${weeklySummary.stats.win_rate}%` : '—'}
                  color={weeklySummary.stats.win_rate != null ? (weeklySummary.stats.win_rate >= 50 ? GREEN : RED) : undefined}
                  delta={previousStats?.win_rate != null && weeklySummary.stats.win_rate != null && (
                    <WeekDelta diff={weeklySummary.stats.win_rate - previousStats.win_rate}
                      format={d => `${d > 0 ? '+' : ''}${d}%`} />
                  )}
                />
                <StatPill
                  label="ציון תהליך"
                  value={weeklySummary.stats.avg_process_score ?? '—'}
                  color={processScoreColor(weeklySummary.stats.avg_process_score)}
                  delta={previousStats?.avg_process_score != null && weeklySummary.stats.avg_process_score != null && (
                    <WeekDelta diff={weeklySummary.stats.avg_process_score - previousStats.avg_process_score}
                      format={d => `${d > 0 ? '+' : ''}${d}`} />
                  )}
                />
                <StatPill label="עסקאות" value={weeklySummary.stats.total_trades} />
              </div>

              {weeklySummary.summary_text ? (
                <>
                  {summarySegments.map((seg, i) => (
                    <SummarySectionCard key={i} heading={seg.heading} lines={seg.lines} />
                  ))}
                  <SummaryQuote segments={summarySegments} />
                </>
              ) : (
                <div className="text-center flex-1 flex flex-col items-center justify-center gap-3" style={{ minHeight: 120 }}>
                  <p style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>
                    {weeklyLoading ? 'טוען סיכום שבועי...' : 'אין סיכום שבועי עדיין'}
                  </p>
                  <button onClick={refreshWeeklySummary} disabled={weeklyLoading}
                    className="transition-all active:scale-95 disabled:opacity-50"
                    style={{
                      background: 'rgba(0,210,210,0.12)',
                      color: ACCENT,
                      border: `1px solid rgba(0,210,210,0.3)`,
                      borderRadius: 6,
                      padding: '6px 16px',
                      fontSize: 12,
                      fontWeight: 600,
                    }}>
                    צור סיכום
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-center py-6 flex flex-col items-center gap-3">
            <p style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>
              {weeklyLoading ? 'טוען סיכום שבועי...' : 'אין סיכום שבועי עדיין'}
            </p>
            <button onClick={refreshWeeklySummary} disabled={weeklyLoading}
              className="transition-all active:scale-95 disabled:opacity-50"
              style={{
                background: 'rgba(0,210,210,0.12)',
                color: ACCENT,
                border: `1px solid rgba(0,210,210,0.3)`,
                borderRadius: 6,
                padding: '6px 16px',
                fontSize: 12,
                fontWeight: 600,
              }}>
              צור סיכום
            </button>
          </div>
        )}
      </Card>
      )}

      <UpgradeModal
        open={weeklyUpgradeOpen}
        onClose={() => setWeeklyUpgradeOpen(false)}
        limitType="weekly_summary"
      />

      {/* ── Coming soon banner ───────────────────────────────────────────── */}
      <div className="flex items-center justify-center gap-2 text-sm py-4"
        style={{ borderTop: `1px solid ${BORDER}`, color: TEXT2 }}>
        <Clock size={14} />
        <span>בקרוב - חיבור ברוקר בזמן אמת</span>
      </div>

      {/* ── Trade detail panel ────────────────────────────────────────────── */}
      {selTrade && (
        <TradeDetailPanel
          trade={selTrade}
          onClose={() => setSelTrade(null)}
          aiReview={tradeAi[selTrade.id] ?? null}
          aiLoading={tradeAiL[selTrade.id] ?? false}
          onAiReview={() => fetchTradeAi(selTrade)}
        />
      )}
    </div>
  );
}

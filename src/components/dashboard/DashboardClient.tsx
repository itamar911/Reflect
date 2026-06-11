'use client';

import { useState, useMemo, useEffect, useCallback, useSyncExternalStore } from 'react';
import { Sparkles, TrendingUp, TrendingDown, RefreshCw, CheckCircle, AlertCircle, Heart, ArrowRight, ChevronRight, ChevronLeft, Quote } from 'lucide-react';
import { formatPnlIls, formatPnlPoints } from '@/lib/utils';
import { createClient } from '@/lib/supabase/client';
import { DASH_TRADE_SELECT, mapDashTrade } from '@/lib/dashboard/trades';
import type { DashTrade } from '@/lib/dashboard/trades';

export type { DashTrade } from '@/lib/dashboard/trades';

// ── Tokens ────────────────────────────────────────────────────────────────────
const ACCENT  = '#00d2d2';
const SURF    = '#141420';
const SURF2   = '#1c1c2c';
const BORDER  = '#32324a';
const TEXT    = '#f1f5f9';
const TEXT2   = '#ffffff';
const MUTED   = '#ffffff';
const GREEN   = '#22c55e';
const RED     = '#ef4444';
const YELLOW  = '#eab308';

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
  // Monetary (₪/$) aggregates — driven by pnl_amount, missing values count as 0
  const grossProfit   = winTrades.reduce((s, t) => s + (t.pnl_amount ?? 0), 0);
  const grossLoss     = lossTrades.reduce((s, t) => s + (t.pnl_amount ?? 0), 0);
  const totalPnl      = closed.reduce((s, t) => s + (t.pnl_amount ?? 0), 0);
  const avgWin        = winCount  > 0 ? grossProfit / winCount  : 0;
  const avgLoss       = lossCount > 0 ? grossLoss   / lossCount : 0;
  const totalPnlPoints = pnls.reduce((s, p) => s + p, 0);

  const closedWithAmount = closed.filter(t => t.pnl_amount != null);
  const hasPnlAmount     = closedWithAmount.length > 0;
  const pnlCurrencies    = Array.from(new Set(closedWithAmount.map(t => t.pnl_currency ?? '₪')));
  const pnlCurrency      = pnlCurrencies.length === 1 ? pnlCurrencies[0] : '₪';

  // Period P&L = current calendar month
  const periodPnl = closed.reduce((s, t) => {
    const d = new Date(t.closed_at ?? t.submitted_at);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      ? s + (t.pnl_amount ?? 0) : s;
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
  const dailyPnl    = todayTrades.reduce((s, t) => s + (t.pnl_amount ?? 0), 0);
  const dailyCount  = todayTrades.length;
  const weeklyPnl   = weekTrades.reduce((s, t) => s + (t.pnl_amount ?? 0), 0);
  const weeklyCount = weekTrades.length;
  const monthlyPnl  = monthTrades.reduce((s, t) => s + (t.pnl_amount ?? 0), 0);
  const monthlyCount = monthTrades.length;
  const totalCount  = closed.length;

  const dayMap: Record<string, number> = {};
  for (const t of closed) {
    const k = dayKey(t.closed_at ?? t.submitted_at);
    dayMap[k] = (dayMap[k] ?? 0) + (t.pnl_amount ?? 0);
  }

  let profitDays = 0, lossDays = 0, neutralDays = 0;
  for (const v of Object.values(dayMap)) {
    if (v > 0) profitDays++; else if (v < 0) lossDays++; else neutralDays++;
  }

  // Drawdown
  let cum = 0, peak = 0, maxDD = 0;
  for (const k of Object.keys(dayMap).sort()) {
    cum += dayMap[k]; if (cum > peak) peak = cum;
    const dd = peak - cum; if (dd > maxDD) maxDD = dd;
  }

  const totalDays = profitDays + lossDays + neutralDays;
  const winRate   = (winCount + lossCount) > 0 ? winCount / (winCount + lossCount) * 100 : 0;
  const pf        = Math.abs(grossLoss) > 0.001 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? 3 : 0;
  const consist   = totalDays > 0 ? profitDays / totalDays * 100 : 0;
  const wlRatio   = Math.abs(avgLoss) > 0.001 ? avgWin / Math.abs(avgLoss) : avgWin > 0 ? 2 : 0;
  const ddCtrl    = peak > 0.001 ? Math.max(100 - maxDD / peak * 100, 0) : 50;
  const recovery  = maxDD > 0.001 ? Math.min(Math.max(totalPnl, 0) / maxDD / 2 * 100, 100) : totalPnl > 0 ? 75 : 50;

  const radarScores = [
    Math.round(Math.min(winRate, 100)),
    Math.round(Math.min(pf / 3 * 100, 100)),
    Math.round(Math.min(consist, 100)),
    Math.round(Math.min(wlRatio / 2 * 100, 100)),
    Math.round(Math.max(ddCtrl, 0)),
    Math.round(Math.max(recovery, 0)),
  ];

  const profitDayPct = totalDays > 0 ? Math.round(profitDays / totalDays * 100) : 0;
  const winPct       = (winCount + lossCount) > 0 ? Math.round(winCount / (winCount + lossCount) * 100) : 0;

  return {
    profitDays, lossDays, neutralDays, profitDayPct,
    winTrades: winCount, lossTrades: lossCount, neutralTrades, winPct,
    avgWin, avgLoss, grossProfit, grossLoss, totalPnl, totalPnlPoints,
    hasPnlAmount, pnlCurrency, periodPnl,
    dailyPnl, dailyCount, weeklyPnl, weeklyCount, monthlyPnl, monthlyCount, totalCount,
    radarScores,
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

// ── Radar chart ───────────────────────────────────────────────────────────────
const R_LABELS = ['אחוז הצלחה', 'פקטור רווח', 'עקביות', 'ממוצע רווח/הפסד', 'ירידת ערך', 'התאוששות'];
const R_DESCS  = [
  'אחוז הצלחה מבין עסקאות סגורות',
  'רווח גולמי חלקי הפסד גולמי',
  'אחוז ימים רווחיים מכלל ימי מסחר',
  'ממוצע רווח חלקי ממוצע הפסד',
  'שליטה בירידה מקסימלית מהשיא',
  'רווח כולל חלקי מקסימום ירידה',
];

function RadarChart({ scores }: { scores: number[] }) {
  const [hov, setHov] = useState<number | null>(null);
  const N = 6; const cx = 120; const cy = 120; const R = 80;
  const ang = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / N;
  const pt  = (i: number, s: number): [number, number] =>
    [cx + R * s * Math.cos(ang(i)), cy + R * s * Math.sin(ang(i))];
  const poly = (s: number) => Array.from({ length: N }, (_, i) => pt(i, s).join(',')).join(' ');
  const dataPoly = scores.map((v, i) => pt(i, Math.min(v, 100) / 100).join(',')).join(' ');
  const avgScore = Math.round(scores.reduce((s, v) => s + v, 0) / N);

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={240} height={240}>
        {[0.25, 0.5, 0.75, 1].map(s => (
          <polygon key={s} points={poly(s)} fill="none" stroke={BORDER} strokeWidth={0.8} />
        ))}
        {Array.from({ length: N }, (_, i) => {
          const [x, y] = pt(i, 1);
          return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={BORDER} strokeWidth={0.8} />;
        })}
        <polygon points={dataPoly} fill="rgba(0,210,210,0.15)" stroke={ACCENT} strokeWidth={1.5} />
        {scores.map((v, i) => {
          const [x, y] = pt(i, Math.min(v, 100) / 100);
          return (
            <circle key={i} cx={x} cy={y} r={4} fill={ACCENT} style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}
              onClick={() => setHov(hov === i ? null : i)} />
          );
        })}
        {Array.from({ length: N }, (_, i) => {
          const [x, y] = pt(i, 1.28);
          return (
            <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
              fontSize={14} fontWeight={600} fill={hov === i ? ACCENT : MUTED}>{R_LABELS[i]}</text>
          );
        })}
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize={56} fontWeight="bold" fill={ACCENT}>
          {avgScore}
        </text>
        <text x={cx} y={cy + 34} textAnchor="middle" fontSize={13} fontWeight={600} fill={MUTED}>ציון כולל</text>
      </svg>
      {hov !== null && (
        <div className="text-center text-xs px-3 py-1.5 rounded-xl mx-4"
          style={{ background: SURF2, color: TEXT2, fontWeight: 600 }}>
          <span style={{ color: ACCENT, fontWeight: 600 }}>{R_LABELS[hov]}</span>
          {' '}— {scores[hov]}% — {R_DESCS[hov]}
        </div>
      )}
    </div>
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
        <button onClick={onPrev} className="p-1.5 rounded-lg" style={{ background: SURF2, color: TEXT2 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <p className="text-sm font-semibold" style={{ color: TEXT }}>{MONTHS_HE[mo]} {yr}</p>
        <button onClick={onNext} className="p-1.5 rounded-lg" style={{ background: SURF2, color: TEXT2 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
      </div>

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
          <div key={wi} className="grid gap-0.5" style={{ gridTemplateColumns: 'repeat(8, 1fr)' }}>
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
      <div style={{ width: 3, height: 14, background: ACCENT, borderRadius: 99, flexShrink: 0 }} />
      <p style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: MUTED }}>
        {children}
      </p>
    </div>
  );
}

// ── Weekly summary types ──────────────────────────────────────────────────────
interface WeeklyDailyPnl {
  date: string;
  pnl: number;
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
  { match: 'דפוסים', icon: AlertCircle, color: RED },
  { match: 'מצב רגשי', icon: Heart, color: YELLOW },
  { match: 'המלצה', icon: ArrowRight, color: ACCENT },
  { match: 'מה שאמרת', icon: Quote, color: ACCENT },
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
      return <CheckCircle key={`${keyPrefix}-${i}`} size={14} style={{ color: GREEN, display: 'inline-block', verticalAlign: 'middle', margin: '0 2px' }} />;
    }
    if (CROSS_RE.test(part)) {
      return <AlertCircle key={`${keyPrefix}-${i}`} size={14} style={{ color: RED, display: 'inline-block', verticalAlign: 'middle', margin: '0 2px' }} />;
    }
    if (EMOJI_RE.test(part)) return null;
    return part;
  }).filter(part => part !== null && part !== '');
}

// Minimal markdown renderer for the AI weekly summary: headings, bold, hr, lists, paragraphs.
function renderSummaryMarkdown(text: string): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listType: 'ol' | 'ul' | 'check' | 'cross' | null = null;

  const flushParagraph = () => {
    const content = paragraph.join(' ').trim();
    if (content) {
      blocks.push(
        <p key={`p-${blocks.length}`} style={{ fontSize: 13, lineHeight: 1.7, color: TEXT2, fontWeight: 500, marginBottom: 10 }}>
          {renderInline(content, `p-${blocks.length}`)}
        </p>
      );
    }
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) { listType = null; return; }
    const items = listItems;
    if (listType === 'ol') {
      blocks.push(
        <ol key={`l-${blocks.length}`} style={{ margin: '8px 0 14px', paddingInlineStart: 22, display: 'flex', flexDirection: 'column', gap: 6, listStyleType: 'decimal' }}>
          {items.map((item, i) => (
            <li key={i} style={{ fontSize: 13, lineHeight: 1.7, color: TEXT2, fontWeight: 500 }}>
              {renderInline(item, `li-${blocks.length}-${i}`)}
            </li>
          ))}
        </ol>
      );
    } else if (listType === 'check' || listType === 'cross') {
      const Icon = listType === 'check' ? CheckCircle : AlertCircle;
      const color = listType === 'check' ? GREEN : RED;
      blocks.push(
        <ul key={`l-${blocks.length}`} style={{ margin: '8px 0 14px', paddingInlineStart: 0, display: 'flex', flexDirection: 'column', gap: 6, listStyleType: 'none' }}>
          {items.map((item, i) => (
            <li key={i} style={{ fontSize: 13, lineHeight: 1.7, color: TEXT2, fontWeight: 500, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <Icon size={15} style={{ color, flexShrink: 0, marginTop: 2 }} />
              <span>{renderInline(item, `li-${blocks.length}-${i}`)}</span>
            </li>
          ))}
        </ul>
      );
    } else {
      blocks.push(
        <ul key={`l-${blocks.length}`} style={{ margin: '8px 0 14px', paddingInlineStart: 22, display: 'flex', flexDirection: 'column', gap: 6, listStyleType: 'disc' }}>
          {items.map((item, i) => (
            <li key={i} style={{ fontSize: 13, lineHeight: 1.7, color: TEXT2, fontWeight: 500 }}>
              {renderInline(item, `li-${blocks.length}-${i}`)}
            </li>
          ))}
        </ul>
      );
    }
    listItems = [];
    listType = null;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph(); flushList();
      blocks.push(<hr key={`hr-${blocks.length}`} style={{ border: 'none', borderTop: `1px solid ${BORDER}`, margin: '16px 0' }} />);
      continue;
    }

    const headingMatch = line.match(/^#{1,6}\s+(.*)/);
    if (headingMatch) {
      flushParagraph(); flushList();
      const headingText = headingMatch[1].trim();
      const section = SECTION_ICONS.find(s => headingText.includes(s.match));
      const Icon = section?.icon;
      blocks.push(
        <h3 key={`h-${blocks.length}`} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          borderLeft: `3px solid ${ACCENT}`, paddingLeft: 10,
          marginTop: blocks.length === 0 ? 0 : 18, marginBottom: 8,
          fontSize: 14, fontWeight: 700, color: TEXT,
        }}>
          {Icon && <Icon size={16} style={{ color: section!.color, flexShrink: 0 }} />}
          <span>{renderInline(headingText, `h-${blocks.length}`)}</span>
        </h3>
      );
      continue;
    }

    const checkMatch = line.match(new RegExp(`^[${CHECK_CHARS}]\\s*(.*)`, 'u'));
    if (checkMatch) {
      flushParagraph();
      if (listType !== 'check') { flushList(); listType = 'check'; }
      listItems.push(checkMatch[1].trim());
      continue;
    }

    const crossMatch = line.match(new RegExp(`^[${CROSS_CHARS}]\\s*(.*)`, 'u'));
    if (crossMatch) {
      flushParagraph();
      if (listType !== 'cross') { flushList(); listType = 'cross'; }
      listItems.push(crossMatch[1].trim());
      continue;
    }

    const olMatch = line.match(/^\d+[.)]\s+(.*)/);
    if (olMatch) {
      flushParagraph();
      if (listType !== 'ol') { flushList(); listType = 'ol'; }
      listItems.push(olMatch[1].trim());
      continue;
    }

    const ulMatch = line.match(/^[-*•]\s+(.*)/);
    if (ulMatch) {
      flushParagraph();
      if (listType !== 'ul') { flushList(); listType = 'ul'; }
      listItems.push(ulMatch[1].trim());
      continue;
    }

    if (line === '') {
      flushParagraph(); flushList();
      continue;
    }

    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
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

// ── Main component ────────────────────────────────────────────────────────────
export default function DashboardClient({
  trades: initialTrades,
  displayName,
  userId,
}: {
  trades: DashTrade[];
  displayName: string;
  userId: string;
}) {
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
  const [viewedWeekStart, setViewedWeekStart] = useState<string | null>(null);
  const [viewedWeekEnd, setViewedWeekEnd] = useState<string | null>(null);
  const [isCurrentWeek, setIsCurrentWeek] = useState(false);
  const [previousStats, setPreviousStats] = useState<WeeklyStats | null>(null);

  // "Now" is null during SSR and the first client render (matching), then
  // becomes a real Date once mounted — avoids hydration mismatches from
  // anything date-dependent (greeting, calendar, date-based series).
  const mounted = useMounted();
  const now = useMemo(() => mounted ? new Date() : null, [mounted]);

  const stats = useMemo(() => computeAll(trades, now ?? EPOCH), [trades, now]);
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
    let cancelled = false;
    (async () => {
      const data = await loadWeek();
      if (cancelled || !data || data.summary || new Date().getDay() !== 0) return;
      setWeeklyLoading(true);
      try {
        const genRes = await fetch('/api/weekly-summary', { method: 'POST' });
        const genData = await genRes.json().catch(() => null);
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
  }, [loadWeek]);

  async function refreshWeeklySummary() {
    setWeeklyLoading(true);
    setWeeklyError(null);
    try {
      const res = await fetch('/api/weekly-summary', { method: 'POST' });
      const data = await res.json().catch(() => null);
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
    if (!viewedWeekStart || isCurrentWeek) return;
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
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {/* Text column — first in RTL flex → physical RIGHT */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#ffffff' }}>ימים רווחיים</p>
                  <p style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: stats.profitDays >= stats.lossDays ? GREEN : RED }}>
                    {stats.profitDayPct}%
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 14, fontWeight: 800, color: GREEN, fontVariantNumeric: 'tabular-nums' }}>{stats.profitDays}</span>
                    <span style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>|</span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#ffffff', fontVariantNumeric: 'tabular-nums' }}>{stats.neutralDays}</span>
                    <span style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>|</span>
                    <span style={{ fontSize: 14, fontWeight: 800, color: RED, fontVariantNumeric: 'tabular-nums' }}>{stats.lossDays}</span>
                  </div>
                </div>
                {/* Gauge — second in RTL flex → physical LEFT */}
                <div style={{ flexShrink: 0 }}>
                  <SemiGauge width={140} strokeWidth={12} segments={[
                    { value: stats.profitDays, color: GREEN },
                    { value: stats.lossDays,   color: RED },
                  ]} />
                </div>
              </div>
            </Card>

            {/* Card 2: Win Rate */}
            <Card>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {/* Text column — first in RTL flex → physical RIGHT */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#ffffff' }}>אחוזי הצלחה</p>
                  <p style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: stats.winPct >= 50 ? GREEN : RED }}>
                    {stats.winPct}%
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 14, fontWeight: 800, color: GREEN, fontVariantNumeric: 'tabular-nums' }}>{stats.winTrades}</span>
                    <span style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>|</span>
                    <span style={{ fontSize: 14, fontWeight: 800, color: RED, fontVariantNumeric: 'tabular-nums' }}>{stats.lossTrades}</span>
                  </div>
                </div>
                {/* Gauge — second in RTL flex → physical LEFT */}
                <div style={{ flexShrink: 0 }}>
                  <SemiGauge width={140} strokeWidth={12} segments={[
                    { value: stats.winPct,       color: GREEN },
                    { value: 100 - stats.winPct, color: RED },
                  ]} />
                </div>
              </div>
            </Card>

            {/* Card 3: Avg Win/Loss ratio */}
            <Card>
              <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#ffffff', marginBottom: 14 }}>יחס רווח/הפסד ממוצע</p>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                <span style={{ fontSize: 18, fontWeight: 700, color: '#ffffff', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                  {stats.avgLoss < -0.001 ? (stats.avgWin / Math.abs(stats.avgLoss)).toFixed(2) : '—'}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                  <SplitBar left={stats.avgWin} right={Math.abs(stats.avgLoss)} leftColor={GREEN} rightColor={RED} />
                  <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: GREEN, fontVariantNumeric: 'tabular-nums' }}>{formatPnlIls(stats.avgWin, stats.pnlCurrency)}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: RED, fontVariantNumeric: 'tabular-nums' }}>{formatPnlIls(stats.avgLoss, stats.pnlCurrency)}</span>
                  </div>
                </div>
              </div>
            </Card>

            {/* Card 4: P&L Balance */}
            <Card>
              <p style={{ fontSize: 13, fontWeight: 700, color: '#ffffff', marginBottom: 8 }}>מאזן P&L</p>
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
                <span style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', color: selPeriodPnl >= 0 ? GREEN : RED }}>
                  {selPeriodDisplay}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#ffffff' }}>
                  ({selPeriodCount} עסקאות)
                </span>
              </div>
            </Card>
          </div>

          {/* ── Middle: Radar + Bar + Line ────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

            {/* Radar */}
            <Card>
              <SectionTitle>ניקוד משמעת</SectionTitle>
              <RadarChart scores={stats.radarScores} />
              <div className="grid grid-cols-3 gap-1 mt-2">
                {R_LABELS.map((l, i) => (
                  <div key={l} className="text-center rounded-lg py-1.5"
                    style={{ background: SURF2, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '6px 4px' }}>
                    <p style={{ fontSize: 11, color: MUTED, fontWeight: 600 }}>{l}</p>
                    <p style={{ fontSize: 15, fontWeight: 700, color: stats.radarScores[i] >= 60 ? GREEN : stats.radarScores[i] >= 35 ? ACCENT : RED }}>
                      {stats.radarScores[i]}
                    </p>
                  </div>
                ))}
              </div>
            </Card>

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
                    <div key={t.id} className="flex items-center gap-2 py-3"
                      style={{ borderTop: i > 0 ? `1px solid ${BORDER}` : undefined }}>
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
                      {/* P&L + button */}
                      <div className="flex items-center gap-2 shrink-0">
                        {pnl !== null ? (
                          <p className="text-sm font-bold" style={{ color: pnl >= 0 ? GREEN : RED }}>
                            {t.pnl_amount != null ? (
                              <>
                                {formatPnlIls(t.pnl_amount, t.pnl_currency ?? '₪')}
                                <span className="text-xs font-semibold" style={{ opacity: 0.6 }}> ({formatPnlPoints(pnl)})</span>
                              </>
                            ) : fmtPnl(pnl)}
                          </p>
                        ) : (
                          <p className="text-xs font-semibold" style={{ color: ACCENT }}>פתוח</p>
                        )}
                        <button onClick={() => setSelTrade(t)}
                          className="text-[10px] px-2 py-1 rounded-lg font-medium transition-opacity hover:opacity-80"
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
      <Card style={{ background: `linear-gradient(135deg, ${SURF} 0%, rgba(0,210,210,0.06) 100%)` }}>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <SectionTitle>סיכום שבועי</SectionTitle>
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
            className="p-1.5 rounded-lg transition-opacity disabled:opacity-40"
            style={{ background: SURF2, color: TEXT2 }}>
            <ChevronRight size={16} />
          </button>
          <div className="text-center">
            <p style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>
              {isCurrentWeek
                ? 'השבוע הנוכחי'
                : viewedWeekStart && viewedWeekEnd
                  ? `סיכום שבוע ${fmtDate(viewedWeekStart)} - ${fmtDate(viewedWeekEnd)}`
                  : 'סיכום שבועי'}
            </p>
            {weeklySummary && !isCurrentWeek && (
              <p style={{ fontSize: 11, color: MUTED, fontWeight: 600, marginTop: 2 }}>
                נוצר ב-{fmtDate(weeklySummary.created_at)}
              </p>
            )}
          </div>
          <button onClick={goToNextWeek} disabled={weeklyLoading || isCurrentWeek}
            className="p-1.5 rounded-lg transition-opacity disabled:opacity-40"
            style={{ background: SURF2, color: TEXT2 }}>
            <ChevronLeft size={16} />
          </button>
        </div>

        {weeklySummary ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
              <div className="text-center py-2" style={{ background: SURF2, border: `1px solid ${BORDER}`, borderRadius: 8 }}>
                <p style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>עסקאות</p>
                <p style={{ fontSize: 16, fontWeight: 700, color: TEXT }}>{weeklySummary.stats.total_trades}</p>
              </div>
              <div className="text-center py-2" style={{ background: SURF2, border: `1px solid ${BORDER}`, borderRadius: 8 }}>
                <p style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>ציון ממוצע</p>
                <p style={{ fontSize: 16, fontWeight: 700, color: TEXT }}>
                  {weeklySummary.stats.avg_process_score ?? '—'}
                </p>
                {previousStats?.avg_process_score != null && weeklySummary.stats.avg_process_score != null && (
                  <WeekDelta diff={weeklySummary.stats.avg_process_score - previousStats.avg_process_score}
                    format={d => `${d > 0 ? '+' : ''}${d}`} />
                )}
              </div>
              <div className="text-center py-2" style={{ background: SURF2, border: `1px solid ${BORDER}`, borderRadius: 8 }}>
                <p style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>P&L</p>
                <p style={{ fontSize: 16, fontWeight: 700, color: weeklySummary.stats.total_pnl >= 0 ? GREEN : RED }}>
                  {formatPnlIls(weeklySummary.stats.total_pnl, weeklySummary.stats.pnl_currency)}
                </p>
                {previousStats && (
                  <WeekDelta diff={weeklySummary.stats.total_pnl - previousStats.total_pnl}
                    format={d => formatPnlIls(d, weeklySummary.stats.pnl_currency)} />
                )}
              </div>
              <div className="text-center py-2" style={{ background: SURF2, border: `1px solid ${BORDER}`, borderRadius: 8 }}>
                <p style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>אחוז הצלחה</p>
                <p style={{ fontSize: 16, fontWeight: 700, color: TEXT }}>
                  {weeklySummary.stats.win_rate != null ? `${weeklySummary.stats.win_rate}%` : '—'}
                </p>
                {previousStats?.win_rate != null && weeklySummary.stats.win_rate != null && (
                  <WeekDelta diff={weeklySummary.stats.win_rate - previousStats.win_rate}
                    format={d => `${d > 0 ? '+' : ''}${d}%`} />
                )}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              {weeklySummary.stats.daily_pnl?.some(d => d.pnl !== 0) ? (
                <BarChart data={weeklySummary.stats.daily_pnl.map((d, i) => ({ label: DAYS_SH[i], value: d.pnl }))} />
              ) : (
                <p className="text-center" style={{ fontSize: 12, color: MUTED, fontWeight: 600, padding: '12px 0' }}>
                  אין נתוני מסחר השבוע
                </p>
              )}
            </div>

            {weeklySummary.summary_text && (
              <div>
                {renderSummaryMarkdown(weeklySummary.summary_text)}
              </div>
            )}
          </>
        ) : weeklyLoading ? (
          <p style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>טוען סיכום שבועי...</p>
        ) : (
          <div className="text-center py-6 flex flex-col items-center gap-3">
            <p style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>אין סיכום שבועי עדיין</p>
            <button onClick={refreshWeeklySummary}
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
              צור סיכום
            </button>
          </div>
        )}
      </Card>

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

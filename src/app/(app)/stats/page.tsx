import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PnlChart, { type PeriodPoint } from '@/components/stats/PnlChart';
import type { TradePlan } from '@/lib/types';
import type { ReactNode } from 'react';
import { Zap, TrendingUp, BarChart2, Target, Calendar, Clock, CandlestickChart, Trophy, Flame } from 'lucide-react';

export const metadata = { title: 'סטטיסטיקה — Reflect' };

// ── Design tokens ────────────────────────────────────────────────────────────
const SURF   = '#1a1a28';
const ACCENT = '#00d2d2';
const RED    = '#ef4444';
const MUTED  = '#6b7280';
const TEXT   = '#ffffff';
const TRACK  = 'var(--color-tg-surface-2)';

// ── Constants ─────────────────────────────────────────────────────────────────
const HE_DAYS   = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HE_DAYS_S = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function pnlOf(t: TradePlan): number | null {
  if (t.status !== 'closed' || t.exit_price == null) return null;
  return Number(t.exit_price) - Number(t.entry_price);
}

// ₪ P&L — stored on close when the trade has quantity + value-per-unit
function pnlIls(t: TradePlan): number {
  if (t.status !== 'closed' || t.exit_price == null) return 0;
  return t.pnl_amount != null ? Number(t.pnl_amount) : 0;
}

function fmt(v: number, currency: string = '₪'): string {
  if (v === 0) return `${currency}0`;
  return `${v > 0 ? '+' : '−'}${currency}${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
}

function pnlColor(v: number): string {
  return v < 0 ? RED : ACCENT;
}

// ── SVG bar chart (server) ────────────────────────────────────────────────────
interface Bar { label: string; value: number; count: number }

function BarChart({ bars, height = 72 }: { bars: Bar[]; height?: number }) {
  if (!bars.length || bars.every(b => b.count === 0)) return (
    <p className="text-center py-4" style={{ fontSize: 12, color: MUTED }}>אין נתונים</p>
  );

  const W = 300;
  const max = Math.max(...bars.map(b => Math.abs(b.value)), 0.001);
  const step = W / bars.length;
  const bw   = step * 0.62;
  const maxH = height - 16;

  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none"
      style={{ width: '100%', height, display: 'block' }}>
      {bars.map((b, i) => {
        const bh  = Math.max((Math.abs(b.value) / max) * maxH, b.count > 0 ? 3 : 0);
        const x   = i * step + (step - bw) / 2;
        const y   = height - 14 - bh;
        const col = b.value > 0 ? 'rgba(0,210,210,0.65)'
          : b.value < 0 ? 'rgba(239,68,68,0.65)'
          : 'rgba(107,114,128,0.28)';
        return (
          <g key={i}>
            <rect x={x.toFixed(1)} y={y.toFixed(1)} width={bw.toFixed(1)} height={bh.toFixed(1)}
              fill={col} rx="2" />
            <text x={(x + bw / 2).toFixed(1)} y={height - 2} textAnchor="middle"
              fontSize="7.5" fill="#ffffff">{b.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Section title ────────────────────────────────────────────────────────────
function Section({ title, icon, children }: {
  title: string; icon?: ReactNode; children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="flex items-center gap-2"
        style={{ fontSize: 13, fontWeight: 600, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {icon}
        {title}
      </h2>
      {children}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, positive, icon, fixedHeight }: {
  label: string; value: string; sub?: string; positive: boolean; icon?: ReactNode; fixedHeight?: boolean;
}) {
  return (
    <div className={`rounded-xl flex flex-col justify-center gap-1.5 ${fixedHeight ? 'h-28' : ''}`}
      style={{ background: SURF, borderLeft: `4px solid ${positive ? ACCENT : RED}`, padding: 20, borderRadius: 12 }}>
      <p className="flex items-center gap-1.5" style={{ fontSize: 12, color: MUTED }}>
        {icon}
        {label}
      </p>
      <p style={{ fontSize: 22, fontWeight: 700, color: TEXT, lineHeight: 1.2 }}>{value}</p>
      {sub && <p style={{ fontSize: 11, color: MUTED }}>{sub}</p>}
    </div>
  );
}

// ── Breakdown row (strategy / symbol) ────────────────────────────────────────
function BreakdownRow({ name, pnl, trades, winRate, rr, barPct }: {
  name: string; pnl: number; trades: number; winRate: number | null; rr?: number; barPct: number;
}) {
  return (
    <div className="rounded-xl flex items-center gap-4"
      style={{ background: SURF, borderLeft: `4px solid ${pnlColor(pnl)}`, padding: 20, borderRadius: 12 }}>
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>{name}</span>
          <span style={{ fontSize: 11, color: MUTED }}>{trades} עסקאות</span>
        </div>
        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: TRACK }}>
          <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: ACCENT }} />
        </div>
      </div>
      <div className="flex flex-col items-end shrink-0 gap-1">
        <span style={{ fontSize: 22, fontWeight: 700, color: TEXT }}>{fmt(pnl)}</span>
        <div className="flex gap-2" style={{ fontSize: 11, color: MUTED }}>
          {winRate !== null && <span>{winRate}%</span>}
          {rr !== undefined && <span>R:R {rr.toFixed(1)}</span>}
        </div>
      </div>
    </div>
  );
}

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
      <div dir="rtl" className="min-h-screen px-4 py-6 flex flex-col gap-8">
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
  const losses       = closed.filter(t => pnlOf(t)! <= 0);
  const winRate      = closedCount > 0 ? Math.round(wins.length / closedCount * 100) : 0;
  const avgRR        = trades.length > 0
    ? trades.reduce((s, t) => s + Number(t.rr_ratio), 0) / trades.length : 0;
  const avgWin       = wins.length > 0
    ? wins.reduce((s, t) => s + pnlIls(t), 0) / wins.length : 0;
  const avgLoss      = losses.length > 0
    ? losses.reduce((s, t) => s + pnlIls(t), 0) / losses.length : 0;
  const profitFactor = Math.abs(avgLoss) > 0
    ? Math.abs(wins.reduce((s, t) => s + pnlIls(t), 0) / losses.reduce((s, t) => s + pnlIls(t), 1)) : 0;

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
  const maxStratTrades = Math.max(...strategies.map(s => s.trades), 1);

  // ── Day of week ─────────────────────────────────────────────────────────────
  const dowBars: Bar[] = HE_DAYS_S.map((lbl, i) => {
    const dayT = closed.filter(t => new Date(t.submitted_at).getDay() === i);
    return { label: lbl, value: dayT.reduce((s, t) => s + pnlIls(t), 0), count: dayT.length };
  });
  const bestDow  = dowBars.reduce((b, d) => d.value > b.value ? d : b, dowBars[0]);
  const worstDow = dowBars.reduce((b, d) => d.value < b.value ? d : b, dowBars[0]);

  // ── Hour of day ─────────────────────────────────────────────────────────────
  const hourRaw = new Map<number, { pnl: number; count: number }>();
  for (const t of closed) {
    const h    = new Date(t.submitted_at).getHours();
    const prev = hourRaw.get(h) ?? { pnl: 0, count: 0 };
    hourRaw.set(h, { pnl: prev.pnl + pnlIls(t), count: prev.count + 1 });
  }
  const hourBars: Bar[] = [...hourRaw.entries()]
    .sort(([a], [b]) => a - b)
    .map(([h, v]) => ({ label: String(h).padStart(2, '0'), value: v.pnl, count: v.count }));
  const bestHour  = hourBars.length ? hourBars.reduce((b, d) => d.value > b.value ? d : b, hourBars[0]) : null;

  // ── Symbol breakdown ─────────────────────────────────────────────────────────
  const symbolMap = new Map<string, { trades: number; wins: number; closedN: number; pnl: number }>();
  for (const t of trades) {
    const sym = t.symbol?.trim().toUpperCase();
    if (!sym) continue;
    const prev = symbolMap.get(sym) ?? { trades: 0, wins: 0, closedN: 0, pnl: 0 };
    const p    = pnlOf(t);
    symbolMap.set(sym, {
      trades:  prev.trades + 1,
      closedN: prev.closedN + (p != null ? 1 : 0),
      wins:    prev.wins + (p != null && p > 0 ? 1 : 0),
      pnl:     prev.pnl + pnlIls(t),
    });
  }
  const symbols = [...symbolMap.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.trades - a.trades);
  const maxSymTrades = Math.max(...symbols.map(s => s.trades), 1);

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

  return (
    <div dir="rtl" className="min-h-screen px-4 py-6 flex flex-col gap-8">

      {/* ── Header ─────────────────────────────────────────────── */}
      <PageHeader />

      {/* ── KPI grid (3×3) ───────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard fixedHeight
          label="רווח/הפסד כולל"
          value={closedCount > 0 ? fmt(totalPnl) : '—'}
          sub={`${closedCount} עסקאות סגורות`}
          positive={closedCount === 0 || totalPnl >= 0}
        />
        <StatCard fixedHeight
          label="אחוז הצלחה"
          value={closedCount > 0 ? `${winRate}%` : '—'}
          sub={`${wins.length} מתוך ${closedCount}`}
          positive={closedCount === 0 || winRate >= 50}
        />
        <StatCard fixedHeight
          label="ממוצע R:R"
          value={trades.length > 0 ? `1:${avgRR.toFixed(1)}` : '—'}
          positive={true}
        />
        <StatCard fixedHeight
          label="פקטור רווח"
          value={profitFactor > 0 ? profitFactor.toFixed(2) : '—'}
          sub="רווח ÷ הפסד"
          positive={profitFactor === 0 || profitFactor >= 1}
        />
        <StatCard fixedHeight
          label="ממוצע רווח"
          value={fmt(avgWin)}
          positive={true}
        />
        <StatCard fixedHeight
          label="ממוצע הפסד"
          value={fmt(avgLoss)}
          positive={avgLoss === 0}
        />
        <StatCard fixedHeight
          label="רצף נוכחי"
          value={currentStreak ? `${currentStreak.count} ${currentStreak.type === 'win' ? 'רווחים' : 'הפסדים'}` : '—'}
          positive={!currentStreak || currentStreak.type === 'win'}
        />
      </div>

      {/* ── P&L Chart ───────────────────────────────────────── */}
      <Section title="רווח/הפסד לאורך זמן" icon={<TrendingUp size={14} />}>
        <div className="rounded-xl" style={{ background: SURF, borderLeft: `4px solid ${ACCENT}`, padding: 20, borderRadius: 12 }}>
          <PnlChart daily={daily} weekly={weekly} monthly={monthly} />
        </div>
      </Section>

      {/* ── Strategy breakdown ──────────────────────────────── */}
      {strategies.length > 0 && (
        <Section title="ביצועים לפי אסטרטגיה" icon={<Target size={14} />}>
          <div className="flex flex-col gap-4">
            {strategies.map(s => {
              const wr = s.closedN > 0 ? Math.round(s.wins / s.closedN * 100) : null;
              return (
                <BreakdownRow key={s.name}
                  name={s.name} pnl={s.pnl} trades={s.trades}
                  winRate={wr} rr={s.avgRR} barPct={(s.trades / maxStratTrades) * 100}
                />
              );
            })}
          </div>
        </Section>
      )}

      {/* ── Day of week ─────────────────────────────────────── */}
      {closedCount > 0 && (
        <Section title="התפלגות לפי יום בשבוע" icon={<Calendar size={14} />}>
          <div className="rounded-xl" style={{ background: SURF, borderLeft: `4px solid ${ACCENT}`, padding: 20, borderRadius: 12 }}>
            <BarChart bars={dowBars} height={80} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <StatCard label="יום רווחי ביותר"
              value={bestDow.count > 0 ? `${HE_DAYS[HE_DAYS_S.indexOf(bestDow.label)]} (${fmt(bestDow.value)})` : '—'}
              positive={true} />
            <StatCard label="יום הפסד ביותר"
              value={worstDow.count > 0 && worstDow.value < 0 ? `${HE_DAYS[HE_DAYS_S.indexOf(worstDow.label)]} (${fmt(worstDow.value)})` : '—'}
              positive={false} />
          </div>
        </Section>
      )}

      {/* ── Hour of day ────────────────────────────────────── */}
      {hourBars.length > 0 && (
        <Section title="התפלגות לפי שעה" icon={<Clock size={14} />}>
          <div className="rounded-xl" style={{ background: SURF, borderLeft: `4px solid ${ACCENT}`, padding: 20, borderRadius: 12 }}>
            <BarChart bars={hourBars} height={80} />
          </div>
          {bestHour && bestHour.count > 0 && (
            <StatCard label="שעה רווחית ביותר"
              value={`${bestHour.label}:00 (${fmt(bestHour.value)})`}
              positive={true} />
          )}
        </Section>
      )}

      {/* ── Symbol breakdown ─────────────────────────────── */}
      {symbols.length > 0 && (
        <Section title="התפלגות לפי סמל" icon={<CandlestickChart size={14} />}>
          <div className="flex flex-col gap-4">
            {symbols.map(s => {
              const wr = s.closedN > 0 ? Math.round(s.wins / s.closedN * 100) : null;
              return (
                <BreakdownRow key={s.name}
                  name={s.name} pnl={s.pnl} trades={s.trades}
                  winRate={wr} barPct={(s.trades / maxSymTrades) * 100}
                />
              );
            })}
          </div>
        </Section>
      )}

      {/* ── Streaks & records ────────────────────────────────── */}
      {closedCount > 0 && (
        <Section title="רצפים ושיאים" icon={<Trophy size={14} />}>
          <div className="grid grid-cols-2 gap-4">
            <StatCard label="רצף רווחים ארוך ביותר" value={String(maxW)} positive={true} icon={<Flame size={14} />} />
            <StatCard label="רצף הפסדים ארוך ביותר" value={String(maxL)} positive={false} icon={<Zap size={14} />} />
          </div>

          {/* Best / worst single trade */}
          {(bestTrade || worstTrade) && (
            <div className="grid grid-cols-2 gap-4">
              {bestTrade && (
                <StatCard label="עסקה טובה ביותר"
                  value={fmt(pnlIls(bestTrade), bestTrade.pnl_currency ?? '₪')}
                  sub={bestTrade.strategy} positive={true} />
              )}
              {worstTrade && (
                <StatCard label="עסקה גרועה ביותר"
                  value={fmt(pnlIls(worstTrade), worstTrade.pnl_currency ?? '₪')}
                  sub={worstTrade.strategy} positive={false} />
              )}
            </div>
          )}

          {/* Best / worst day */}
          {(bestDay || worstDay) && (
            <div className="grid grid-cols-2 gap-4">
              {bestDay && bestDay.pnl > 0 && (
                <StatCard label="יום טוב ביותר" value={fmt(bestDay.pnl)} sub={bestDay.label} positive={true} />
              )}
              {worstDay && worstDay.pnl < 0 && (
                <StatCard label="יום גרוע ביותר" value={fmt(worstDay.pnl)} sub={worstDay.label} positive={false} />
              )}
            </div>
          )}
        </Section>
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

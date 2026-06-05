import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import PnlChart, { type PeriodPoint } from '@/components/stats/PnlChart';
import type { TradePlan } from '@/lib/types';
import type { ReactNode } from 'react';
import { Zap, TrendingUp, AlertTriangle } from 'lucide-react';

export const metadata = { title: 'סטטיסטיקה — Reflect' };

// ── Constants ─────────────────────────────────────────────────────────────────
const HE_DAYS   = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HE_DAYS_S = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function pnlOf(t: TradePlan): number | null {
  if (t.status !== 'closed' || t.exit_price == null) return null;
  return Number(t.exit_price) - Number(t.entry_price);
}

function fmt(v: number, d = 1): string {
  if (v === 0) return '$0';
  return `${v > 0 ? '+' : '−'}$${Math.abs(v).toFixed(d)}`;
}

function pnlColor(v: number): string {
  return v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : 'var(--color-tg-text-2)';
}

// ── SVG bar chart (server) ────────────────────────────────────────────────────
interface Bar { label: string; value: number; count: number }

function BarChart({ bars, height = 72 }: { bars: Bar[]; height?: number }) {
  if (!bars.length || bars.every(b => b.count === 0)) return (
    <p className="text-xs text-center py-4" style={{ color: 'var(--color-tg-muted)' }}>אין נתונים</p>
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
        const col = b.value > 0 ? 'rgba(34,197,94,0.65)'
          : b.value < 0 ? 'rgba(239,68,68,0.65)'
          : 'rgba(100,116,139,0.28)';
        return (
          <g key={i}>
            <rect x={x.toFixed(1)} y={y.toFixed(1)} width={bw.toFixed(1)} height={bh.toFixed(1)}
              fill={col} rx="2" />
            <text x={(x + bw / 2).toFixed(1)} y={height - 2} textAnchor="middle"
              fontSize="7.5" fill="rgba(255,255,255,0.35)">{b.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Reusable section wrapper ──────────────────────────────────────────────────
function Section({ title, icon, children }: {
  title: string; icon?: string; children: React.ReactNode
}) {
  return (
    <div className="rounded-xl p-5 flex flex-col gap-4"
      style={{ background: '#1a1a28', border: '1px solid #35355a', boxShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
      <h2 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--color-tg-text)' }}>
        {icon && <span>{icon}</span>}
        {title}
      </h2>
      {children}
    </div>
  );
}

// ── Summary card ──────────────────────────────────────────────────────────────
function SumCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="rounded-xl p-4 flex flex-col gap-1"
      style={{ background: '#1a1a28', border: '1px solid #35355a', boxShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
      <p className="text-[11px] font-medium" style={{ color: 'var(--color-tg-muted)' }}>{label}</p>
      <p className="text-2xl font-bold leading-none" style={{ color }}>{value}</p>
      {sub && <p className="text-[10px]" style={{ color: 'var(--color-tg-muted)' }}>{sub}</p>}
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
      <div dir="rtl" className="min-h-screen px-4 py-6 flex flex-col gap-5">
        <PageHeader />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center py-16">
            <div className="text-5xl mb-4">📊</div>
            <p className="text-base font-semibold" style={{ color: 'var(--color-tg-text)' }}>אין עדיין נתונים</p>
            <p className="text-sm mt-1" style={{ color: 'var(--color-tg-muted)' }}>תעד עסקאות כדי לראות סטטיסטיקות</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Core stats ──────────────────────────────────────────────────────────────
  const totalTrades  = trades.length;
  const closedCount  = closed.length;
  const totalPnl     = closed.reduce((s, t) => s + pnlOf(t)!, 0);
  const wins         = closed.filter(t => pnlOf(t)! > 0);
  const losses       = closed.filter(t => pnlOf(t)! <= 0);
  const winRate      = closedCount > 0 ? Math.round(wins.length / closedCount * 100) : 0;
  const avgRR        = trades.length > 0
    ? trades.reduce((s, t) => s + Number(t.rr_ratio), 0) / trades.length : 0;
  const avgWin       = wins.length > 0
    ? wins.reduce((s, t) => s + pnlOf(t)!, 0) / wins.length : 0;
  const avgLoss      = losses.length > 0
    ? losses.reduce((s, t) => s + pnlOf(t)!, 0) / losses.length : 0;
  const profitFactor = Math.abs(avgLoss) > 0
    ? Math.abs(wins.reduce((s, t) => s + pnlOf(t)!, 0) / losses.reduce((s, t) => s + pnlOf(t)!, 1)) : 0;

  // ── P&L chart data ──────────────────────────────────────────────────────────
  const dailyMap   = new Map<string, PeriodPoint>();
  const weeklyMap  = new Map<string, PeriodPoint>();
  const monthlyMap = new Map<string, PeriodPoint>();

  for (const t of closed) {
    const p    = pnlOf(t)!;
    const win  = p > 0 ? 1 : 0;
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
      pnl:     prev.pnl + (p ?? 0),
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
    return { label: lbl, value: dayT.reduce((s, t) => s + pnlOf(t)!, 0), count: dayT.length };
  });
  const bestDow  = dowBars.reduce((b, d) => d.value > b.value ? d : b, dowBars[0]);
  const worstDow = dowBars.reduce((b, d) => d.value < b.value ? d : b, dowBars[0]);

  // ── Hour of day ─────────────────────────────────────────────────────────────
  const hourRaw = new Map<number, { pnl: number; count: number }>();
  for (const t of closed) {
    const h    = new Date(t.submitted_at).getHours();
    const prev = hourRaw.get(h) ?? { pnl: 0, count: 0 };
    hourRaw.set(h, { pnl: prev.pnl + pnlOf(t)!, count: prev.count + 1 });
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
      pnl:     prev.pnl + (p ?? 0),
    });
  }
  const symbols = [...symbolMap.entries()]
    .map(([name, v]) => ({ name, ...v }))
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

  const bestTrade  = closed.length ? closed.reduce((b, t) => pnlOf(t)! > pnlOf(b)! ? t : b) : null;
  const worstTrade = closed.length ? closed.reduce((w, t) => pnlOf(t)! < pnlOf(w)! ? t : w) : null;
  const bestDay    = daily.length  ? daily.reduce((b, d)  => d.pnl > b.pnl ? d : b) : null;
  const worstDay   = daily.length  ? daily.reduce((b, d)  => d.pnl < b.pnl ? d : b) : null;

  return (
    <div dir="rtl" className="min-h-screen px-4 py-6 flex flex-col gap-4">

      {/* ── Header ─────────────────────────────────────────────── */}
      <PageHeader />

      {/* ── Summary cards (2×2) ─────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <SumCard
          label="רווח/הפסד כולל"
          value={closedCount > 0 ? fmt(totalPnl) : '—'}
          color={pnlColor(totalPnl)}
          sub={`${closedCount} עסקאות סגורות`}
        />
        <SumCard
          label="אחוז הצלחה"
          value={closedCount > 0 ? `${winRate}%` : '—'}
          color={winRate >= 50 ? '#22c55e' : winRate >= 35 ? '#00d2d2' : '#ef4444'}
          sub={`${wins.length} מתוך ${closedCount}`}
        />
        <SumCard
          label="ממוצע R:R"
          value={trades.length > 0 ? `1:${avgRR.toFixed(1)}` : '—'}
          color="#00d2d2"
        />
        <SumCard
          label="פקטור רווח"
          value={profitFactor > 0 ? profitFactor.toFixed(2) : '—'}
          color={profitFactor >= 1.5 ? '#22c55e' : profitFactor >= 1 ? '#00d2d2' : '#ef4444'}
          sub="רווח ÷ הפסד"
        />
      </div>

      {/* ── Avg win/loss row ────────────────────────────────── */}
      {closedCount > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl p-3 flex flex-col gap-0.5"
            style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.18)' }}>
            <p className="text-[11px]" style={{ color: 'rgba(34,197,94,0.7)' }}>ממוצע רווח</p>
            <p className="text-lg font-bold" style={{ color: '#22c55e' }}>{fmt(avgWin)}</p>
          </div>
          <div className="rounded-2xl p-3 flex flex-col gap-0.5"
            style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.18)' }}>
            <p className="text-[11px]" style={{ color: 'rgba(239,68,68,0.7)' }}>ממוצע הפסד</p>
            <p className="text-lg font-bold" style={{ color: '#ef4444' }}>{fmt(avgLoss)}</p>
          </div>
        </div>
      )}

      {/* ── P&L Chart ───────────────────────────────────────── */}
      <Section title="רווח/הפסד לאורך זמן" icon="📈">
        <PnlChart daily={daily} weekly={weekly} monthly={monthly} />
      </Section>

      {/* ── Strategy breakdown ──────────────────────────────── */}
      {strategies.length > 0 && (
        <Section title="ביצועים לפי אסטרטגיה" icon="🎯">
          <div className="flex flex-col gap-0">
            {strategies.map((s, i) => {
              const wr = s.closedN > 0 ? Math.round(s.wins / s.closedN * 100) : null;
              const barPct = (s.trades / maxStratTrades) * 100;
              return (
                <div key={s.name}
                  className="flex items-center gap-3 py-3"
                  style={{ borderTop: i > 0 ? '1px solid var(--color-tg-border)' : undefined }}
                >
                  {/* Name + bar */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium" style={{ color: 'var(--color-tg-text)' }}>{s.name}</span>
                      <span className="text-xs" style={{ color: 'var(--color-tg-muted)' }}>{s.trades} עסקאות</span>
                    </div>
                    {/* Usage bar */}
                    <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-tg-surface-2)' }}>
                      <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: '#00d2d2' }} />
                    </div>
                  </div>
                  {/* Stats */}
                  <div className="flex flex-col items-end shrink-0 gap-0.5">
                    <span className="text-sm font-bold" style={{ color: pnlColor(s.pnl) }}>{fmt(s.pnl)}</span>
                    <div className="flex gap-2 text-[10px]" style={{ color: 'var(--color-tg-muted)' }}>
                      {wr !== null && (
                        <span style={{ color: wr >= 60 ? '#22c55e' : wr >= 40 ? '#00d2d2' : '#ef4444' }}>{wr}%</span>
                      )}
                      <span>R:R {s.avgRR.toFixed(1)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* ── Day of week ─────────────────────────────────────── */}
      {closedCount > 0 && (
        <Section title="התפלגות לפי יום בשבוע" icon="📅">
          <BarChart bars={dowBars} height={80} />
          <div className="grid grid-cols-2 gap-2">
            <InfoPill label="יום רווחי ביותר"
              value={bestDow.count > 0 ? `${HE_DAYS[HE_DAYS_S.indexOf(bestDow.label)]} (${fmt(bestDow.value)})` : '—'}
              color="#22c55e" />
            <InfoPill label="יום הפסד ביותר"
              value={worstDow.count > 0 && worstDow.value < 0 ? `${HE_DAYS[HE_DAYS_S.indexOf(worstDow.label)]} (${fmt(worstDow.value)})` : '—'}
              color="#ef4444" />
          </div>
        </Section>
      )}

      {/* ── Hour of day ────────────────────────────────────── */}
      {hourBars.length > 0 && (
        <Section title="התפלגות לפי שעה" icon="🕐">
          <BarChart bars={hourBars} height={80} />
          {bestHour && bestHour.count > 0 && (
            <InfoPill label="שעה רווחית ביותר"
              value={`${bestHour.label}:00 (${fmt(bestHour.value)})`}
              color="#00d2d2" />
          )}
        </Section>
      )}

      {/* ── Symbol breakdown ─────────────────────────────── */}
      {symbols.length > 0 && (
        <Section title="התפלגות לפי סמל" icon="💹">
          <div className="flex flex-col gap-0">
            {symbols.map((s, i) => {
              const wr = s.closedN > 0 ? Math.round(s.wins / s.closedN * 100) : null;
              return (
                <div key={s.name}
                  className="flex items-center justify-between py-3"
                  style={{ borderTop: i > 0 ? '1px solid var(--color-tg-border)' : undefined }}
                >
                  <div>
                    <p className="text-sm font-bold" style={{ color: 'var(--color-tg-text)' }}>{s.name}</p>
                    <p className="text-xs" style={{ color: 'var(--color-tg-muted)' }}>
                      {s.trades} עסקאות
                      {wr !== null && <span style={{ color: wr >= 50 ? '#22c55e' : '#ef4444' }}> · {wr}%</span>}
                    </p>
                  </div>
                  <span className="text-sm font-bold" style={{ color: pnlColor(s.pnl) }}>
                    {fmt(s.pnl)}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* ── Streaks & records ────────────────────────────────── */}
      {closedCount > 0 && (
        <Section title="רצפים ושיאים" icon="🏆">
          <div className="grid grid-cols-2 gap-3">
            <StreakCard label="רצף רווחים ארוך ביותר" value={maxW} color="#22c55e" icon="🔥" />
            <StreakCard label="רצף הפסדים ארוך ביותר" value={maxL} color="#ef4444" icon={<Zap size={14} />} />

            {currentStreak && (
              <div className="col-span-2 rounded-xl p-3 flex items-center gap-3"
                style={{
                  background: currentStreak.type === 'win' ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                  border: `1px solid ${currentStreak.type === 'win' ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                }}>
                <span>{currentStreak.type === 'win' ? <TrendingUp size={20} /> : <AlertTriangle size={20} />}</span>
                <div>
                  <p className="text-xs" style={{ color: 'var(--color-tg-muted)' }}>רצף נוכחי</p>
                  <p className="text-sm font-bold" style={{ color: currentStreak.type === 'win' ? '#22c55e' : '#ef4444' }}>
                    {currentStreak.count} {currentStreak.type === 'win' ? 'רווחים' : 'הפסדים'} ברצף
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Best / worst single trade */}
          {(bestTrade || worstTrade) && (
            <div className="grid grid-cols-2 gap-3 pt-1">
              {bestTrade && (
                <div className="rounded-xl p-3" style={{ background: 'rgba(34,197,94,0.07)' }}>
                  <p className="text-[10px] mb-0.5" style={{ color: 'rgba(34,197,94,0.6)' }}>עסקה טובה ביותר</p>
                  <p className="text-sm font-bold" style={{ color: '#22c55e' }}>{fmt(pnlOf(bestTrade)!)}</p>
                  <p className="text-[10px]" style={{ color: 'var(--color-tg-muted)' }}>{bestTrade.strategy}</p>
                </div>
              )}
              {worstTrade && (
                <div className="rounded-xl p-3" style={{ background: 'rgba(239,68,68,0.07)' }}>
                  <p className="text-[10px] mb-0.5" style={{ color: 'rgba(239,68,68,0.6)' }}>עסקה גרועה ביותר</p>
                  <p className="text-sm font-bold" style={{ color: '#ef4444' }}>{fmt(pnlOf(worstTrade)!)}</p>
                  <p className="text-[10px]" style={{ color: 'var(--color-tg-muted)' }}>{worstTrade.strategy}</p>
                </div>
              )}
            </div>
          )}

          {/* Best / worst day */}
          {(bestDay || worstDay) && (
            <div className="grid grid-cols-2 gap-3">
              {bestDay && bestDay.pnl > 0 && (
                <div className="rounded-xl p-3" style={{ background: 'rgba(34,197,94,0.07)' }}>
                  <p className="text-[10px] mb-0.5" style={{ color: 'rgba(34,197,94,0.6)' }}>יום טוב ביותר</p>
                  <p className="text-sm font-bold" style={{ color: '#22c55e' }}>{fmt(bestDay.pnl)}</p>
                  <p className="text-[10px]" style={{ color: 'var(--color-tg-muted)' }}>{bestDay.label}</p>
                </div>
              )}
              {worstDay && worstDay.pnl < 0 && (
                <div className="rounded-xl p-3" style={{ background: 'rgba(239,68,68,0.07)' }}>
                  <p className="text-[10px] mb-0.5" style={{ color: 'rgba(239,68,68,0.6)' }}>יום גרוע ביותר</p>
                  <p className="text-sm font-bold" style={{ color: '#ef4444' }}>{fmt(worstDay.pnl)}</p>
                  <p className="text-[10px]" style={{ color: 'var(--color-tg-muted)' }}>{worstDay.label}</p>
                </div>
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
        <p className="text-xs" style={{ color: 'var(--color-tg-muted)' }}>ניתוח מלא של ביצועי המסחר שלך</p>
      </div>
    </div>
  );
}

function InfoPill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--color-tg-surface-2)' }}>
      <p className="text-[10px] mb-0.5" style={{ color: 'var(--color-tg-muted)' }}>{label}</p>
      <p className="text-xs font-semibold" style={{ color }}>{value}</p>
    </div>
  );
}

function StreakCard({ label, value, color, icon }: { label: string; value: number; color: string; icon: ReactNode }) {
  return (
    <div className="rounded-xl p-3 flex flex-col gap-1" style={{ background: 'var(--color-tg-surface-2)' }}>
      <div className="flex items-center gap-1.5">
        <span>{icon}</span>
        <p className="text-[10px]" style={{ color: 'var(--color-tg-muted)' }}>{label}</p>
      </div>
      <p className="text-2xl font-bold" style={{ color: value > 0 ? color : 'var(--color-tg-muted)' }}>{value}</p>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Calendar, TrendingUp, TrendingDown } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import { GREEN, RED, MUTED, TEXT, fmt, pnlColor, Section, TooltipCard } from './shared';

interface TooltipContentProps<T> {
  active?: boolean;
  payload?: { payload: T }[];
}

export interface DistBar {
  label: string;
  pnl: number;
  trades: number;
  winRate: number | null;
}

interface Props {
  dayBars: DistBar[];
  hourBars: DistBar[];
}

const VIEWS = [['day', 'לפי יום'], ['hour', 'לפי שעה']] as const;

export default function DistributionSection({ dayBars, hourBars }: Props) {
  const [view, setView] = useState<'day' | 'hour'>('day');
  const bars = view === 'day' ? dayBars : hourBars;

  const withTrades = bars.filter(b => b.trades > 0);
  const best  = withTrades.length ? withTrades.reduce((a, b) => b.pnl > a.pnl ? b : a) : null;
  const worst = withTrades.length ? withTrades.reduce((a, b) => b.pnl < a.pnl ? b : a) : null;

  return (
    <Section title="התפלגות לפי יום ושעה" icon={<Calendar size={18} />}>
      <div className="stats-card p-4 sm:p-5 flex flex-col gap-4">

        <div className="stats-seg self-start">
          {VIEWS.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setView(key)}
              className={view === key ? 'active' : undefined}>
              {label}
            </button>
          ))}
        </div>

        {bars.every(b => b.trades === 0) ? (
          <p className="text-center py-6" style={{ fontSize: 12, color: MUTED }}>אין נתונים</p>
        ) : (
          <div dir="ltr" className="h-[200px] sm:h-[220px]">
            <ResponsiveContainer debounce={60} width="100%" height="100%">
              <BarChart data={bars} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-tg-border-light)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: MUTED }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<DistTooltip />} />
                <Bar dataKey="pnl" maxBarSize={18} radius={[3, 3, 0, 0]}>
                  {bars.map((b, i) => (
                    <Cell key={i}
                      fill={b.trades === 0 ? 'var(--color-tg-border-light)' : b.pnl >= 0 ? GREEN : RED}
                      opacity={b.trades === 0 ? 1 : 0.85}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Best / worst inline stat lines */}
        {(best?.pnl ?? 0) > 0 || (worst?.pnl ?? 0) < 0 ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 pt-3"
            style={{ borderTop: '1px solid var(--color-tg-border-light)', fontSize: 12 }}>
            {best && best.pnl > 0 && (
              <span className="flex items-center gap-1.5" style={{ color: MUTED }}>
                <TrendingUp size={13} style={{ color: GREEN }} />
                {view === 'day' ? 'יום רווחי ביותר' : 'שעה רווחית ביותר'}:
                <span style={{ fontWeight: 700, color: TEXT }}>{best.label}</span>
                <span className="stats-num" style={{ fontWeight: 700, color: GREEN }}>{fmt(best.pnl)}</span>
              </span>
            )}
            {worst && worst.pnl < 0 && (
              <span className="flex items-center gap-1.5" style={{ color: MUTED }}>
                <TrendingDown size={13} style={{ color: RED }} />
                {view === 'day' ? 'יום הפסד ביותר' : 'שעה הפסדית ביותר'}:
                <span style={{ fontWeight: 700, color: TEXT }}>{worst.label}</span>
                <span className="stats-num" style={{ fontWeight: 700, color: RED }}>{fmt(worst.pnl)}</span>
              </span>
            )}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function DistTooltip({ active, payload }: TooltipContentProps<DistBar>) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  return (
    <TooltipCard>
      <p style={{ fontWeight: 700, color: TEXT, marginBottom: 4 }}>{b.label}</p>
      <div className="flex flex-col gap-1">
        <p className="flex items-center justify-between gap-5">
          <span style={{ color: MUTED }}>רווח/הפסד</span>
          <span className="stats-num" style={{ fontWeight: 700, color: b.pnl === 0 ? MUTED : pnlColor(b.pnl) }}>{fmt(b.pnl)}</span>
        </p>
        <p className="flex items-center justify-between gap-5">
          <span style={{ color: MUTED }}>עסקאות</span>
          <span className="stats-num" style={{ fontWeight: 700, color: TEXT }}>{b.trades}</span>
        </p>
        {b.winRate !== null && (
          <p className="flex items-center justify-between gap-5">
            <span style={{ color: MUTED }}>הצלחה</span>
            <span className="stats-num" style={{ fontWeight: 700, color: TEXT }}>{b.winRate}%</span>
          </p>
        )}
      </div>
    </TooltipCard>
  );
}

'use client';

import { useState } from 'react';
import { Calendar } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import { SURF, ACCENT, GREEN, RED, MUTED, fmt, Section, StatCard } from './shared';

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

const NO_TRADES = 'var(--color-tg-border)';

export default function DistributionSection({ dayBars, hourBars }: Props) {
  const [view, setView] = useState<'day' | 'hour'>('day');
  const bars = view === 'day' ? dayBars : hourBars;

  const withTrades = bars.filter(b => b.trades > 0);
  const best  = withTrades.length ? withTrades.reduce((a, b) => b.pnl > a.pnl ? b : a) : null;
  const worst = withTrades.length ? withTrades.reduce((a, b) => b.pnl < a.pnl ? b : a) : null;

  return (
    <Section title="התפלגות לפי יום ושעה" icon={<Calendar size={18} />}>
      <div className="flex items-center gap-1.5">
        {([['day', 'לפי יום'], ['hour', 'לפי שעה']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
            style={{
              background: view === key ? 'rgba(0,210,210,0.15)' : 'var(--color-tg-surface-2)',
              color:      view === key ? ACCENT : 'var(--color-tg-text-2)',
              fontWeight: 600,
              border:     view === key ? '1px solid rgba(0,210,210,0.3)' : '1px solid transparent',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-xl p-3 sm:p-5" style={{ background: SURF, borderLeft: `4px solid ${ACCENT}`, borderRadius: 12 }}>
        {bars.every(b => b.trades === 0) ? (
          <p className="text-center py-4" style={{ fontSize: 12, color: MUTED }}>אין נתונים</p>
        ) : (
          <div dir="ltr">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={bars} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-tg-border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: MUTED }} />
                <YAxis hide />
                <Tooltip
                  contentStyle={{ background: SURF, border: 'none', fontSize: 12, borderRadius: 8 }}
                  formatter={(v) => fmt(Number(v))}
                />
                <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                  {bars.map((b, i) => (
                    <Cell key={i} fill={b.trades === 0 ? NO_TRADES : b.pnl >= 0 ? GREEN : RED} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard
          label={view === 'day' ? 'יום רווחי ביותר' : 'שעה רווחית ביותר'}
          value={best && best.pnl > 0 ? `${best.label} (${fmt(best.pnl)})` : '—'}
          positive={true}
        />
        <StatCard
          label={view === 'day' ? 'יום הפסד ביותר' : 'שעה הפסדית ביותר'}
          value={worst && worst.pnl < 0 ? `${worst.label} (${fmt(worst.pnl)})` : '—'}
          positive={false}
        />
      </div>
    </Section>
  );
}

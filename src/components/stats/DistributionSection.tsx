'use client';

import { useState } from 'react';
import { Calendar } from 'lucide-react';
import { SURF, ACCENT, GREEN, RED, MUTED, TEXT, fmt, Section, StatCard } from './shared';

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
  const maxAbs = Math.max(...bars.map(b => Math.abs(b.pnl)), 0.001);

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

      <div className="rounded-xl" style={{ background: SURF, borderLeft: `4px solid ${ACCENT}`, padding: 20, borderRadius: 12 }}>
        {bars.every(b => b.trades === 0) ? (
          <p className="text-center py-4" style={{ fontSize: 12, color: MUTED }}>אין נתונים</p>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {bars.map((b, i) => {
              const color      = b.trades === 0 ? NO_TRADES : b.pnl >= 0 ? GREEN : RED;
              const heightPct  = b.trades > 0 ? Math.max((Math.abs(b.pnl) / maxAbs) * 100, 8) : 4;
              return (
                <div key={i} className="flex flex-col items-center gap-1" style={{ minWidth: 56 }}>
                  <div className="w-full flex items-end justify-center" style={{ height: 56 }}>
                    <div style={{ width: '60%', height: `${heightPct}%`, background: color, borderRadius: 3 }} />
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: TEXT }}>{b.label}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: b.trades === 0 ? MUTED : (b.pnl >= 0 ? GREEN : RED) }}>
                    {b.trades > 0 ? fmt(b.pnl) : '—'}
                  </span>
                  <span style={{ fontSize: 9, color: MUTED }}>{b.winRate !== null ? `${b.winRate}%` : '—'}</span>
                  <span style={{ fontSize: 9, color: MUTED }}>{b.trades} עסקאות</span>
                </div>
              );
            })}
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

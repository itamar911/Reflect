'use client';

import { useState } from 'react';

type Period = 'day' | 'week' | 'month';

export interface PeriodPoint {
  label: string;
  pnl: number;
  trades: number;
  wins: number;
}

interface Props {
  daily: PeriodPoint[];
  weekly: PeriodPoint[];
  monthly: PeriodPoint[];
}

const GREEN = 'var(--color-tg-success)';

function fmt(v: number) {
  if (v === 0) return '₪0';
  return `${v > 0 ? '+' : '−'}₪${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
}

export default function PnlChart({ daily, weekly, monthly }: Props) {
  const [period, setPeriod] = useState<Period>('day');

  const data: PeriodPoint[] = period === 'day' ? daily : period === 'week' ? weekly : monthly;

  const totalPnl   = data.reduce((s, d) => s + d.pnl, 0);
  const totalTrades = data.reduce((s, d) => s + d.trades, 0);
  const totalWins  = data.reduce((s, d) => s + d.wins, 0);
  const isUp       = totalPnl >= 0;
  const pnlColor   = isUp ? GREEN : 'var(--color-tg-danger)';

  const W = 300, H = 96;
  const MID = 56;              // zero-line y
  const n = data.length || 1;
  const step = W / n;
  const barW = step * 0.62;
  const maxBar = Math.max(...data.map(d => Math.abs(d.pnl)), 0.001);

  // Cumulative equity line
  const cum: number[] = [];
  let acc = 0;
  for (const d of data) { acc += d.pnl; cum.push(acc); }

  const minCum = Math.min(...cum, 0);
  const maxCum = Math.max(...cum, 0);
  const cumSpan = maxCum - minCum || 0.001;
  const lineY = (v: number) => H - 4 - ((v - minCum) / cumSpan) * (H - MID - 4);

  const linePoints = cum
    .map((v, i) => `${(i * step + step / 2).toFixed(1)},${lineY(v).toFixed(1)}`)
    .join(' ');

  const showLabels = data.length > 0 && data.length <= 14;

  return (
    <div className="flex flex-col gap-3">

      {/* Tabs + total */}
      <div className="flex items-center gap-1.5">
        {([['day', 'יומי'], ['week', 'שבועי'], ['month', 'חודשי']] as const).map(([key, lbl]) => (
          <button
            key={key}
            onClick={() => setPeriod(key)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
            style={{
              background: period === key ? 'rgba(0,210,210,0.15)' : 'var(--color-tg-surface-2)',
              color:      period === key ? '#00d2d2' : 'var(--color-tg-text-2)',
              fontWeight: 600,
              border:     period === key ? '1px solid rgba(0,210,210,0.3)' : '1px solid transparent',
            }}
          >
            {lbl}
          </button>
        ))}
        <span className="flex-1" />
        <span className="text-sm font-bold" style={{ color: pnlColor }}>{fmt(totalPnl)}</span>
      </div>

      {/* SVG chart */}
      {data.length > 0 ? (
        <>
          {/* LTR wrapper — keeps the oldest point on the left and the most recent on the right */}
          <div dir="ltr">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              style={{ width: '100%', height: H, display: 'block' }}
            >
              {/* Bars */}
              {data.map((d, i) => {
                const bh = Math.max((Math.abs(d.pnl) / maxBar) * (MID - 6), d.trades > 0 ? 2 : 0);
                const x = i * step + (step - barW) / 2;
                const y = d.pnl >= 0 ? MID - bh : MID;
                return (
                  <rect
                    key={i}
                    x={x.toFixed(1)} y={y.toFixed(1)}
                    width={barW.toFixed(1)} height={bh.toFixed(1)}
                    fill={d.pnl > 0 ? 'rgba(34,197,94,0.6)' : d.pnl < 0 ? 'rgba(239,68,68,0.6)' : 'rgba(100,116,139,0.25)'}
                    rx="1.5"
                  />
                );
              })}

              {/* Zero line */}
              <line x1="0" y1={MID} x2={W} y2={MID} style={{ stroke: 'var(--color-tg-border-light)' }} strokeWidth="0.8" />

              {/* Equity line */}
              {cum.length > 1 && (
                <polyline
                  points={linePoints}
                  fill="none"
                  stroke={pnlColor}
                  strokeWidth="1.6"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
              )}
            </svg>

            {/* X-axis labels */}
            {showLabels && (
              <div className="flex" style={{ marginTop: -6 }}>
                {data.map((d, i) => (
                  <div key={i} style={{ flex: 1, textAlign: 'center' }}>
                    <span style={{ fontSize: 9, color: 'var(--color-tg-muted)' }}>{d.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer summary */}
          <div className="flex gap-4" style={{ fontSize: 11, color: 'var(--color-tg-muted)' }}>
            <span>{totalTrades} עסקאות</span>
            {totalTrades > 0 && (
              <span style={{ color: totalWins / totalTrades >= 0.5 ? GREEN : 'var(--color-tg-muted)' }}>
                {Math.round((totalWins / totalTrades) * 100)}% הצלחה
              </span>
            )}
          </div>
        </>
      ) : (
        <div
          className="flex items-center justify-center py-8 rounded-xl"
          style={{ background: 'var(--color-tg-surface-2)' }}
        >
          <p style={{ fontSize: 12, color: 'var(--color-tg-muted)' }}>אין עסקאות סגורות להצגה</p>
        </div>
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';

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
const RED = 'var(--color-tg-danger)';
const MUTED = 'var(--color-tg-muted)';
const SURF = 'var(--color-tg-surface)';

function fmt(v: number) {
  if (v === 0) return '₪0';
  return `${v > 0 ? '+' : '−'}₪${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
}

export default function PnlChart({ daily, weekly, monthly }: Props) {
  const [period, setPeriod] = useState<Period>('day');

  const data: PeriodPoint[] = period === 'day' ? daily : period === 'week' ? weekly : monthly;

  const totalPnl    = data.reduce((s, d) => s + d.pnl, 0);
  const totalTrades = data.reduce((s, d) => s + d.trades, 0);
  const totalWins   = data.reduce((s, d) => s + d.wins, 0);
  const pnlColor    = totalPnl >= 0 ? GREEN : RED;

  const chartData = data.reduce<(PeriodPoint & { cum: number })[]>((acc, d) => {
    const prevCum = acc.length ? acc[acc.length - 1].cum : 0;
    return [...acc, { ...d, cum: prevCum + d.pnl }];
  }, []);

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

      {chartData.length > 0 ? (
        <>
          <div dir="ltr">
            <ResponsiveContainer debounce={60} width="100%" height={140}>
              <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-tg-border)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 9, fill: MUTED }}
                  interval={chartData.length > 14 ? Math.ceil(chartData.length / 10) : 0}
                />
                <YAxis hide />
                <Tooltip
                  contentStyle={{ background: SURF, border: 'none', fontSize: 12, borderRadius: 8 }}
                  formatter={(v, name) => name === 'cum' ? [fmt(Number(v)), 'שווי מצטבר'] : [fmt(Number(v)), 'רווח/הפסד']}
                />
                <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={d.pnl > 0 ? 'rgba(34,197,94,0.6)' : d.pnl < 0 ? 'rgba(239,68,68,0.6)' : 'rgba(100,116,139,0.25)'} />
                  ))}
                </Bar>
                <Line type="monotone" dataKey="cum" stroke={pnlColor} strokeWidth={1.6} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Footer summary */}
          <div className="flex gap-4" style={{ fontSize: 11, color: MUTED }}>
            <span>{totalTrades} עסקאות</span>
            {totalTrades > 0 && (
              <span style={{ color: totalWins / totalTrades >= 0.5 ? GREEN : MUTED }}>
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
          <p style={{ fontSize: 12, color: MUTED }}>אין עסקאות סגורות להצגה</p>
        </div>
      )}
    </div>
  );
}

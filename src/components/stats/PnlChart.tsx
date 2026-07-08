'use client';

import { useState } from 'react';
import {
  ComposedChart, Bar, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Cell,
} from 'recharts';
import { MUTED, TEXT, fmt, pnlColor, GREEN_HEX, RED_HEX, TooltipCard } from './shared';

interface TooltipContentProps<T> {
  active?: boolean;
  payload?: { payload: T }[];
  label?: string | number;
}

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

const PERIODS = [['day', 'יומי'], ['week', 'שבועי'], ['month', 'חודשי']] as const;

function compactCurrency(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (abs >= 1000) return `${sign}₪${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `${sign}₪${Math.round(abs)}`;
}

export default function PnlChart({ daily, weekly, monthly }: Props) {
  const [period, setPeriod] = useState<Period>('day');

  const data: PeriodPoint[] = period === 'day' ? daily : period === 'week' ? weekly : monthly;

  const totalPnl    = data.reduce((s, d) => s + d.pnl, 0);
  const totalTrades = data.reduce((s, d) => s + d.trades, 0);
  const totalWins   = data.reduce((s, d) => s + d.wins, 0);

  const chartData = data.reduce<(PeriodPoint & { cum: number })[]>((acc, d) => {
    const prevCum = acc.length ? acc[acc.length - 1].cum : 0;
    return [...acc, { ...d, cum: prevCum + d.pnl }];
  }, []);

  const lineColor = pnlColor(totalPnl);
  const gradHex   = totalPnl >= 0 ? GREEN_HEX : RED_HEX;

  return (
    <div className="stats-card p-4 sm:p-5 flex flex-col gap-4">

      {/* Header: current total (top-right in RTL) + segmented control */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <span className="stats-num" style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.1, color: lineColor }}>
            {fmt(totalPnl)}
          </span>
          <span style={{ fontSize: 11.5, color: MUTED }}>
            {totalTrades} עסקאות
            {totalTrades > 0 && ` · ${Math.round((totalWins / totalTrades) * 100)}% הצלחה`}
          </span>
        </div>
        <div className="stats-seg">
          {PERIODS.map(([key, lbl]) => (
            <button key={key} type="button" onClick={() => setPeriod(key)}
              className={period === key ? 'active' : undefined}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {chartData.length > 0 ? (
        <div dir="ltr" className="h-[240px] md:h-[340px]">
          <ResponsiveContainer debounce={60} width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="equity-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={gradHex} stopOpacity={0.26} />
                  <stop offset="100%" stopColor={gradHex} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-tg-border-light)" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: MUTED }}
                axisLine={false}
                tickLine={false}
                interval={chartData.length > 14 ? Math.ceil(chartData.length / 10) : 0}
              />
              <YAxis
                tick={{ fontSize: 10, fill: MUTED }}
                axisLine={false}
                tickLine={false}
                width={52}
                tickFormatter={compactCurrency}
              />
              <Tooltip
                cursor={{ stroke: 'var(--color-tg-border)', strokeDasharray: '3 3' }}
                content={<EquityTooltip />}
              />
              {/* Slim per-period bars as a secondary layer near the baseline */}
              <Bar dataKey="pnl" maxBarSize={7} radius={[2, 2, 0, 0]}>
                {chartData.map((d, i) => (
                  <Cell key={i} fill={d.pnl > 0 ? 'rgba(34,197,94,0.45)' : d.pnl < 0 ? 'rgba(239,68,68,0.45)' : 'rgba(100,116,139,0.25)'} />
                ))}
              </Bar>
              <Area
                type="monotone"
                dataKey="cum"
                stroke={lineColor}
                strokeWidth={2}
                fill="url(#equity-fill)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex items-center justify-center py-10 rounded-xl"
          style={{ background: 'var(--color-tg-surface-2)' }}>
          <p style={{ fontSize: 12, color: MUTED }}>אין עסקאות סגורות להצגה</p>
        </div>
      )}
    </div>
  );
}

function EquityTooltip({ active, payload, label }: TooltipContentProps<PeriodPoint & { cum: number }>) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <TooltipCard>
      <p style={{ fontWeight: 700, color: TEXT, marginBottom: 4 }}>{label}</p>
      <div className="flex flex-col gap-1">
        <Row label="שווי מצטבר" value={fmt(p.cum)} color={pnlColor(p.cum)} />
        <Row label="רווח/הפסד" value={fmt(p.pnl)} color={p.pnl === 0 ? MUTED : pnlColor(p.pnl)} />
        <Row label="עסקאות" value={String(p.trades)} color={TEXT} />
      </div>
    </TooltipCard>
  );
}

function Row({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <p className="flex items-center justify-between gap-5">
      <span style={{ color: MUTED }}>{label}</span>
      <span className="stats-num" style={{ fontWeight: 700, color }}>{value}</span>
    </p>
  );
}

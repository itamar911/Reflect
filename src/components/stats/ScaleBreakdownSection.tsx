'use client';

import type { ReactNode } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import { SURF, ACCENT, GREEN, RED, MUTED, TEXT, fmt, Section } from './shared';

export interface ScaleBucket {
  level: number;
  trades: number;
  wins: number;
  closedN: number;
  pnl: number;
}

interface Props {
  title: string;
  icon?: ReactNode;
  buckets: ScaleBucket[];
  insights: string[];
}

export default function ScaleBreakdownSection({ title, icon, buckets, insights }: Props) {
  const winRateData = buckets.map(b => ({
    level: String(b.level),
    value: b.closedN > 0 ? Math.round((b.wins / b.closedN) * 100) : 0,
  }));
  const avgProfitData = buckets.map(b => ({
    level: String(b.level),
    value: b.closedN > 0 ? Math.round(b.pnl / b.closedN) : 0,
  }));
  const countData = buckets.map(b => ({
    level: String(b.level),
    value: b.trades,
  }));

  return (
    <Section title={title} icon={icon}>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ChartCard label="אחוז הצלחה לפי רמה">
          <ResponsiveContainer debounce={150} width="100%" height={160}>
            <BarChart data={winRateData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-tg-border)" vertical={false} />
              <XAxis dataKey="level" tick={{ fontSize: 11, fill: MUTED }} />
              <YAxis tick={{ fontSize: 10, fill: MUTED }} width={28} />
              <Tooltip formatter={(v) => `${Number(v)}%`} contentStyle={{ background: SURF, border: 'none', fontSize: 12, borderRadius: 8 }} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {winRateData.map((d, i) => <Cell key={i} fill={d.value >= 50 ? GREEN : RED} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard label="ממוצע רווח/הפסד לפי רמה">
          <ResponsiveContainer debounce={150} width="100%" height={160}>
            <BarChart data={avgProfitData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-tg-border)" vertical={false} />
              <XAxis dataKey="level" tick={{ fontSize: 11, fill: MUTED }} />
              <YAxis tick={{ fontSize: 10, fill: MUTED }} width={36} />
              <Tooltip formatter={(v) => fmt(Number(v))} contentStyle={{ background: SURF, border: 'none', fontSize: 12, borderRadius: 8 }} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {avgProfitData.map((d, i) => <Cell key={i} fill={d.value >= 0 ? GREEN : RED} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard label="כמות עסקאות לפי רמה">
          <ResponsiveContainer debounce={150} width="100%" height={160}>
            <BarChart data={countData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-tg-border)" vertical={false} />
              <XAxis dataKey="level" tick={{ fontSize: 11, fill: MUTED }} />
              <YAxis tick={{ fontSize: 10, fill: MUTED }} width={28} allowDecimals={false} />
              <Tooltip contentStyle={{ background: SURF, border: 'none', fontSize: 12, borderRadius: 8 }} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]} fill={ACCENT} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {insights.length > 0 && (
        <div className="flex flex-col gap-2">
          {insights.map((s, i) => (
            <div key={i} className="rounded-xl px-3 py-2.5 text-sm"
              style={{ background: SURF, color: TEXT, borderRight: `3px solid ${ACCENT}` }}>
              {s}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function ChartCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl p-3" style={{ background: SURF, borderRadius: 12 }}>
      <p style={{ fontSize: 11, color: MUTED, marginBottom: 6, fontWeight: 600 }}>{label}</p>
      {children}
    </div>
  );
}

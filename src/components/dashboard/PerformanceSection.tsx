'use client';

import { useState, useMemo } from 'react';

type Plan = 'free' | 'basic' | 'pro';

interface SimpleTrade {
  strategy: string;
  emotional_state: number;
  rr_ratio: number;
  submitted_at: string;
}

interface PerformanceSectionProps {
  trades: SimpleTrade[];
  plan: Plan;
}

type BasicFilter = 'day' | '3days' | 'week' | '2weeks';
type ProFilter = BasicFilter | '30days' | '90days' | 'year';

const BASIC_FILTERS: { key: BasicFilter; label: string }[] = [
  { key: 'day', label: '׳™׳•׳' },
  { key: '3days', label: '3 ׳™׳׳™׳' },
  { key: 'week', label: '׳©׳‘׳•׳¢' },
  { key: '2weeks', label: '׳©׳‘׳•׳¢׳™׳™׳' },
];

const PRO_EXTRA_FILTERS: { key: ProFilter; label: string }[] = [
  { key: '30days', label: '30 ׳™׳•׳' },
  { key: '90days', label: '90 ׳™׳•׳' },
  { key: 'year', label: '׳©׳ ׳”' },
];

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

function filterByRange(trades: SimpleTrade[], filter: ProFilter): SimpleTrade[] {
  const cutoff = {
    day: daysAgo(1),
    '3days': daysAgo(3),
    week: daysAgo(7),
    '2weeks': daysAgo(14),
    '30days': daysAgo(30),
    '90days': daysAgo(90),
    year: daysAgo(365),
  }[filter];
  return trades.filter((t) => new Date(t.submitted_at) >= cutoff);
}

const EMOTIONAL_EMOJIS: Record<number, string> = { 1: 'נ˜°', 2: 'נ˜', 3: 'נ˜', 4: 'נ™‚', 5: 'נ˜' };
const EMOTIONAL_COLORS: Record<number, string> = {
  1: 'var(--color-tg-danger)',
  2: 'var(--color-tg-warning)',
  3: 'var(--color-tg-text-2)',
  4: 'var(--color-tg-success)',
  5: 'var(--color-tg-primary)',
};

export default function PerformanceSection({ trades, plan }: PerformanceSectionProps) {
  const [filter, setFilter] = useState<ProFilter>('2weeks');
  const allFilters = plan === 'pro'
    ? [...BASIC_FILTERS, ...PRO_EXTRA_FILTERS]
    : BASIC_FILTERS;

  const filtered = useMemo(() => filterByRange(trades, filter), [trades, filter]);

  const emotionalDist = useMemo(() => {
    const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const t of filtered) {
      const e = t.emotional_state;
      if (e >= 1 && e <= 5) dist[e]++;
    }
    return dist;
  }, [filtered]);

  const maxEmotional = Math.max(...Object.values(emotionalDist), 1);

  const strategyBreakdown = useMemo(() => {
    const map: Record<string, { count: number; totalRR: number }> = {};
    for (const t of filtered) {
      const s = t.strategy || '׳׳—׳¨';
      if (!map[s]) map[s] = { count: 0, totalRR: 0 };
      map[s].count++;
      map[s].totalRR += t.rr_ratio || 0;
    }
    return Object.entries(map)
      .map(([name, v]) => ({ name, count: v.count, avgRR: v.count > 0 ? v.totalRR / v.count : 0 }))
      .sort((a, b) => b.count - a.count);
  }, [filtered]);

  // Week-over-week comparison
  const thisWeek = useMemo(() => filterByRange(trades, 'week'), [trades]);
  const prevWeekTrades = useMemo(() => {
    const from = daysAgo(14);
    const to = daysAgo(7);
    return trades.filter((t) => {
      const d = new Date(t.submitted_at);
      return d >= from && d < to;
    });
  }, [trades]);

  const weekDelta = thisWeek.length - prevWeekTrades.length;
  const thisWeekAvgRR = thisWeek.length > 0
    ? (thisWeek.reduce((s, t) => s + (t.rr_ratio || 0), 0) / thisWeek.length)
    : 0;
  const prevWeekAvgRR = prevWeekTrades.length > 0
    ? (prevWeekTrades.reduce((s, t) => s + (t.rr_ratio || 0), 0) / prevWeekTrades.length)
    : 0;
  const rrDelta = thisWeekAvgRR - prevWeekAvgRR;

  if (trades.length === 0) return null;

  return (
    <div className="flex flex-col gap-5">
      {/* Filter tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-none"
        style={{ scrollbarWidth: 'none' }}>
        {allFilters.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all duration-150"
            style={{
              background: filter === key ? 'var(--color-tg-primary)' : 'var(--color-tg-surface)',
              borderColor: filter === key ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
              color: filter === key ? 'white' : 'var(--color-tg-text-2)',
            }}
          >
            {label}
          </button>
        ))}
        {plan !== 'pro' && (
          <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs border"
            style={{ borderColor: 'var(--color-tg-border)', color: 'var(--color-tg-muted)' }}>
            30/90/׳©׳ ׳”
            <span className="font-bold" style={{ color: '#f59e0b' }}>Pro</span>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-6 rounded-2xl border border-tg-border"
          style={{ background: 'var(--color-tg-surface)' }}>
          <p className="text-sm text-tg-text-2">׳׳™׳ ׳¢׳¡׳§׳׳•׳× ׳‘׳˜׳•׳•׳— ׳”׳–׳׳ ׳”׳ ׳‘׳—׳¨</p>
        </div>
      ) : (
        <>
          {/* Week-over-week comparison */}
          {plan !== 'free' && (
            <div className="rounded-2xl border border-tg-border p-4"
              style={{ background: 'var(--color-tg-surface)' }}>
              <h3 className="text-sm font-semibold text-tg-text mb-3">׳”׳©׳•׳•׳׳” ׳©׳‘׳•׳¢ ׳׳•׳ ׳©׳‘׳•׳¢</h3>
              <div className="grid grid-cols-2 gap-3">
                <CompareCell
                  label="׳¢׳¡׳§׳׳•׳×"
                  current={thisWeek.length}
                  delta={weekDelta}
                  suffix=""
                />
                <CompareCell
                  label="R:R ׳׳׳•׳¦׳¢"
                  current={parseFloat(thisWeekAvgRR.toFixed(2))}
                  delta={parseFloat(rrDelta.toFixed(2))}
                  suffix=""
                />
              </div>
            </div>
          )}

          {/* Emotional patterns */}
          <div className="rounded-2xl border border-tg-border p-4"
            style={{ background: 'var(--color-tg-surface)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-tg-text">׳“׳₪׳•׳¡׳™׳ ׳¨׳’׳©׳™׳™׳</h3>
              <span className="text-xs text-tg-muted">{filtered.length} ׳¢׳¡׳§׳׳•׳×</span>
            </div>
            <div className="flex items-end gap-2 h-20">
              {([1, 2, 3, 4, 5] as const).map((n) => {
                const count = emotionalDist[n];
                const pct = Math.round((count / maxEmotional) * 100);
                return (
                  <div key={n} className="flex-1 flex flex-col items-center gap-1">
                    <span className="text-xs font-medium" style={{ color: EMOTIONAL_COLORS[n] }}>
                      {count > 0 ? count : ''}
                    </span>
                    <div className="w-full rounded-t-lg" style={{
                      height: `${Math.max(pct, 4)}%`,
                      background: EMOTIONAL_COLORS[n],
                      opacity: count === 0 ? 0.15 : 0.85,
                      minHeight: '4px',
                    }} />
                    <span className="text-base leading-none">{EMOTIONAL_EMOJIS[n]}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Strategy performance */}
          {strategyBreakdown.length > 0 && (
            <div className="rounded-2xl border border-tg-border p-4"
              style={{ background: 'var(--color-tg-surface)' }}>
              <h3 className="text-sm font-semibold text-tg-text mb-3">׳‘׳™׳¦׳•׳¢׳™׳ ׳׳₪׳™ ׳׳¡׳˜׳¨׳˜׳’׳™׳”</h3>
              <div className="flex flex-col gap-0">
                {strategyBreakdown.map(({ name, count, avgRR }, i) => (
                  <div key={name}
                    className={`flex items-center justify-between py-2.5 ${i < strategyBreakdown.length - 1 ? 'border-b border-tg-border' : ''}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-tg-text">{name}</span>
                      <span className="text-xs text-tg-muted">{count} ׳¢׳¡׳§׳׳•׳×</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 rounded-full overflow-hidden"
                        style={{ background: 'var(--color-tg-surface-2)' }}>
                        <div className="h-full rounded-full" style={{
                          width: `${Math.min((avgRR / 3) * 100, 100)}%`,
                          background: avgRR >= 2
                            ? 'var(--color-tg-success)'
                            : avgRR >= 1
                              ? 'var(--color-tg-warning)'
                              : 'var(--color-tg-danger)',
                        }} />
                      </div>
                      <span className="text-sm font-bold w-10 text-left"
                        style={{ color: avgRR >= 2 ? 'var(--color-tg-success)' : avgRR >= 1 ? 'var(--color-tg-warning)' : 'var(--color-tg-danger)' }}>
                        {avgRR.toFixed(1)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Heat map ג€” Pro only */}
          <div className="rounded-2xl border border-tg-border p-4"
            style={{ background: 'var(--color-tg-surface)' }}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-tg-text">׳׳₪׳× ׳—׳•׳ ג€” ׳©׳¢׳•׳× ׳•׳™׳׳™׳</h3>
              <span className="px-2 py-0.5 rounded-full text-xs font-bold"
                style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>Pro</span>
            </div>
            {plan === 'pro' ? (
              <div className="flex items-center justify-center py-6 rounded-xl"
                style={{ background: 'var(--color-tg-surface-2)' }}>
                <p className="text-sm text-tg-text-2">׳׳₪׳× ׳—׳•׳ ג€” ׳‘׳§׳¨׳•׳‘</p>
              </div>
            ) : (
              <div className="flex items-center justify-center py-6 rounded-xl"
                style={{ background: 'var(--color-tg-surface-2)' }}>
                <div className="text-center">
                  <div className="text-2xl mb-1">נ—÷ן¸</div>
                  <p className="text-xs text-tg-muted">׳׳¦׳™׳’ ׳©׳¢׳•׳× ׳—׳•׳׳©׳” ׳•׳©׳™׳ ֲ· ׳–׳׳™׳ ׳‘-Pro</p>
                </div>
              </div>
            )}
          </div>

          {/* Weekly AI summary */}
          <div className="rounded-2xl border border-tg-border p-4"
            style={{ background: 'var(--color-tg-surface)' }}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-tg-text">׳¡׳™׳›׳•׳ ׳©׳‘׳•׳¢׳™ AI</h3>
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold"
                style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-muted)' }}>Basic+</span>
            </div>
            {plan === 'free' ? (
              <div className="flex items-center justify-center py-6 rounded-xl"
                style={{ background: 'var(--color-tg-surface-2)' }}>
                <div className="text-center">
                  <div className="text-2xl mb-1">נ“‹</div>
                  <p className="text-xs text-tg-muted mb-0.5">׳¡׳™׳›׳•׳ ׳׳¡׳₪׳¨׳™ ֲ· ׳“׳₪׳•׳¡ ׳׳¨׳›׳–׳™ ֲ· ׳’׳¨׳£ ׳”׳×׳§׳“׳׳•׳×</p>
                  <p className="text-xs font-medium" style={{ color: 'var(--color-tg-primary)' }}>׳–׳׳™׳ ׳‘-Basic ׳•׳׳¢׳׳”</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {[
                  '׳¡׳™׳›׳•׳ ׳׳¡׳₪׳¨׳™ + ׳“׳₪׳•׳¡ ׳׳¨׳›׳–׳™',
                  plan === 'pro' ? '׳”׳©׳•׳•׳׳” ׳׳©׳‘׳•׳¢׳•׳× ׳§׳•׳“׳׳™׳ + ׳¦׳™׳˜׳•׳˜ ׳׳”׳¡׳•׳—׳¨' : '׳”׳׳׳¦׳” ׳›׳׳׳™׳×',
                  '׳’׳¨׳£ ׳”׳×׳§׳“׳׳•׳× ׳©׳‘׳•׳¢׳™׳×',
                  plan === 'pro' ? '׳©׳¢׳•׳× ׳”׳—׳•׳׳©׳” ׳”׳©׳‘׳•׳¢׳™׳•׳×' : null,
                ].filter(Boolean).map((item) => (
                  <div key={item} className="flex items-center gap-2 text-xs text-tg-text-2">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-tg-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    {item}
                  </div>
                ))}
                <div className="mt-2 px-3 py-2 rounded-xl text-xs text-tg-muted text-center"
                  style={{ background: 'var(--color-tg-surface-2)' }}>
                  ׳ ׳©׳׳— ׳›׳ ׳™׳•׳ ׳¨׳׳©׳•׳ ׳‘׳‘׳•׳§׳¨
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CompareCell({ label, current, delta, suffix }: {
  label: string;
  current: number;
  delta: number;
  suffix: string;
}) {
  const isPositive = delta > 0;
  const isZero = delta === 0;
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--color-tg-surface-2)' }}>
      <p className="text-xs text-tg-muted mb-1">{label}</p>
      <p className="text-lg font-bold text-tg-text">{current}{suffix}</p>
      {!isZero && (
        <p className="text-xs mt-0.5 flex items-center gap-0.5"
          style={{ color: isPositive ? 'var(--color-tg-success)' : 'var(--color-tg-danger)' }}>
          {isPositive ? 'ג–²' : 'ג–¼'} {Math.abs(delta)}{suffix} ׳׳¢׳•׳׳× ׳©׳‘׳•׳¢ ׳©׳¢׳‘׳¨
        </p>
      )}
      {isZero && <p className="text-xs text-tg-muted mt-0.5">׳–׳”׳” ׳׳©׳‘׳•׳¢ ׳©׳¢׳‘׳¨</p>}
    </div>
  );
}

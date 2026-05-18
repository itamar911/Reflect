'use client';

import { useState, useMemo } from 'react';

type Plan = 'free' | 'basic' | 'pro';

interface SimpleTrade {
  strategy: string;
  emotional_state: number;
  rr_ratio: number;
  submitted_at: string;
  status?: string;
  entry_price?: number;
  exit_price?: number | null;
  stop_loss?: number;
}

interface PerformanceSectionProps {
  trades: SimpleTrade[];
  plan: Plan;
}

type BasicFilter = 'day' | '3days' | 'week' | '2weeks';
type ProFilter = BasicFilter | '30days' | '90days' | 'year';

const BASIC_FILTERS: { key: BasicFilter; label: string }[] = [
  { key: 'day', label: 'יום' },
  { key: '3days', label: '3 ימים' },
  { key: 'week', label: 'שבוע' },
  { key: '2weeks', label: 'שבועיים' },
];

const PRO_EXTRA_FILTERS: { key: ProFilter; label: string }[] = [
  { key: '30days', label: '30 יום' },
  { key: '90days', label: '90 יום' },
  { key: 'year', label: 'שנה' },
];

const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];

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

function isWin(t: SimpleTrade) {
  if (t.status !== 'closed' || t.exit_price == null) return null;
  if (t.stop_loss != null) return t.exit_price > t.stop_loss;
  return t.exit_price > (t.entry_price ?? 0);
}

const EMOTIONAL_EMOJIS: Record<number, string> = { 1: '😰', 2: '😟', 3: '😐', 4: '🙂', 5: '😎' };
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
    const map: Record<string, { count: number; totalRR: number; wins: number; closed: number }> = {};
    for (const t of filtered) {
      const s = t.strategy || 'אחר';
      if (!map[s]) map[s] = { count: 0, totalRR: 0, wins: 0, closed: 0 };
      map[s].count++;
      map[s].totalRR += t.rr_ratio || 0;
      const w = isWin(t);
      if (w !== null) {
        map[s].closed++;
        if (w) map[s].wins++;
      }
    }
    return Object.entries(map)
      .map(([name, v]) => ({
        name,
        count: v.count,
        avgRR: v.count > 0 ? v.totalRR / v.count : 0,
        winRate: v.closed > 0 ? Math.round((v.wins / v.closed) * 100) : null,
      }))
      .sort((a, b) => b.count - a.count);
  }, [filtered]);

  // Week-over-week
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
    ? thisWeek.reduce((s, t) => s + (t.rr_ratio || 0), 0) / thisWeek.length : 0;
  const prevWeekAvgRR = prevWeekTrades.length > 0
    ? prevWeekTrades.reduce((s, t) => s + (t.rr_ratio || 0), 0) / prevWeekTrades.length : 0;
  const rrDelta = thisWeekAvgRR - prevWeekAvgRR;

  // Heat map data
  const heatData = useMemo(() => {
    const grid: Record<string, { wins: number; losses: number }> = {};
    for (const t of filtered) {
      const w = isWin(t);
      if (w === null) continue;
      const d = new Date(t.submitted_at);
      const day = d.getDay();
      const hour = d.getHours();
      const key = `${day}-${hour}`;
      if (!grid[key]) grid[key] = { wins: 0, losses: 0 };
      if (w) grid[key].wins++;
      else grid[key].losses++;
    }
    return grid;
  }, [filtered]);

  if (trades.length === 0) return null;

  return (
    <div className="flex flex-col gap-5">
      {/* Filter tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-none">
        {allFilters.map(({ key, label }) => (
          <button key={key} onClick={() => setFilter(key)}
            className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all duration-150"
            style={{
              background: filter === key ? 'var(--color-tg-primary)' : 'var(--color-tg-surface)',
              borderColor: filter === key ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
              color: filter === key ? '#000' : 'var(--color-tg-text-2)',
            }}>
            {label}
          </button>
        ))}
        {plan !== 'pro' && (
          <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs border"
            style={{ borderColor: 'var(--color-tg-border)', color: 'var(--color-tg-muted)' }}>
            30/90/שנה
            <span className="font-bold" style={{ color: '#f59e0b' }}>Pro</span>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-6 rounded-2xl border border-tg-border"
          style={{ background: 'var(--color-tg-surface)' }}>
          <p className="text-sm text-tg-text-2">אין עסקאות בטווח הזמן הנבחר</p>
        </div>
      ) : (
        <>
          {/* Week-over-week */}
          {plan !== 'free' && (
            <div className="rounded-2xl border border-tg-border p-4"
              style={{ background: 'var(--color-tg-surface)' }}>
              <h3 className="text-sm font-semibold text-tg-text mb-3">השוואה שבוע מול שבוע</h3>
              <div className="grid grid-cols-2 gap-3">
                <CompareCell label="עסקאות" current={thisWeek.length} delta={weekDelta} suffix="" />
                <CompareCell label="ממוצע R:R" current={parseFloat(thisWeekAvgRR.toFixed(2))} delta={parseFloat(rrDelta.toFixed(2))} suffix="" />
              </div>
            </div>
          )}

          {/* Emotional patterns */}
          <div className="rounded-2xl border border-tg-border p-4"
            style={{ background: 'var(--color-tg-surface)' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-tg-text">דפוסים רגשיים</h3>
              <span className="text-xs text-tg-muted">{filtered.length} עסקאות</span>
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

          {/* Strategy performance — Fix 8: added labels */}
          {strategyBreakdown.length > 0 && (
            <div className="rounded-2xl border border-tg-border p-4"
              style={{ background: 'var(--color-tg-surface)' }}>
              <h3 className="text-sm font-semibold text-tg-text mb-3">ביצועים לפי אסטרטגיה</h3>
              <div className="flex flex-col gap-0">
                {strategyBreakdown.map(({ name, count, avgRR, winRate }, i) => (
                  <div key={name}
                    className={`flex items-center justify-between py-2.5 ${i < strategyBreakdown.length - 1 ? 'border-b border-tg-border' : ''}`}>
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-tg-text">{name}</span>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-tg-muted">{count} עסקאות</span>
                        {winRate !== null && (
                          <span className="text-xs font-medium"
                            style={{ color: winRate >= 60 ? 'var(--color-tg-success)' : winRate >= 40 ? 'var(--color-tg-warning)' : 'var(--color-tg-danger)' }}>
                            {winRate}% הצלחה
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 rounded-full overflow-hidden"
                        style={{ background: 'var(--color-tg-surface-2)' }}>
                        <div className="h-full rounded-full" style={{
                          width: `${Math.min((avgRR / 3) * 100, 100)}%`,
                          background: avgRR >= 2 ? 'var(--color-tg-success)' : avgRR >= 1 ? 'var(--color-tg-warning)' : 'var(--color-tg-danger)',
                        }} />
                      </div>
                      <div className="text-left w-20">
                        <div className="text-xs text-tg-muted leading-none">ממוצע R:R</div>
                        <div className="text-sm font-bold"
                          style={{ color: avgRR >= 2 ? 'var(--color-tg-success)' : avgRR >= 1 ? 'var(--color-tg-warning)' : 'var(--color-tg-danger)' }}>
                          1:{avgRR.toFixed(1)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Heat map — Fix 10: real data */}
          <div className="rounded-2xl border border-tg-border p-4"
            style={{ background: 'var(--color-tg-surface)' }}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-tg-text">מפת חום — שעות וימים</h3>
              {plan !== 'pro' && (
                <span className="px-2 py-0.5 rounded-full text-xs font-bold"
                  style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>Pro</span>
              )}
            </div>
            {plan === 'pro' ? (
              <HeatMap heatData={heatData} />
            ) : (
              <div className="flex items-center justify-center py-6 rounded-xl"
                style={{ background: 'var(--color-tg-surface-2)' }}>
                <div className="text-center">
                  <div className="text-2xl mb-1">🗺️</div>
                  <p className="text-xs text-tg-muted">מציג שעות חולשה ושיא · זמין ב-Pro</p>
                </div>
              </div>
            )}
          </div>

          {/* Weekly AI summary */}
          <div className="rounded-2xl border border-tg-border p-4"
            style={{ background: 'var(--color-tg-surface)' }}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-tg-text">סיכום שבועי AI</h3>
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold"
                style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-muted)' }}>Basic+</span>
            </div>
            {plan === 'free' ? (
              <div className="flex items-center justify-center py-6 rounded-xl"
                style={{ background: 'var(--color-tg-surface-2)' }}>
                <div className="text-center">
                  <div className="text-2xl mb-1">📋</div>
                  <p className="text-xs text-tg-muted mb-0.5">סיכום מספרי · דפוס מרכזי · גרף התקדמות</p>
                  <p className="text-xs font-medium" style={{ color: 'var(--color-tg-primary)' }}>זמין ב-Basic ומעלה</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {[
                  'סיכום מספרי + דפוס מרכזי',
                  plan === 'pro' ? 'השוואה לשבועות קודמים + ציטוט מהסוחר' : 'המלצה כללית',
                  'גרף התקדמות שבועית',
                  plan === 'pro' ? 'שעות החולשה השבועיות' : null,
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
                  נשלח כל יום ראשון בבוקר
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function HeatMap({ heatData }: { heatData: Record<string, { wins: number; losses: number }> }) {
  const visibleHours = HOURS;
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[320px]">
        {/* Hour labels */}
        <div className="flex mb-1" style={{ paddingRight: '36px' }}>
          {visibleHours.map((h) => (
            <div key={h} className="flex-1 text-center text-[9px] text-tg-muted">{h}</div>
          ))}
        </div>
        {/* Grid */}
        {DAYS_HE.map((dayName, day) => (
          <div key={day} className="flex items-center mb-1">
            <div className="text-[9px] text-tg-muted w-9 shrink-0 text-right pl-1">{dayName}</div>
            {visibleHours.map((hour) => {
              const cell = heatData[`${day}-${hour}`];
              const wins = cell?.wins ?? 0;
              const losses = cell?.losses ?? 0;
              const total = wins + losses;
              let bg = 'var(--color-tg-surface-2)';
              let opacity = 0.3;
              if (total > 0) {
                const ratio = wins / total;
                if (ratio >= 0.6) { bg = 'var(--color-tg-success)'; opacity = 0.3 + (ratio - 0.5) * 1.4; }
                else if (ratio <= 0.4) { bg = 'var(--color-tg-danger)'; opacity = 0.3 + (0.5 - ratio) * 1.4; }
                else { bg = 'var(--color-tg-warning)'; opacity = 0.4; }
                opacity = Math.min(opacity, 0.9);
              }
              return (
                <div key={hour} className="flex-1 mx-0.5"
                  title={total > 0 ? `${wins}W / ${losses}L` : ''}
                  style={{
                    height: '18px',
                    borderRadius: '3px',
                    background: bg,
                    opacity: total === 0 ? 0.15 : opacity,
                  }} />
              );
            })}
          </div>
        ))}
        {/* Legend */}
        <div className="flex items-center justify-end gap-3 mt-2">
          {[['var(--color-tg-success)', 'רווח'], ['var(--color-tg-danger)', 'הפסד'], ['var(--color-tg-warning)', 'מעורב']].map(([color, label]) => (
            <div key={label} className="flex items-center gap-1">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: color, opacity: 0.7 }} />
              <span className="text-[10px] text-tg-muted">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CompareCell({ label, current, delta, suffix }: {
  label: string; current: number; delta: number; suffix: string;
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
          {isPositive ? '▲' : '▼'} {Math.abs(delta)}{suffix} לעומת שבוע שעבר
        </p>
      )}
      {isZero && <p className="text-xs text-tg-muted mt-0.5">זהה לשבוע שעבר</p>}
    </div>
  );
}

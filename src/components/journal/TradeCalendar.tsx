'use client';
import { useState, useMemo } from 'react';

interface Trade {
  id: string;
  strategy: string;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  rr_ratio: number;
  emotional_state: number;
  trade_reason: string;
  status: string;
  exit_price: number | null;
  exit_reason: string | null;
  post_trade_notes: string | null;
  debrief_answer: string | null;
  submitted_at: string;
  closed_at: string | null;
  plan_score: number | null;
  actual_pnl: number | null;
}

interface DayData {
  pnl: number;
  tradeCount: number;
  hasViolation: boolean;
}

const HEBREW_MONTHS = [
  'ינואר','פברואר','מרץ','אפריל','מאי','יוני',
  'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר',
];

const DAY_NAMES = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

const PROFIT_BG  = 'rgba(0, 200, 83, 0.22)';
const LOSS_BG    = 'rgba(255, 59, 48, 0.22)';
const NEUTRAL_BG = 'var(--color-tg-surface-2)';
const EMPTY_BG   = 'var(--color-tg-surface)';

const PROFIT_FG  = '#00C853';
const LOSS_FG    = '#FF3B30';
const NEUTRAL_FG = 'var(--color-tg-text-2)';

const CELL_H = 96;
const WEEK_COL = '62px';
const COLS = `repeat(7, 1fr) ${WEEK_COL}`;

function toDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function pnlLabel(pnl: number, decimals = 1): string {
  if (pnl === 0) return '$0';
  return `${pnl > 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(decimals)}`;
}

function pnlColor(pnl: number): string {
  return pnl > 0 ? PROFIT_FG : pnl < 0 ? LOSS_FG : NEUTRAL_FG;
}

export default function TradeCalendar({ trades }: { trades: Trade[] }) {
  const today = new Date();
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

  const dailyMap = useMemo<Map<string, DayData>>(() => {
    const map = new Map<string, DayData>();
    for (const t of trades) {
      const key  = toDayKey(new Date(t.submitted_at));
      const prev = map.get(key) ?? { pnl: 0, tradeCount: 0, hasViolation: false };
      const pnl  = t.actual_pnl ?? 0;
      const violation =
        t.emotional_state <= 2 || (t.plan_score != null && t.plan_score < 70);
      map.set(key, {
        pnl:          prev.pnl + pnl,
        tradeCount:   prev.tradeCount + 1,
        hasViolation: prev.hasViolation || violation,
      });
    }
    return map;
  }, [trades]);

  const stats = useMemo(() => {
    let pnl = 0, days = 0, total = 0;
    for (const [key, d] of dailyMap) {
      const [y, m] = key.split('-').map(Number);
      if (y === year && m === month + 1) { pnl += d.pnl; days++; total += d.tradeCount; }
    }
    return { pnl, days, total };
  }, [dailyMap, year, month]);

  const weeks = useMemo(() => {
    const startDow = new Date(year, month, 1).getDay();
    const numDays  = new Date(year, month + 1, 0).getDate();
    const cells: (number | null)[] = [
      ...Array<null>(startDow).fill(null),
      ...Array.from({ length: numDays }, (_, i) => i + 1),
    ];
    while (cells.length % 7 !== 0) cells.push(null);

    return Array.from({ length: cells.length / 7 }, (_, wi) => {
      const slice = cells.slice(wi * 7, wi * 7 + 7);
      let wPnl = 0, wTrades = 0;
      for (const d of slice) {
        if (!d) continue;
        const data = dailyMap.get(`${year}-${month + 1}-${d}`);
        if (data) { wPnl += data.pnl; wTrades += data.tradeCount; }
      }
      return { days: slice, pnl: wPnl, trades: wTrades };
    });
  }, [year, month, dailyMap]);

  function navMonth(dir: 1 | -1) {
    const d = new Date(year, month + dir, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  }

  const todayKey = toDayKey(today);

  return (
    <div dir="rtl" className="flex flex-col gap-3">

      {/* ── Monthly stats bar ───────────────────────────────── */}
      <div
        className="flex rounded-2xl overflow-hidden"
        style={{ background: 'var(--color-tg-surface)' }}
      >
        {[
          { label: 'רווח / הפסד', value: pnlLabel(stats.pnl, 2), color: pnlColor(stats.pnl) },
          { label: 'עסקאות',      value: String(stats.total),       color: 'var(--color-tg-text)' },
          { label: 'ימי מסחר',    value: String(stats.days),        color: 'var(--color-tg-text)' },
        ].map(({ label, value, color }, i) => (
          <div
            key={label}
            className="flex-1 flex flex-col items-center justify-center py-4 gap-1"
            style={{
              borderRight: i > 0 ? '1px solid var(--color-tg-border)' : undefined,
            }}
          >
            <span className="text-[10px] font-medium" style={{ color: 'var(--color-tg-muted)' }}>
              {label}
            </span>
            <span className="text-lg font-bold leading-none" style={{ color }}>
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* ── Month navigation ────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-1"
        style={{ direction: 'ltr' }}
      >
        <button
          onClick={() => navMonth(-1)}
          className="w-10 h-10 flex items-center justify-center rounded-xl text-lg font-bold transition-opacity hover:opacity-60 active:scale-95"
          style={{ background: 'var(--color-tg-surface)', color: 'var(--color-tg-text-2)' }}
        >
          «
        </button>

        <h2
          className="text-2xl font-bold tracking-tight"
          style={{ direction: 'rtl', color: 'var(--color-tg-text)' }}
        >
          {HEBREW_MONTHS[month]}&nbsp;{year}
        </h2>

        <button
          onClick={() => navMonth(1)}
          className="w-10 h-10 flex items-center justify-center rounded-xl text-lg font-bold transition-opacity hover:opacity-60 active:scale-95"
          style={{ background: 'var(--color-tg-surface)', color: 'var(--color-tg-text-2)' }}
        >
          »
        </button>
      </div>

      {/* ── Calendar grid — horizontally scrollable on mobile ──── */}
      <div
        className="overflow-x-auto md:overflow-visible"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
      <div
        className="rounded-2xl overflow-hidden flex flex-col gap-px"
        style={{ background: 'var(--color-tg-border)', minWidth: 480 }}
      >

        {/* Day-name header */}
        <div className="grid gap-px" style={{ gridTemplateColumns: COLS }}>
          {DAY_NAMES.map((name) => (
            <div
              key={name}
              className="py-2.5 text-center text-[10px] font-semibold tracking-wide"
              style={{ background: 'var(--color-tg-surface)', color: 'var(--color-tg-muted)' }}
            >
              {name}
            </div>
          ))}
          <div
            className="py-2.5 text-center text-[9px] font-semibold"
            style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-muted)' }}
          >
            שבוע
          </div>
        </div>

        {/* Week rows */}
        {weeks.map((week, wi) => (
          <div key={wi} className="grid gap-px" style={{ gridTemplateColumns: COLS }}>

            {week.days.map((day, di) => {
              /* Padding / non-month cell */
              if (!day) {
                return (
                  <div
                    key={di}
                    style={{ height: CELL_H, background: EMPTY_BG }}
                  />
                );
              }

              const key   = `${year}-${month + 1}-${day}`;
              const data  = dailyMap.get(key);
              const isToday = key === todayKey;

              const bg = data
                ? data.pnl > 0  ? PROFIT_BG
                : data.pnl < 0  ? LOSS_BG
                : NEUTRAL_BG
                : EMPTY_BG;

              return (
                <div
                  key={di}
                  className="flex flex-col"
                  style={{ height: CELL_H, background: bg }}
                >
                  {/* Top row: day number + violation dot */}
                  <div className="flex items-start justify-between px-1.5 pt-1.5">
                    <span
                      className="text-[11px] font-semibold leading-none"
                      style={{
                        color: isToday
                          ? 'var(--color-tg-primary)'
                          : 'var(--color-tg-muted)',
                        fontWeight: isToday ? 800 : 600,
                      }}
                    >
                      {day}
                    </span>
                    {data?.hasViolation && (
                      <span
                        className="w-2 h-2 rounded-full shrink-0 mt-0.5"
                        style={{ background: 'var(--color-tg-danger)' }}
                      />
                    )}
                  </div>

                  {/* Center: P&L + trade count */}
                  {data ? (
                    <div className="flex-1 flex flex-col items-center justify-center gap-0.5 pb-1">
                      <span
                        className="text-[13px] font-extrabold leading-tight"
                        style={{ color: pnlColor(data.pnl) }}
                      >
                        {pnlLabel(data.pnl, 1)}
                      </span>
                      <span
                        className="text-[9px]"
                        style={{ color: 'var(--color-tg-muted)' }}
                      >
                        ({data.tradeCount})
                      </span>
                    </div>
                  ) : (
                    <div className="flex-1" />
                  )}
                </div>
              );
            })}

            {/* Weekly summary column */}
            <div
              className="flex flex-col items-center justify-center gap-1 px-0.5"
              style={{ height: CELL_H, background: 'var(--color-tg-surface-2)' }}
            >
              {week.trades > 0 ? (
                <>
                  <span
                    className="text-[10px] font-bold leading-tight text-center"
                    style={{ color: pnlColor(week.pnl) }}
                  >
                    {pnlLabel(week.pnl, 0)}
                  </span>
                  <span
                    className="text-[8px] leading-none text-center"
                    style={{ color: 'var(--color-tg-muted)' }}
                  >
                    {week.trades}&thinsp;ע׳
                  </span>
                </>
              ) : (
                <span style={{ color: 'var(--color-tg-border-light)', fontSize: '14px' }}>—</span>
              )}
            </div>

          </div>
        ))}
      </div>
      </div>
    </div>
  );
}

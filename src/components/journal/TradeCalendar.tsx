'use client';
import { useState, useMemo } from 'react';
import { tradeMoneyPnl, hasMoneyPnl } from '@/lib/pnl';
import { currentTradingDay, tradingDayOfTrade } from '@/lib/tradingDay';
import { formatMoney } from '@/lib/money';

// Intent columns are nullable — a trade with no plan behind it carries none
// of them (REF-107 §B6).
interface Trade {
  id: string;
  strategy: string | null;
  entry_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  rr_ratio: number | null;
  emotional_state: number | null;
  trade_reason: string | null;
  status: string;
  exit_price: number | null;
  exit_reason: string | null;
  post_trade_notes: string | null;
  debrief_answer: string | null;
  submitted_at: string;
  closed_at: string | null;
  plan_score: number | null;
  pnl_amount: number | null;
  actual_pnl: number | null;
  pnl_currency: string | null;
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

const PROFIT_BG  = 'rgba(0, 200, 83, 0.16)';
const LOSS_BG    = 'rgba(255, 59, 48, 0.16)';
const NEUTRAL_BG = 'var(--color-tg-surface-2)';
const EMPTY_BG   = 'var(--color-tg-surface)';

const PROFIT_FG  = '#00C853';
const LOSS_FG    = '#FF3B30';
const NEUTRAL_FG = 'var(--color-tg-text-2)';

const MIN_CELL_H = 110;
const WEEK_COL = '92px';
const COLS = `repeat(7, 1fr) ${WEEK_COL}`;

/**
 * A cell's key: the trading day it stands for, `YYYY-MM-DD` (REF-125).
 *
 * WAS `toDayKey(d)` = `${y}-${m + 1}-${d}` — UNPADDED, and derived from a local
 * `Date`. Both halves had to go. The padding, because these keys are now
 * compared against lib/tradingDay.ts' output and `2026-10-7` is not
 * `2026-10-07`; the local `Date`, because which bucket a trade lands in must
 * stop being a function of the reader's own clock. `month` is the React-state
 * month, so it is still 0-based here.
 */
function cellKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Large values drop the fraction and gain thousands separators — otherwise
// they overflow the fixed-width day cells and the header stat slots.
//
// A flat day is "$0", not "$0.0": these cells are narrow and a fraction on a
// zero carries nothing. Kept as its own case, exactly as it was before REF-99
// moved the rest of the formatting into lib/money.ts.
function pnlLabel(pnl: number, decimals = 1): string {
  if (pnl === 0) return formatMoney(0, { decimals: 0 });
  return formatMoney(pnl, { decimals, minus: '−', dropFractionAtThousand: true });
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
      // THE CELL A TRADE LANDS IN CHANGED TWICE OVER (REF-125): from the
      // reader's local date to the trading day, and from `submitted_at` to the
      // close. This was the only daily surface in the journal still filing a
      // trade by when its PLAN was logged, so a plan written Monday night and
      // closed Tuesday coloured Monday's cell with Tuesday's money.
      const key  = tradingDayOfTrade(t);
      if (key === null) continue;
      const prev = map.get(key) ?? { pnl: 0, tradeCount: 0, hasViolation: false };
      const pnl  = tradeMoneyPnl(t);
      // A row with no self-report is not a day flagged for low emotional
      // state — `null <= 2` is true in JavaScript, which would have put a
      // warning marker on every day a broker row landed on.
      const violation =
        (t.emotional_state != null && t.emotional_state <= 2) ||
        (t.plan_score != null && t.plan_score < 70);
      map.set(key, {
        pnl:          prev.pnl + pnl,
        tradeCount:   prev.tradeCount + 1,
        hasViolation: prev.hasViolation || violation,
      });
    }
    return map;
  }, [trades]);

  const monthStats = useMemo(() => {
    let totalPnl = 0, totalCount = 0;
    let wins = 0, be = 0, losses = 0;
    let winPnl = 0, lossPnl = 0, closed = 0;
    const tradingDays = new Set<string>();

    // The month filter runs on the trading day too, so the header stats total
    // exactly the cells drawn below them. `monthPrefix` is a string compare
    // against a `YYYY-MM-DD` key, which needs no `Date` and therefore has no
    // zone to get wrong.
    const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    for (const t of trades) {
      const day = tradingDayOfTrade(t);
      if (day === null || !day.startsWith(monthPrefix)) continue;
      totalCount++;
      tradingDays.add(day);

      if (hasMoneyPnl(t)) {
        const pnl = tradeMoneyPnl(t);
        totalPnl += pnl;
        closed++;
        if (pnl > 0)      { wins++;   winPnl  += pnl; }
        else if (pnl < 0) { losses++; lossPnl += pnl; }
        else              { be++; }
      }
    }

    const winRate      = closed > 0 ? (wins / closed) * 100 : 0;
    const profitFactor = lossPnl !== 0
      ? winPnl / Math.abs(lossPnl)
      : (winPnl > 0 ? Infinity : 0);

    return {
      totalPnl, totalCount,
      tradingDays: tradingDays.size,
      winRate, wins, be, losses, profitFactor,
    };
  }, [trades, year, month]);

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
        const data = dailyMap.get(cellKey(year, month, d));
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

  // Which cell gets the "today" ring. The current TRADING day (REF-125), so
  // after 17:00 Chicago — 01:00 in Israel — the ring is already on tomorrow's
  // cell, which is where a trade closed at that hour will appear.
  const todayKey = currentTradingDay(today);

  const pfLabel = monthStats.profitFactor === Infinity
    ? '∞'
    : monthStats.profitFactor.toFixed(2);

  const headerStats = [
    { label: 'רווח/הפסד כולל', value: pnlLabel(monthStats.totalPnl, 2), color: pnlColor(monthStats.totalPnl) },
    { label: 'סה"כ עסקאות',    value: String(monthStats.totalCount),   color: 'var(--color-tg-text)' },
    { label: 'ימי מסחר',       value: String(monthStats.tradingDays),  color: 'var(--color-tg-text)' },
    { label: 'אחוז הצלחה',     value: `${monthStats.winRate.toFixed(0)}%`, color: 'var(--color-tg-text)' },
  ];

  return (
    <div dir="rtl" className="flex flex-col gap-4">

      {/* ── Month navigation ────────────────────────────────── */}
      <div className="flex items-center justify-end gap-2 px-1" style={{ direction: 'ltr' }}>
        <button
          onClick={() => navMonth(-1)}
          className="hit-40 relative w-9 h-9 flex items-center justify-center rounded-xl text-base font-bold transition-opacity hover:opacity-60 active:scale-95"
          style={{ background: 'var(--color-tg-surface)', color: 'var(--color-tg-text-2)' }}
        >
          «
        </button>
        <h2
          className="text-lg font-bold tracking-tight px-1"
          style={{ direction: 'rtl', color: 'var(--color-tg-text)' }}
        >
          {HEBREW_MONTHS[month]}&nbsp;{year}
        </h2>
        <button
          onClick={() => navMonth(1)}
          className="hit-40 relative w-9 h-9 flex items-center justify-center rounded-xl text-base font-bold transition-opacity hover:opacity-60 active:scale-95"
          style={{ background: 'var(--color-tg-surface)', color: 'var(--color-tg-text-2)' }}
        >
          »
        </button>
      </div>

      {/* ── Header stats bar ────────────────────────────────── */}
      {/* 3-per-row below sm — six columns squeeze to ~60px on phones and the
          overflow-hidden container clips long $ totals mid-digit */}
      <div
        className="grid grid-cols-3 sm:grid-cols-6 rounded-2xl overflow-hidden"
        style={{ background: 'var(--color-tg-surface)' }}
      >
        {headerStats.map(({ label, value, color }, i) => (
          <div
            key={label}
            className="flex flex-col items-center justify-center py-3 px-1 gap-1"
            style={{ borderRight: i > 0 ? '1px solid var(--color-tg-border)' : undefined }}
          >
            <span className="text-[9px] font-medium text-center leading-tight" style={{ color: 'var(--color-tg-muted)' }}>
              {label}
            </span>
            <span className="text-sm font-bold leading-none text-center" style={{ color }}>
              {value}
            </span>
          </div>
        ))}

        {/* Wins / BE / Losses breakdown */}
        <div
          className="flex flex-col items-center justify-center py-3 px-1 gap-1"
          style={{ borderRight: '1px solid var(--color-tg-border)' }}
        >
          <span className="text-[9px] font-medium text-center leading-tight" style={{ color: 'var(--color-tg-muted)' }}>
            פילוח עסקאות
          </span>
          <span className="text-sm font-bold leading-none">
            <span style={{ color: PROFIT_FG }}>{monthStats.wins}</span>
            <span style={{ color: 'var(--color-tg-muted)' }}> / </span>
            <span style={{ color: NEUTRAL_FG }}>{monthStats.be}</span>
            <span style={{ color: 'var(--color-tg-muted)' }}> / </span>
            <span style={{ color: LOSS_FG }}>{monthStats.losses}</span>
          </span>
        </div>

        {/* Profit factor */}
        <div
          className="flex flex-col items-center justify-center py-3 px-1 gap-1"
          style={{ borderRight: '1px solid var(--color-tg-border)' }}
        >
          <span className="text-[9px] font-medium text-center leading-tight" style={{ color: 'var(--color-tg-muted)' }}>
            PROFIT FACTOR
          </span>
          <span className="text-sm font-bold leading-none" style={{ color: 'var(--color-tg-text)' }}>
            {pfLabel}
          </span>
        </div>
      </div>

      {/* ── Calendar grid — horizontally scrollable on mobile ──── */}
      <div className="overflow-x-auto md:overflow-visible" style={{ WebkitOverflowScrolling: 'touch' }}>
        <div className="flex flex-col gap-1.5" style={{ minWidth: 640 }}>

          {/* Day-name header (weekday cells + weekly-summary label, summary sits leftmost in RTL) */}
          <div className="grid gap-1.5" style={{ gridTemplateColumns: COLS }}>
            {DAY_NAMES.map((name) => (
              <div
                key={name}
                className="py-2 text-center text-[10px] font-semibold tracking-wide rounded-lg"
                style={{ background: 'var(--color-tg-surface)', color: 'var(--color-tg-muted)' }}
              >
                {name}
              </div>
            ))}
            <div
              className="py-2 text-center text-[9px] font-semibold rounded-lg"
              style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-muted)' }}
            >
              סיכום שבועי
            </div>
          </div>

          {/* Week rows */}
          {weeks.map((week, wi) => (
            <div key={wi} className="grid gap-1.5" style={{ gridTemplateColumns: COLS }}>

              {week.days.map((day, di) => {
                /* Padding / non-month cell */
                if (!day) {
                  return (
                    <div
                      key={di}
                      className="rounded-xl"
                      style={{ minHeight: MIN_CELL_H, background: EMPTY_BG }}
                    />
                  );
                }

                const key   = cellKey(year, month, day);
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
                    className="relative flex flex-col items-center justify-center rounded-xl"
                    style={{ minHeight: MIN_CELL_H, background: bg }}
                  >
                    {/* Day number — top-right corner */}
                    <span
                      className="absolute top-1.5 right-1.5 text-[10px] leading-none"
                      style={{
                        color: isToday ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                        fontWeight: isToday ? 800 : 500,
                      }}
                    >
                      {day}
                    </span>

                    {/* Center: P&L + trade count */}
                    {data && (
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="text-sm font-extrabold leading-tight" style={{ color: pnlColor(data.pnl) }}>
                          {pnlLabel(data.pnl, 1)}
                        </span>
                        <span className="text-[10px]" style={{ color: 'var(--color-tg-muted)' }}>
                          {data.tradeCount} עסקאות
                        </span>
                      </div>
                    )}

                    {/* Violation dot — bottom-right corner */}
                    {data?.hasViolation && (
                      <span
                        className="absolute bottom-1.5 right-1.5 w-2 h-2 rounded-full"
                        style={{ background: 'var(--color-tg-danger)' }}
                      />
                    )}
                  </div>
                );
              })}

              {/* Weekly summary column */}
              <div
                className="flex flex-col items-center justify-center gap-0.5 rounded-xl px-1"
                style={{ minHeight: MIN_CELL_H, background: 'var(--color-tg-surface-2)' }}
              >
                <span className="text-[10px] font-bold" style={{ color: 'var(--color-tg-text-2)' }}>
                  שבוע {wi + 1}
                </span>
                {week.trades > 0 ? (
                  <>
                    <span className="text-[11px] font-bold leading-tight text-center" style={{ color: pnlColor(week.pnl) }}>
                      {pnlLabel(week.pnl, 0)}
                    </span>
                    <span className="text-[9px] leading-none text-center" style={{ color: 'var(--color-tg-muted)' }}>
                      {week.trades} עסקאות
                    </span>
                  </>
                ) : (
                  <span style={{ color: 'var(--color-tg-border-light)', fontSize: '13px' }}>—</span>
                )}
              </div>

            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

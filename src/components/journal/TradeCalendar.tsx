'use client';
import { useState, useMemo } from 'react';
import { tradeMoneyPnl, hasMoneyPnl } from '@/lib/pnl';

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

function toDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function pnlLabel(pnl: number, decimals = 1, currency = '₪'): string {
  if (pnl === 0) return `${currency}0`;
  return `${pnl > 0 ? '+' : '−'}${currency}${Math.abs(pnl).toFixed(decimals)}`;
}

function pnlColor(pnl: number): string {
  return pnl > 0 ? PROFIT_FG : pnl < 0 ? LOSS_FG : NEUTRAL_FG;
}

export default function TradeCalendar({ trades }: { trades: Trade[] }) {
  const today = new Date();
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [view, setView]   = useState<'monthly' | 'yearly'>('monthly');

  // Display currency — same rule as the All Trades summary: a single uniform
  // trade currency wins, anything mixed (or no money data) falls back to ₪.
  const currency = useMemo(() => {
    const set = new Set(trades.filter(hasMoneyPnl).map(t => t.pnl_currency ?? '₪'));
    return set.size === 1 ? [...set][0] : '₪';
  }, [trades]);

  const dailyMap = useMemo<Map<string, DayData>>(() => {
    const map = new Map<string, DayData>();
    for (const t of trades) {
      const key  = toDayKey(new Date(t.submitted_at));
      const prev = map.get(key) ?? { pnl: 0, tradeCount: 0, hasViolation: false };
      const pnl  = tradeMoneyPnl(t);
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

  const monthStats = useMemo(() => {
    let totalPnl = 0, totalCount = 0;
    let wins = 0, be = 0, losses = 0;
    let winPnl = 0, lossPnl = 0, closed = 0;
    const tradingDays = new Set<string>();

    for (const t of trades) {
      const d = new Date(t.submitted_at);
      if (d.getFullYear() !== year || d.getMonth() !== month) continue;
      totalCount++;
      tradingDays.add(toDayKey(d));

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

  const pfLabel = monthStats.profitFactor === Infinity
    ? '∞'
    : monthStats.profitFactor.toFixed(2);

  const headerStats = [
    { label: 'רווח/הפסד כולל', value: pnlLabel(monthStats.totalPnl, 2, currency), color: pnlColor(monthStats.totalPnl) },
    { label: 'סה"כ עסקאות',    value: String(monthStats.totalCount),   color: 'var(--color-tg-text)' },
    { label: 'ימי מסחר',       value: String(monthStats.tradingDays),  color: 'var(--color-tg-text)' },
    { label: 'אחוז הצלחה',     value: `${monthStats.winRate.toFixed(0)}%`, color: 'var(--color-tg-text)' },
  ];

  return (
    <div dir="rtl" className="flex flex-col gap-4">

      {/* ── Month navigation + view toggle ──────────────────── */}
      <div className="flex items-center justify-end gap-3 px-1">
        <div className="flex rounded-full p-0.5" style={{ background: 'var(--color-tg-surface)' }}>
          <button
            onClick={() => setView('monthly')}
            className="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors"
            style={{
              background: view === 'monthly' ? 'var(--color-tg-primary)' : 'transparent',
              color:      view === 'monthly' ? '#fff' : 'var(--color-tg-muted)',
            }}
          >
            חודשי
          </button>
          <button
            onClick={() => setView('yearly')}
            className="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors"
            style={{
              background: view === 'yearly' ? 'var(--color-tg-primary)' : 'transparent',
              color:      view === 'yearly' ? '#fff' : 'var(--color-tg-muted)',
            }}
          >
            שנתי
          </button>
        </div>

        <div className="flex items-center gap-2" style={{ direction: 'ltr' }}>
          <button
            onClick={() => navMonth(-1)}
            className="w-9 h-9 flex items-center justify-center rounded-xl text-base font-bold transition-opacity hover:opacity-60 active:scale-95"
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
            className="w-9 h-9 flex items-center justify-center rounded-xl text-base font-bold transition-opacity hover:opacity-60 active:scale-95"
            style={{ background: 'var(--color-tg-surface)', color: 'var(--color-tg-text-2)' }}
          >
            »
          </button>
        </div>
      </div>

      {/* ── Header stats bar ────────────────────────────────── */}
      <div
        className="grid grid-cols-6 rounded-2xl overflow-hidden"
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
                          {pnlLabel(data.pnl, 1, currency)}
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
                      {pnlLabel(week.pnl, 0, currency)}
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

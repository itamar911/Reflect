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
}

interface DayData {
  pnl: number;
  tradeCount: number;
  hasViolation: boolean;
}

const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];
// Sunday=א through Saturday=ש
const DAY_LABELS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

function toDayKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export default function TradeCalendar({ trades }: { trades: Trade[] }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

  const dailyMap = useMemo<Map<string, DayData>>(() => {
    const map = new Map<string, DayData>();
    for (const t of trades) {
      const key = toDayKey(new Date(t.submitted_at));
      const prev = map.get(key) ?? { pnl: 0, tradeCount: 0, hasViolation: false };
      const pnl =
        t.status === 'closed' && t.exit_price != null ? t.exit_price - t.entry_price : 0;
      const violation =
        t.emotional_state <= 2 || (t.plan_score != null && t.plan_score < 70);
      map.set(key, {
        pnl: prev.pnl + pnl,
        tradeCount: prev.tradeCount + 1,
        hasViolation: prev.hasViolation || violation,
      });
    }
    return map;
  }, [trades]);

  const stats = useMemo(() => {
    let pnl = 0, days = 0, total = 0;
    for (const [key, d] of dailyMap) {
      const parts = key.split('-');
      if (Number(parts[0]) === year && Number(parts[1]) === month + 1) {
        pnl += d.pnl;
        days++;
        total += d.tradeCount;
      }
    }
    return { pnl, days, total };
  }, [dailyMap, year, month]);

  const weeks = useMemo(() => {
    const startDow = new Date(year, month, 1).getDay();
    const numDays = new Date(year, month + 1, 0).getDate();
    const cells: (number | null)[] = [
      ...Array<null>(startDow).fill(null),
      ...Array.from({ length: numDays }, (_, i) => i + 1),
    ];
    while (cells.length % 7 !== 0) cells.push(null);

    const result: { days: (number | null)[]; pnl: number; trades: number }[] = [];
    for (let i = 0; i < cells.length; i += 7) {
      const slice = cells.slice(i, i + 7);
      let wPnl = 0, wTrades = 0;
      for (const d of slice) {
        if (!d) continue;
        const data = dailyMap.get(`${year}-${month + 1}-${d}`);
        if (data) { wPnl += data.pnl; wTrades += data.tradeCount; }
      }
      result.push({ days: slice, pnl: wPnl, trades: wTrades });
    }
    return result;
  }, [year, month, dailyMap]);

  function navMonth(dir: 1 | -1) {
    const d = new Date(year, month + dir, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  }

  const todayKey = toDayKey(today);
  const statPnlColor =
    stats.pnl > 0
      ? 'var(--color-tg-success)'
      : stats.pnl < 0
      ? 'var(--color-tg-danger)'
      : 'var(--color-tg-text-2)';

  return (
    <div dir="rtl" className="flex flex-col gap-3">
      {/* Monthly totals */}
      <div className="grid grid-cols-3 gap-2">
        <StatBox label="רווח/הפסד" value={`${stats.pnl > 0 ? '+' : ''}${stats.pnl.toFixed(2)}`}
          sub="נק'" valueColor={statPnlColor} />
        <StatBox label="עסקאות" value={String(stats.total)} />
        <StatBox label="ימי מסחר" value={String(stats.days)} />
      </div>

      {/* Month navigation — use ltr container so ‹/› stay on correct sides */}
      <div className="flex items-center" style={{ direction: 'ltr' }}>
        <button
          onClick={() => navMonth(-1)}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-base transition-opacity hover:opacity-70"
          style={{ color: 'var(--color-tg-text-2)', background: 'var(--color-tg-surface)' }}
        >
          ‹
        </button>
        <h2 className="flex-1 text-center text-sm font-bold text-tg-text" style={{ direction: 'rtl' }}>
          {HEBREW_MONTHS[month]} {year}
        </h2>
        <button
          onClick={() => navMonth(1)}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-base transition-opacity hover:opacity-70"
          style={{ color: 'var(--color-tg-text-2)', background: 'var(--color-tg-surface)' }}
        >
          ›
        </button>
      </div>

      {/* Calendar grid */}
      <div
        className="rounded-2xl overflow-hidden border"
        style={{ borderColor: 'var(--color-tg-border)', background: 'var(--color-tg-surface)' }}
      >
        {/* Day-of-week headers — 7 equal cols + 44px summary col on left */}
        <div
          className="grid border-b"
          style={{ gridTemplateColumns: 'repeat(7, 1fr) 44px', borderColor: 'var(--color-tg-border)' }}
        >
          {DAY_LABELS.map((l) => (
            <div key={l} className="py-2 text-center text-[10px] font-medium"
              style={{ color: 'var(--color-tg-muted)' }}>
              {l}
            </div>
          ))}
          <div className="py-2 text-center text-[10px] font-medium"
            style={{ color: 'var(--color-tg-muted)', background: 'var(--color-tg-surface-2)' }}>
            שבוע
          </div>
        </div>

        {/* Week rows */}
        {weeks.map((week, wi) => (
          <div
            key={wi}
            className="grid border-b last:border-b-0"
            style={{ gridTemplateColumns: 'repeat(7, 1fr) 44px', borderColor: 'var(--color-tg-border)' }}
          >
            {week.days.map((day, di) => {
              if (!day) {
                return (
                  <div
                    key={di}
                    className="h-[58px] border-r"
                    style={{ borderColor: 'var(--color-tg-border)', background: 'var(--color-tg-bg)' }}
                  />
                );
              }
              const key = `${year}-${month + 1}-${day}`;
              const data = dailyMap.get(key);
              const isToday = key === todayKey;
              const isProfit = data && data.pnl > 0;
              const isLoss = data && data.pnl < 0;
              const cellBg = data
                ? isProfit
                  ? 'rgba(0, 200, 83, 0.10)'
                  : isLoss
                  ? 'rgba(255, 59, 48, 0.09)'
                  : 'var(--color-tg-surface-2)'
                : 'transparent';
              const pnlColor = isProfit
                ? 'var(--color-tg-success)'
                : isLoss
                ? 'var(--color-tg-danger)'
                : 'var(--color-tg-text-2)';

              return (
                <div
                  key={di}
                  className="h-[58px] p-1.5 border-r flex flex-col justify-between"
                  style={{ borderColor: 'var(--color-tg-border)', background: cellBg }}
                >
                  {/* Day number + violation dot */}
                  <div className="flex items-center justify-between">
                    <span
                      className="text-[10px] font-semibold leading-none"
                      style={{ color: isToday ? 'var(--color-tg-primary)' : 'var(--color-tg-text-2)' }}
                    >
                      {day}
                    </span>
                    {data?.hasViolation && (
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: 'var(--color-tg-danger)' }}
                      />
                    )}
                  </div>

                  {/* P&L and trade count */}
                  {data && (
                    <div className="flex flex-col gap-px">
                      <span className="text-[9px] font-bold leading-none" style={{ color: pnlColor }}>
                        {isProfit ? '+' : ''}{data.pnl.toFixed(1)}
                      </span>
                      <span className="text-[8px] leading-none" style={{ color: 'var(--color-tg-muted)' }}>
                        {data.tradeCount} ע׳
                      </span>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Weekly summary column */}
            <div
              className="h-[58px] flex flex-col items-center justify-center gap-0.5"
              style={{ background: 'var(--color-tg-surface-2)' }}
            >
              {week.trades > 0 ? (
                <>
                  <span
                    className="text-[9px] font-bold leading-none"
                    style={{
                      color:
                        week.pnl > 0
                          ? 'var(--color-tg-success)'
                          : week.pnl < 0
                          ? 'var(--color-tg-danger)'
                          : 'var(--color-tg-text-2)',
                    }}
                  >
                    {week.pnl > 0 ? '+' : ''}{week.pnl.toFixed(1)}
                  </span>
                  <span className="text-[8px] leading-none" style={{ color: 'var(--color-tg-muted)' }}>
                    {week.trades} ע׳
                  </span>
                </>
              ) : (
                <span className="text-[9px]" style={{ color: 'var(--color-tg-border-light)' }}>
                  —
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatBox({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
}) {
  return (
    <div
      className="rounded-xl p-3 text-center"
      style={{ background: 'var(--color-tg-surface)' }}
    >
      <p className="text-[10px] mb-1" style={{ color: 'var(--color-tg-muted)' }}>
        {label}
      </p>
      <p className="text-sm font-bold leading-none" style={{ color: valueColor ?? 'var(--color-tg-text)' }}>
        {value}
        {sub && (
          <span className="text-[9px] font-normal mr-0.5" style={{ color: 'var(--color-tg-muted)' }}>
            {sub}
          </span>
        )}
      </p>
    </div>
  );
}

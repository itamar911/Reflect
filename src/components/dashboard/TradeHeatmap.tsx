'use client';

import { useState } from 'react';
import Card from '@/components/ui/Card';

const DAYS_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const DAYS_FULL  = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

interface Trade {
  status: string;
  entry_price: number;
  exit_price: number | null;
  submitted_at: string;
}

interface CellData { pl: number; count: number }

interface TooltipState {
  day: number; hour: number; pl: number; count: number;
  x: number; y: number;
}

export default function TradeHeatmap({ trades }: { trades: Trade[] }) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  // Build 7 × 24 grid [dayOfWeek][hour]
  const grid: CellData[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ pl: 0, count: 0 }))
  );

  for (const t of trades) {
    if (t.status !== 'closed' || t.exit_price === null) continue;
    const d = new Date(t.submitted_at);
    const day  = d.getDay();
    const hour = d.getHours();
    grid[day][hour].pl    += Number(t.exit_price) - t.entry_price;
    grid[day][hour].count += 1;
  }

  // Max absolute P&L for intensity normalisation
  let maxAbs = 0;
  for (const row of grid)
    for (const cell of row)
      if (Math.abs(cell.pl) > maxAbs) maxAbs = Math.abs(cell.pl);

  function cellColor(cell: CellData): string {
    if (cell.count === 0) return 'rgba(26,37,53,0.55)';
    const intensity = maxAbs > 0 ? Math.min(1, Math.abs(cell.pl) / maxAbs) : 0.4;
    const alpha = (0.18 + intensity * 0.82).toFixed(2);
    if (cell.pl > 0) return `rgba(0,200,83,${alpha})`;
    if (cell.pl < 0) return `rgba(255,59,48,${alpha})`;
    return 'rgba(100,116,139,0.35)';
  }

  function cellBorder(cell: CellData): string {
    if (cell.count === 0) return '1px solid rgba(255,255,255,0.03)';
    return cell.pl > 0
      ? '1px solid rgba(0,200,83,0.2)'
      : '1px solid rgba(255,59,48,0.2)';
  }

  const hasTrades = grid.some(row => row.some(c => c.count > 0));

  function handleEnter(e: React.MouseEvent, day: number, hour: number, cell: CellData) {
    if (cell.count === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ day, hour, pl: cell.pl, count: cell.count, x: rect.left, y: rect.top });
  }

  return (
    <Card padding="sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div>
          <h3 className="text-sm font-semibold text-tg-text">מפת חום — שעות מסחר</h3>
          <p className="text-[10px] text-tg-muted mt-0.5">P&L לפי יום ושעה</p>
        </div>
        {hasTrades && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-sm" style={{ background: 'rgba(255,59,48,0.8)' }} />
              <span className="text-[9px] text-tg-muted">הפסד</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-sm" style={{ background: 'rgba(0,200,83,0.8)' }} />
              <span className="text-[9px] text-tg-muted">רווח</span>
            </div>
          </div>
        )}
      </div>

      {!hasTrades ? (
        <p className="text-xs text-tg-muted px-1 pb-1">נדרשות עסקאות סגורות להצגת מפת החום</p>
      ) : (
        /* Force LTR so hour axis runs 0→23 regardless of RTL locale */
        <div className="overflow-x-auto scrollbar-none" dir="ltr">
          <div style={{ minWidth: 340 }}>

            {/* Hour axis labels — show at 0, 6, 12, 18, 23 */}
            <div className="flex items-end mb-1" style={{ paddingLeft: 28 }}>
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="flex-shrink-0 text-center"
                  style={{ width: 13, fontSize: 8, color: 'var(--color-tg-muted)', lineHeight: 1 }}>
                  {h % 6 === 0 || h === 23 ? h : ''}
                </div>
              ))}
            </div>

            {/* Grid rows */}
            {grid.map((row, day) => (
              <div key={day} className="flex items-center" style={{ marginBottom: 2 }}>
                {/* Day label */}
                <div className="flex-shrink-0 text-center"
                  style={{ width: 28, fontSize: 9, color: 'var(--color-tg-muted)' }}>
                  {DAYS_SHORT[day]}
                </div>

                {/* Hour cells */}
                {row.map((cell, hour) => (
                  <div
                    key={hour}
                    className="flex-shrink-0 rounded-sm transition-transform duration-100"
                    style={{
                      width: 12,
                      height: 18,
                      marginRight: 1,
                      background: cellColor(cell),
                      border: cellBorder(cell),
                      cursor: cell.count > 0 ? 'crosshair' : 'default',
                      transform: tooltip?.day === day && tooltip?.hour === hour ? 'scale(1.3)' : 'scale(1)',
                      zIndex: tooltip?.day === day && tooltip?.hour === hour ? 10 : 'auto',
                      position: 'relative',
                    }}
                    onMouseEnter={(e) => handleEnter(e, day, hour, cell)}
                    onMouseLeave={() => setTooltip(null)}
                  />
                ))}
              </div>
            ))}

            {/* Intensity scale */}
            <div className="flex items-center gap-1 mt-2" style={{ paddingLeft: 28 }}>
              <span style={{ fontSize: 8, color: 'var(--color-tg-muted)' }}>פחות</span>
              {[0.15, 0.32, 0.5, 0.68, 0.85, 1].map((a) => (
                <div key={a} className="rounded-sm flex-shrink-0"
                  style={{ width: 10, height: 8, background: `rgba(0,200,83,${a})` }} />
              ))}
              <span style={{ fontSize: 8, color: 'var(--color-tg-muted)' }}>יותר</span>
            </div>
          </div>
        </div>
      )}

      {/* Tooltip — fixed to viewport */}
      {tooltip && (
        <div
          className="fixed pointer-events-none animate-fade-in"
          style={{
            left: Math.min(tooltip.x + 16, (typeof window !== 'undefined' ? window.innerWidth : 400) - 148),
            top: Math.max(tooltip.y - 76, 8),
            zIndex: 9999,
            background: 'rgba(10,10,15,0.97)',
            border: '1px solid rgba(245,197,24,0.28)',
            borderRadius: 8,
            padding: '7px 11px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.7), 0 0 12px rgba(245,197,24,0.06)',
            minWidth: 132,
          }}
        >
          <p className="font-semibold text-tg-text" style={{ fontSize: 11 }}>
            {DAYS_FULL[tooltip.day]}, {String(tooltip.hour).padStart(2, '0')}:00–{String(tooltip.hour + 1).padStart(2, '0')}:00
          </p>
          <p style={{ fontSize: 12, fontWeight: 700, color: tooltip.pl >= 0 ? '#00C853' : '#FF3B30', marginTop: 2 }}>
            {tooltip.pl >= 0 ? '+' : ''}${tooltip.pl.toFixed(2)}
          </p>
          <p className="text-tg-muted" style={{ fontSize: 10, marginTop: 1 }}>
            {tooltip.count} {tooltip.count === 1 ? 'עסקה' : 'עסקאות'}
          </p>
        </div>
      )}
    </Card>
  );
}

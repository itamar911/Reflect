import { MockFrame } from './MockFrame';

type Cell = 'g' | 'r' | 'n';

// Fixed, pleasant demo pattern — 7 cols × 4 rows. No real dates.
const PATTERN: Cell[] = [
  'g', 'g', 'n', 'r', 'g', 'n', 'g',
  'n', 'g', 'g', 'g', 'r', 'g', 'n',
  'g', 'r', 'n', 'g', 'g', 'g', 'n',
  'g', 'g', 'n', 'g', 'r', 'g', 'g',
];

// Row 2 (0-based), col 3 — clear of the frame edges so the tooltip above it never clips.
const HIGHLIGHT_INDEX = 9;

const CELL_BG: Record<Cell, string> = {
  g: 'rgba(0,200,83,0.18)',
  r: 'rgba(255,59,48,0.16)',
  n: 'var(--color-tg-surface-2)',
};

export function CalendarMock() {
  return (
    <MockFrame className="items-center justify-center">
      <div dir="rtl" className="grid grid-cols-7 gap-1.5 w-full" style={{ maxWidth: 260 }}>
        {PATTERN.map((cell, i) => {
          const isHighlight = i === HIGHLIGHT_INDEX;
          return (
            <div
              key={i}
              className="relative aspect-square rounded-md"
              style={{
                background: CELL_BG[cell],
                boxShadow: isHighlight ? '0 0 0 2px #00d2d2, 0 0 12px rgba(0,210,210,0.5)' : undefined,
              }}
            >
              {isHighlight && (
                <span
                  className="absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11px] font-bold z-10"
                  style={{
                    background: 'rgba(10,12,16,0.92)',
                    border: '1px solid rgba(0,210,210,0.4)',
                    color: '#fff',
                    boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
                  }}
                >
                  +₪1,240 · 3 עסקאות
                </span>
              )}
            </div>
          );
        })}
      </div>
    </MockFrame>
  );
}

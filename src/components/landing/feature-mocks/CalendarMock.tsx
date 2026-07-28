'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CalendarDays, MousePointer2 } from 'lucide-react';
import { usePrefersReducedMotion } from '@/lib/hooks';
import { MockFrame } from './MockFrame';

/**
 * A real month grid (September 2025) rather than an abstract 7×5 block of
 * squares. Sept 2025 starts on a Monday and has 30 days, so 1 leading day
 * (Aug 31) + 30 + 4 trailing (Oct 1-4) lands on exactly 35 cells — five rows,
 * no sixth-row overflow to design around.
 */
const YEAR = 2025;
const MONTH = 8; // 0-based → September
const MONTH_LABEL = 'ספטמבר 2025';

/** The cell that gets the turquoise "today" ring. The 30th is the month's last
 *  traded day, so every cell in the grid has already happened — no future days
 *  sitting empty next to days with data. */
const TODAY = 30;

type DayData = { pnl: number; trades: number; discipline: number; violations: number };

/**
 * Demo month with a deliberate narrative, because the intensity scale below is
 * only legible if the inputs actually span a range:
 *   week 1  — solid start plus one standout day (+1,480, the month's max)
 *   week 2  — a quiet grind of small results
 *   week 3  — the blow-up: four losing days in a row bottoming at -1,320,
 *             and every rule violation in the month lands in this week
 *   week 4  — disciplined recovery, second-biggest day of the month
 *   week 5  — steady close
 * Fridays and Saturdays carry no data (market closed), which is what gives the
 * grid its calendar rhythm. Discipline tracks behaviour, not P&L: it collapses
 * to 38 on the worst day and peaks at 97 on the cleanest one.
 */
const DAYS: Record<number, DayData> = {
  1: { pnl: 420, trades: 3, discipline: 88, violations: 0 },
  2: { pnl: 180, trades: 2, discipline: 84, violations: 0 },
  3: { pnl: -260, trades: 3, discipline: 71, violations: 1 },
  4: { pnl: 1480, trades: 4, discipline: 95, violations: 0 },

  7: { pnl: 90, trades: 1, discipline: 79, violations: 0 },
  8: { pnl: 640, trades: 3, discipline: 91, violations: 0 },
  9: { pnl: -140, trades: 2, discipline: 76, violations: 0 },
  10: { pnl: 250, trades: 2, discipline: 86, violations: 0 },
  11: { pnl: 75, trades: 1, discipline: 82, violations: 0 },

  14: { pnl: -180, trades: 2, discipline: 68, violations: 1 },
  15: { pnl: -520, trades: 4, discipline: 54, violations: 2 },
  16: { pnl: -1320, trades: 6, discipline: 38, violations: 3 },
  17: { pnl: -410, trades: 3, discipline: 61, violations: 2 },
  18: { pnl: 130, trades: 1, discipline: 74, violations: 0 },

  21: { pnl: 60, trades: 1, discipline: 83, violations: 0 },
  22: { pnl: 310, trades: 2, discipline: 89, violations: 0 },
  23: { pnl: 880, trades: 3, discipline: 93, violations: 0 },
  24: { pnl: -95, trades: 2, discipline: 80, violations: 0 },
  25: { pnl: 1150, trades: 4, discipline: 97, violations: 0 },

  28: { pnl: 145, trades: 1, discipline: 85, violations: 0 },
  29: { pnl: 520, trades: 3, discipline: 90, violations: 0 },
  30: { pnl: 690, trades: 3, discipline: 92, violations: 0 },
};

// ── Grid geometry ────────────────────────────────────────────

const FIRST_WEEKDAY = new Date(YEAR, MONTH, 1).getDay(); // 1 (Monday)
const DAYS_IN_MONTH = new Date(YEAR, MONTH + 1, 0).getDate(); // 30
const PREV_MONTH_DAYS = new Date(YEAR, MONTH, 0).getDate(); // 31 (August)
const TOTAL_CELLS = 35;

type Cell = { day: number; inMonth: boolean };

const CELLS: Cell[] = Array.from({ length: TOTAL_CELLS }, (_, i) => {
  const offset = i - FIRST_WEEKDAY;
  if (offset < 0) return { day: PREV_MONTH_DAYS + offset + 1, inMonth: false };
  if (offset >= DAYS_IN_MONTH) return { day: offset - DAYS_IN_MONTH + 1, inMonth: false };
  return { day: offset + 1, inMonth: true };
});

const WEEKS: Cell[][] = Array.from({ length: TOTAL_CELLS / 7 }, (_, r) => CELLS.slice(r * 7, r * 7 + 7));

/** Cell index for an in-month day — used to look up refs and to know which row
 *  a day sits in without re-scanning CELLS. */
function cellIndexOf(day: number) {
  return FIRST_WEEKDAY + day - 1;
}

// Sunday-first, which puts ראשון in the physical right-most column under
// dir="rtl" (first DOM child renders right-most) — the correct Hebrew order.
const WEEKDAY_LABELS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];

// ── Intensity scale ──────────────────────────────────────────

/**
 * Heat-map fill bucketed by each day's magnitude relative to the month's
 * largest absolute daily result — not by fixed shekel thresholds, so the scale
 * re-normalises itself if the demo data ever changes. Four green steps, three
 * red steps, one neutral fill for days with no trades.
 */
const MAX_ABS = Math.max(...Object.values(DAYS).map((d) => Math.abs(d.pnl)));

const GREEN_STEPS = [
  'rgba(34,197,94,0.16)',
  'rgba(34,197,94,0.34)',
  'rgba(34,197,94,0.56)',
  'rgba(34,197,94,0.82)',
];
const RED_STEPS = ['rgba(239,68,68,0.18)', 'rgba(239,68,68,0.46)', 'rgba(239,68,68,0.76)'];
const NEUTRAL_FILL = 'rgba(255,255,255,0.05)';

function fillFor(data: DayData | undefined) {
  if (!data || data.pnl === 0) return NEUTRAL_FILL;
  const ratio = Math.abs(data.pnl) / MAX_ABS;
  if (data.pnl > 0) {
    const step = Math.min(GREEN_STEPS.length, Math.max(1, Math.ceil(ratio * GREEN_STEPS.length)));
    return GREEN_STEPS[step - 1];
  }
  const step = Math.min(RED_STEPS.length, Math.max(1, Math.ceil(ratio * RED_STEPS.length)));
  return RED_STEPS[step - 1];
}

// ── Derived stats (computed, never hand-counted) ─────────────

const TRADED_DAYS = Object.keys(DAYS)
  .map(Number)
  .sort((a, b) => a - b);

const MONTH_NET = TRADED_DAYS.reduce((sum, d) => sum + DAYS[d].pnl, 0);
const GREEN_DAYS = TRADED_DAYS.filter((d) => DAYS[d].pnl > 0).length;
const TOTAL_VIOLATIONS = TRADED_DAYS.reduce((sum, d) => sum + DAYS[d].violations, 0);

/** Longest run of consecutive *traded* winning days — no-trade days (weekends)
 *  neither extend nor break the streak. */
const LONGEST_STREAK = (() => {
  let best = 0;
  let current = 0;
  for (const d of TRADED_DAYS) {
    if (DAYS[d].pnl > 0) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
})();

const WEEK_NETS = WEEKS.map((week) =>
  week.reduce((sum, cell) => (cell.inMonth ? sum + (DAYS[cell.day]?.pnl ?? 0) : sum), 0),
);

// ── Formatting ───────────────────────────────────────────────

// Hand-rolled rather than toLocaleString so the output can't drift between the
// server's ICU build and the browser's and trip a hydration mismatch.
function group(n: number) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatMoney(n: number) {
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}₪${group(Math.abs(n))}`;
}

/** Compact form for the narrow week column, where "+₪1,820" would not fit at a
 *  readable size. */
function formatCompact(n: number) {
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return abs >= 1000 ? `${sign}${(abs / 1000).toFixed(1)}K` : `${sign}${abs}`;
}

const GREEN_TEXT = '#4ade80';
const RED_TEXT = '#f87171';
const AMBER = '#f59e0b';

function pnlColor(n: number) {
  if (n > 0) return GREEN_TEXT;
  if (n < 0) return RED_TEXT;
  return 'rgba(255,255,255,0.5)';
}

function disciplineColor(score: number) {
  if (score >= 85) return GREEN_TEXT;
  if (score >= 70) return 'rgba(255,255,255,0.9)';
  return AMBER;
}

// ── Ghost-cursor tour ────────────────────────────────────────

/**
 * Days the idle cursor visits, in narrative order: a clean winner, the month's
 * blow-up (three violations), the best day, then today. All four sit in grid
 * rows 2-4, which guarantees there is room to render their tooltip *above* the
 * cell — rows 0-1 flip below instead (see FLIP_MARGIN), which is correct but
 * less pretty, so the tour avoids them.
 */
const TOUR = [23, 16, 25, 30];
const TOUR_INTERVAL_MS = 2500;

// ── Tooltip geometry ─────────────────────────────────────────

/**
 * Width cap for the calendar block, shared by the weekday header and the grid
 * so their 9 columns stay in lockstep (they are separate grids — one continuous
 * grid would fight the per-row week divider). Sized against the vertical
 * budget, not the card width: the cells are square, so every extra px of width
 * costs ~0.7px of height on each of the five rows, and 430 is the widest that
 * still leaves the header and footer room inside the 440px frame.
 */
const GRID_MAX_W = 430;

const TOOLTIP_W = 176;
const TOOLTIP_GAP = 8;
const EDGE_PAD = 6;
/** Conservative stand-in for the tooltip's rendered height, used only to decide
 *  above-vs-below. Positioning itself uses translateY(-100%), so an imprecise
 *  value here can never misplace the tooltip — only flip it one row early. */
const FLIP_MARGIN = 118;

type Anchor = { centerX: number; centerY: number; top: number; bottom: number; containerW: number };

export function CalendarMock() {
  const bodyRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<number, HTMLDivElement>());

  const reducedMotion = usePrefersReducedMotion();
  const [revealed, setRevealed] = useState(false);
  const [tourIdx, setTourIdx] = useState(0);
  // day number when hovering a cell with data, 0 when hovering an empty cell
  // (still pauses the tour), null when the pointer is off the grid entirely.
  const [hovered, setHovered] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  // Staggered reveal, triggered once when the card scrolls into view. Under
  // reduced motion the grid is simply born visible — derived rather than set
  // from the effect, so there is no cascading render on mount.
  const visible = revealed || reducedMotion;

  useEffect(() => {
    if (reducedMotion) return;
    const el = bodyRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRevealed(true);
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reducedMotion]);

  const ghostDay = TOUR[tourIdx % TOUR.length];
  const ghostActive = !reducedMotion && visible && hovered === null;
  // Reduced motion still shows one tooltip so the card demonstrates itself —
  // it just never moves on its own.
  const activeDay = hovered && hovered > 0 ? hovered : ghostActive || reducedMotion ? ghostDay : null;
  const activeData = activeDay ? DAYS[activeDay] : undefined;

  // Advance the tour. Re-creating the interval whenever `hovered` changes is
  // what gives "pause immediately on hover, resume on leave" for free.
  useEffect(() => {
    if (!ghostActive) return;
    const id = setInterval(() => setTourIdx((i) => (i + 1) % TOUR.length), TOUR_INTERVAL_MS);
    return () => clearInterval(id);
  }, [ghostActive]);

  // Measure the active cell in *layout* coordinates. offsetLeft/offsetTop are
  // deliberate here instead of getBoundingClientRect: the mock sits inside
  // .feature-mock-card's 3D perspective transform, and client rects come back
  // in transformed space while the tooltip is positioned in untransformed
  // space — mixing the two would drift. Cell scale during the reveal stagger
  // doesn't affect offsets either.
  useEffect(() => {
    function measure() {
      const container = bodyRef.current;
      const el = activeDay ? cellRefs.current.get(cellIndexOf(activeDay)) : undefined;
      if (!container || !el) {
        setAnchor(null);
        return;
      }
      setAnchor({
        centerX: el.offsetLeft + el.offsetWidth / 2,
        centerY: el.offsetTop + el.offsetHeight / 2,
        top: el.offsetTop,
        bottom: el.offsetTop + el.offsetHeight,
        containerW: container.offsetWidth,
      });
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [activeDay, visible]);

  // Clamp the tooltip inside the card: its box spans [left - w/2, left + w/2],
  // so clamping `left` to half-width plus padding keeps both edges in bounds,
  // and the arrow keeps pointing at the real cell centre by taking up the slack.
  let tooltip: { left: number; top: number; width: number; arrowX: number; below: boolean } | null = null;
  if (anchor && activeData) {
    const width = Math.min(TOOLTIP_W, Math.max(120, anchor.containerW - EDGE_PAD * 2));
    const half = width / 2;
    const left = Math.min(Math.max(anchor.centerX, half + EDGE_PAD), anchor.containerW - half - EDGE_PAD);
    const below = anchor.top < FLIP_MARGIN + TOOLTIP_GAP;
    tooltip = {
      left,
      top: below ? anchor.bottom + TOOLTIP_GAP : anchor.top - TOOLTIP_GAP,
      width,
      arrowX: Math.min(Math.max(anchor.centerX - (left - half), 14), width - 14),
      below,
    };
  }

  const activeCellIndex = activeDay ? cellIndexOf(activeDay) : -1;

  return (
    // Square cells shrink with the card, so a phone-width grid is ~180px tall
    // against the 440px desktop frame — the height has to come down with it or
    // the bottom third of the card is empty. The important modifier is needed
    // to beat MockFrame's inline height, which is the desktop value.
    <MockFrame height={440} className="h-[360px]! sm:h-[440px]!">
      <div ref={bodyRef} dir="rtl" className="relative flex flex-col h-full w-full">
        {/* ── Header: month on the start edge, net result on the end edge ── */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              <CalendarDays size={14} className="shrink-0" style={{ color: '#00d2d2' }} />
              <span className="font-bold text-white" style={{ fontSize: 15 }}>
                {MONTH_LABEL}
              </span>
            </span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
              {TRADED_DAYS.length} ימי מסחר
            </span>
          </div>
          <span
            dir="ltr"
            className="font-extrabold leading-none"
            style={{ fontSize: 26, color: pnlColor(MONTH_NET), fontVariantNumeric: 'tabular-nums' }}
          >
            {formatMoney(MONTH_NET)}
          </span>
        </div>

        {/* ── Weekday header, aligned to the same 9-column template as the grid ── */}
        <div className="cal-grid grid mt-3 w-full mx-auto" style={{ maxWidth: GRID_MAX_W }} aria-hidden>
          {WEEKDAY_LABELS.map((label) => (
            <span
              key={label}
              className="text-center font-semibold"
              style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.38)' }}
            >
              {label}
            </span>
          ))}
          <span />
          <span className="text-center font-semibold" style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.3)' }}>
            שבוע
          </span>
        </div>

        {/* ── The month grid. Capped and centred rather than filling the card:
               the cells are square, so an unbounded width would grow five rows
               straight past the frame on a wide desktop card. It shrinks freely
               with the card below GRID_MAX_W. ── */}
        <div
          className="cal-grid grid mt-1.5 w-full mx-auto"
          style={{ maxWidth: GRID_MAX_W }}
          onMouseLeave={() => setHovered(null)}
        >
          {WEEKS.map((week, r) => (
            <Fragment key={r}>
              {week.map((cell, c) => {
                const index = r * 7 + c;
                const data = cell.inMonth ? DAYS[cell.day] : undefined;
                const isToday = cell.inMonth && cell.day === TODAY;
                const isActive = index === activeCellIndex;

                const ring = isActive
                  ? '0 0 0 1.5px rgba(255,255,255,0.6)'
                  : isToday
                    ? '0 0 0 1.5px rgba(0,210,210,0.85), 0 0 10px rgba(0,210,210,0.3)'
                    : undefined;

                return (
                  <div
                    key={index}
                    ref={(node) => {
                      if (node) cellRefs.current.set(index, node);
                    }}
                    className="relative aspect-square rounded-md"
                    style={{
                      // Floor for phone widths, where a strictly square cell
                      // drops to ~31px and the day number plus the violation
                      // dot stop being readable. Inert at desktop sizes.
                      minHeight: 34,
                      background: cell.inMonth ? fillFor(data) : 'rgba(255,255,255,0.02)',
                      boxShadow: ring,
                      opacity: visible ? (cell.inMonth ? 1 : 0.32) : 0,
                      transform: visible ? 'scale(1)' : 'scale(0.85)',
                      transition: 'opacity 0.38s cubic-bezier(0.16,1,0.3,1), transform 0.38s cubic-bezier(0.16,1,0.3,1), box-shadow 0.2s ease',
                      transitionDelay: visible && !reducedMotion ? `${index * 14}ms` : '0ms',
                    }}
                    // Adjacent-month and no-trade cells are non-interactive in
                    // the sense that matters — no tooltip, no ring — but they
                    // still register the hover (sentinel 0) so that moving the
                    // pointer onto one dismisses the previous day's tooltip
                    // instead of leaving it stranded, and keeps the tour paused.
                    onMouseEnter={() => setHovered(cell.inMonth && data ? cell.day : 0)}
                  >
                    <span
                      className="absolute font-semibold"
                      style={{
                        insetInlineStart: 3,
                        top: 1,
                        fontSize: 9.5,
                        lineHeight: 1.4,
                        color: 'rgba(255,255,255,0.42)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {cell.day}
                    </span>

                    {/* Rule-violation marker — one dot regardless of count; the
                        count itself lives in the tooltip. Amber sits outside the
                        green/red P&L hue range so it reads as a separate signal,
                        and the dark halo keeps it visible on both the faintest
                        and the most saturated fills. */}
                    {data && data.violations > 0 && (
                      <span
                        className="absolute rounded-full"
                        style={{
                          insetInlineEnd: 3,
                          bottom: 3,
                          width: 6,
                          height: 6,
                          background: AMBER,
                          boxShadow: '0 0 0 1.5px rgba(10,12,16,0.6), 0 0 6px rgba(245,158,11,0.75)',
                        }}
                      />
                    )}
                  </div>
                );
              })}

              <span style={{ background: 'rgba(255,255,255,0.1)' }} aria-hidden />

              <span
                className="flex items-center justify-center font-bold"
                style={{
                  fontSize: 9.5,
                  color: pnlColor(WEEK_NETS[r]),
                  fontVariantNumeric: 'tabular-nums',
                  opacity: visible ? 1 : 0,
                  transition: 'opacity 0.38s ease',
                  transitionDelay: visible && !reducedMotion ? `${(r * 7 + 6) * 14}ms` : '0ms',
                }}
                dir="ltr"
              >
                {formatCompact(WEEK_NETS[r])}
              </span>
            </Fragment>
          ))}
        </div>

        {/* ── Footer stats ── */}
        <div className="mt-auto flex items-stretch pt-3">
          <FooterStat label="ימים ירוקים" value={String(GREEN_DAYS)} color={GREEN_TEXT} />
          <FooterDivider />
          <FooterStat label="רצף מנצח" value={String(LONGEST_STREAK)} color="#00d2d2" />
          <FooterDivider />
          <FooterStat label="הפרות חוקים" value={String(TOTAL_VIOLATIONS)} color={AMBER} />
        </div>

        {/* ── Idle ghost cursor — parked on the active cell, transitioning
               between them so the month reads as being explored. ── */}
        {ghostActive && anchor && (
          <span
            className="cal-ghost absolute z-20 pointer-events-none"
            style={{
              left: anchor.centerX + 5,
              top: anchor.centerY + 4,
              transition: 'left 0.5s cubic-bezier(0.16,1,0.3,1), top 0.5s cubic-bezier(0.16,1,0.3,1)',
            }}
            aria-hidden
          >
            <MousePointer2
              size={15}
              style={{ color: '#fff', fill: '#00d2d2', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))' }}
            />
          </span>
        )}

        {/* ── Tooltip ── */}
        {tooltip && activeData && activeDay && (
          <div
            className="absolute z-30 pointer-events-none rounded-xl overflow-hidden"
            style={{
              left: tooltip.left,
              top: tooltip.top,
              width: tooltip.width,
              transform: tooltip.below ? 'translateX(-50%)' : 'translate(-50%, -100%)',
              background: 'rgba(10,13,20,0.82)',
              backdropFilter: 'blur(18px) saturate(1.4)',
              WebkitBackdropFilter: 'blur(18px) saturate(1.4)',
              border: '1px solid rgba(0,210,210,0.4)',
              boxShadow: '0 12px 30px rgba(0,0,0,0.5), 0 0 18px rgba(0,210,210,0.1)',
              transition: 'left 0.5s cubic-bezier(0.16,1,0.3,1), top 0.5s cubic-bezier(0.16,1,0.3,1)',
            }}
            aria-hidden
          >
            {/* Accent bar — the tooltip's verdict before any text is read */}
            <span
              className="block"
              style={{ height: 2.5, background: pnlColor(activeData.pnl) }}
            />

            <div className="flex flex-col gap-1 px-2.5 py-2">
              <TooltipRow label="תוצאה" value={formatMoney(activeData.pnl)} color={pnlColor(activeData.pnl)} bold />
              <TooltipRow label="עסקאות" value={String(activeData.trades)} color="rgba(255,255,255,0.9)" />
              <TooltipRow
                label="ציון משמעת"
                value={`${activeData.discipline}`}
                color={disciplineColor(activeData.discipline)}
              />

              {activeData.violations > 0 && (
                <span
                  className="flex items-center gap-1.5 mt-0.5 pt-1.5"
                  style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}
                >
                  <AlertTriangle size={11} className="shrink-0" style={{ color: AMBER }} />
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: AMBER }}>
                    {activeData.violations} הפרות חוקים
                  </span>
                </span>
              )}
            </div>

            {/* Arrow: a rotated square borrowing two of the tooltip's own border
                edges. Its x-offset is measured in physical pixels from the cell
                centre, so it lands correctly under RTL without a mirror case. */}
            <span
              className="absolute"
              style={{
                left: tooltip.arrowX,
                top: tooltip.below ? -5 : undefined,
                bottom: tooltip.below ? undefined : -5,
                width: 9,
                height: 9,
                marginLeft: -4.5,
                background: 'rgba(10,13,20,0.82)',
                borderRight: '1px solid rgba(0,210,210,0.4)',
                borderBottom: '1px solid rgba(0,210,210,0.4)',
                transform: tooltip.below ? 'rotate(-135deg)' : 'rotate(45deg)',
              }}
            />
          </div>
        )}
      </div>
    </MockFrame>
  );
}

function TooltipRow({
  label,
  value,
  color,
  bold = false,
}: {
  label: string;
  value: string;
  color: string;
  bold?: boolean;
}) {
  return (
    <span className="flex items-baseline justify-between gap-2">
      <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)' }}>{label}</span>
      <span
        dir="ltr"
        style={{
          fontSize: bold ? 13 : 11.5,
          fontWeight: bold ? 800 : 700,
          color,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
    </span>
  );
}

function FooterStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <span className="flex flex-1 flex-col items-center gap-0.5">
      <span className="text-center" style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
        {label}
      </span>
      <span
        className="font-extrabold leading-none"
        style={{ fontSize: 16, color, fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </span>
    </span>
  );
}

function FooterDivider() {
  return <span className="w-px self-stretch shrink-0" style={{ background: 'rgba(255,255,255,0.1)' }} aria-hidden />;
}

import { Check } from 'lucide-react';
import { MockFrame } from './MockFrame';

const CHIPS = ['NQ1', 'Long', '5m', 'Trend Follow'];

// Column 1 — price chart (candles + trend line only). No entry/stop/target
// lines share this Y-axis anymore (those live in the ladder, column 2) — see
// the two-zone layout below. Taller than the old single-band chart so it
// reads as a real chart, not a thin strip.
const CHART_W = 280;
const CHART_H = 152;
const PAD_Y = 14;

function toY(value: number) {
  return PAD_Y + ((100 - value) / 100) * (CHART_H - PAD_Y * 2);
}

function pctY(y: number) {
  return `${((y / CHART_H) * 100).toFixed(2)}%`;
}

function pctX(x: number) {
  return `${((x / CHART_W) * 100).toFixed(2)}%`;
}

// A believable but entirely made-up price silhouette — no longer tied to any
// entry/stop/target value (those moved to the ladder), just needs to read as
// real price movement: mixed body sizes, varied wicks, no tight wiggle.
const CANDLES = [
  { o: 52, c: 61, h: 64, l: 50 },
  { o: 61, c: 57, h: 63, l: 55 },
  { o: 57, c: 56, h: 60, l: 54 },
  { o: 56, c: 72, h: 75, l: 55 },
  { o: 72, c: 67, h: 76, l: 64 },
  { o: 67, c: 81, h: 84, l: 66 },
  { o: 81, c: 74, h: 83, l: 70 },
  { o: 74, c: 65, h: 76, l: 63 },
];
const CANDLE_SPACING = CHART_W / CANDLES.length;
const CANDLE_BODY_W = CANDLE_SPACING * 0.58; // ~58% body / ~42% gap, standard chart proportions

const GRID_LINES = [0.2, 0.4, 0.6, 0.8].map((f) => PAD_Y + f * (CHART_H - PAD_Y * 2));

// Trend line — connects the swing lows of 4 ascending candles, matching the
// Long direction. Draws left-to-right via pathLength=100 on the <polyline>
// (see plan-trend-draw in landing.css) so the dash math is plain 0-100
// regardless of the path's real length in user units.
const TREND_LINE_INDICES = [0, 2, 4, 6];
const TREND_LINE_PTS = TREND_LINE_INDICES.map((i) => ({
  x: (i + 0.5) * CANDLE_SPACING,
  y: toY(CANDLES[i].l),
}));
const TREND_LINE_POINTS = TREND_LINE_PTS.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
const TREND_LABEL_X = 190;
// Parked just under the lowest point of any candle (not pinned to the
// chart's bottom margin) so it reads as attached to the line's end instead
// of floating alone in the taller column's extra empty space below.
const TREND_LABEL_Y = Math.max(...CANDLES.map((k) => toY(k.l))) + 16;

// Column 2 — vertical price ladder. Values chosen so (target-entry) is
// exactly 2.5x (entry-stop) — the R:R ratio drives the two zone bars'
// relative height for real, not just the label text.
const LINES = {
  target: { label: 'יעד: 29,700', color: '#4ade80' },
  entry: { label: 'כניסה: 29,450', color: '#00d2d2' },
  stop: { label: 'סטופ: 29,350', color: '#f87171' },
};
const REWARD = 30; // target(88) - entry(58) on the old 0-100 scale
const RISK = 12; // entry(58) - stop(46)
const SPINE_W = 16; // dot+tick column width, shared by every ladder row/bar so they line up in one vertical line

const ROWS = [
  { text: 'סטופ מוגדר', appearClass: 'plan-appear-row1' },
  { text: 'מתאים לאסטרטגיה', appearClass: 'plan-appear-row2' },
  { text: 'יחס סיכוי/סיכון תקין', appearClass: 'plan-appear-row3' },
];

function LadderRow({
  color,
  label,
  appearClass,
  glowClass = '',
}: {
  color: string;
  label: string;
  appearClass: string;
  glowClass?: string;
}) {
  return (
    <div className={`${appearClass} flex items-center gap-1.5 shrink-0`}>
      <span className="flex items-center shrink-0" style={{ width: SPINE_W }}>
        <span className={`rounded-full shrink-0 ${glowClass}`} style={{ width: 7, height: 7, background: color }} />
        <span className="shrink-0" style={{ width: 8, height: 1.5, marginInlineStart: 2, borderRadius: 1, background: color }} />
      </span>
      <span className="text-[11px] font-bold whitespace-nowrap" style={{ color }}>{label}</span>
    </div>
  );
}

function ZoneBarVertical({ grow, color, appearClass }: { grow: number; color: string; appearClass: string }) {
  return (
    <div className={`${appearClass} flex`} style={{ flexGrow: grow }}>
      <span className="flex justify-center shrink-0" style={{ width: SPINE_W }}>
        <span className="rounded-full" style={{ width: 3, alignSelf: 'stretch', background: `linear-gradient(180deg, ${color}b3, ${color}33)` }} />
      </span>
      <span style={{ flex: 1 }} />
    </div>
  );
}

function RRLabel({ appearClass, className = '' }: { appearClass: string; className?: string }) {
  return (
    <span
      className={`${appearClass} ${className} whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-bold`}
      style={{ background: 'rgba(10,12,16,0.78)' }}
      aria-hidden
    >
      <span style={{ color: 'rgba(255,255,255,0.6)' }}>R:R </span>
      <span style={{ color: '#f87171' }}>1</span>
      <span style={{ color: 'rgba(255,255,255,0.6)' }}>:</span>
      <span style={{ color: '#4ade80' }}>2.5</span>
    </span>
  );
}

function MiniLadderItem({
  color,
  value,
  appearClass,
  glowClass = '',
}: {
  color: string;
  value: string;
  appearClass: string;
  glowClass?: string;
}) {
  return (
    <div className={`${appearClass} flex flex-col items-center gap-1 shrink-0`}>
      <span className={`rounded-full shrink-0 ${glowClass}`} style={{ width: 7, height: 7, background: color }} />
      <span className="text-[9px] font-bold whitespace-nowrap" style={{ color }}>{value}</span>
    </div>
  );
}

export function PlanCheckMock() {
  return (
    <MockFrame height={420}>
      <div dir="rtl" className="flex flex-col gap-3 w-full h-full">
        {/* Context header — unchanged */}
        <div className="flex items-center gap-1.5 flex-wrap" aria-hidden>
          {CHIPS.map((chip) => (
            <span
              key={chip}
              className="rounded-md px-2 py-1 text-[11px] font-semibold"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.55)' }}
            >
              {chip}
            </span>
          ))}
        </div>

        {/* Two clearly separated zones instead of one overlaid band — the
            fix for the "stretched/cluttered" complaint. RTL row: the chart
            (first child) renders on the physical right/wide side, the
            ladder (second child) on the left/narrow side. On mobile the row
            collapses to a column so the chart keeps full width + real
            height instead of being squeezed into a thin 65% column; the
            ladder becomes a compact horizontal strip underneath it. */}
        <div className="flex flex-col md:flex-row gap-3 md:gap-2.5 w-full">
          {/* Column 1 — clean price chart: candles + trend line only */}
          <div className="relative w-full md:flex-[0.65] shrink-0" style={{ height: CHART_H }}>
            <svg
              className="absolute inset-0 w-full h-full"
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              aria-hidden
            >
              {GRID_LINES.map((y, i) => (
                <line key={i} x1={0} y1={y} x2={CHART_W} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth={0.75} />
              ))}

              <g className="plan-candles">
                {CANDLES.map((k, i) => {
                  const x = (i + 0.5) * CANDLE_SPACING;
                  const top = toY(Math.max(k.o, k.c));
                  const bottom = toY(Math.min(k.o, k.c));
                  const color = k.c > k.o ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)';
                  return (
                    <g key={i}>
                      <line x1={x} y1={toY(k.h)} x2={x} y2={toY(k.l)} stroke={color} strokeWidth={1.2} />
                      <rect
                        x={x - CANDLE_BODY_W / 2}
                        y={top}
                        width={CANDLE_BODY_W}
                        height={Math.max(2, bottom - top)}
                        fill={color}
                        rx={1}
                      />
                    </g>
                  );
                })}
              </g>

              {/* Nothing else draws on this chart — the trend line is the
                  clear visual focus with no price lines competing against
                  it. pathLength=100 keeps the draw-in math simple. */}
              <polyline
                className="plan-trend-draw"
                points={TREND_LINE_POINTS}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={1.4}
                strokeDasharray="100"
                pathLength={100}
                strokeLinejoin="round"
              />
            </svg>

            <span
              className="plan-appear-row2 hidden md:flex absolute items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[9px] font-bold"
              style={{
                left: pctX(TREND_LABEL_X),
                top: pctY(TREND_LABEL_Y),
                transform: 'translate(-50%, -50%)',
                background: 'rgba(10,12,16,0.8)',
                border: '1px solid rgba(245,158,11,0.4)',
                color: '#f59e0b',
              }}
              aria-hidden
            >
              קו מגמה
            </span>
          </div>

          {/* Column 2 — vertical price ladder (md and up) */}
          <div className="hidden md:flex md:flex-col w-full md:flex-[0.35]" style={{ height: CHART_H }}>
            <RRLabel appearClass="plan-appear-row3" className="self-start mb-1.5" />
            <div className="flex flex-1 flex-col">
              <LadderRow color={LINES.target.color} label={LINES.target.label} appearClass="plan-appear-ladder-target" />
              <ZoneBarVertical grow={REWARD} color="#4ade80" appearClass="plan-appear-row3" />
              <LadderRow
                color={LINES.entry.color}
                label={LINES.entry.label}
                appearClass="plan-appear-ladder-entry"
                glowClass="plan-entry-label-glow"
              />
              <ZoneBarVertical grow={RISK} color="#f87171" appearClass="plan-appear-row3" />
              <LadderRow color={LINES.stop.color} label={LINES.stop.label} appearClass="plan-appear-row1" />
            </div>
          </div>

          {/* Column 2 — compact horizontal ladder (mobile only): same
              target→entry→stop order read right-to-left, zone bars run
              horizontally instead of vertically. */}
          <div className="flex md:hidden flex-col items-center gap-1.5 w-full">
            <RRLabel appearClass="plan-appear-row3" />
            <div className="flex items-center w-full" style={{ height: 32 }}>
              <MiniLadderItem color={LINES.target.color} value="29,700" appearClass="plan-appear-ladder-target" />
              <div className="plan-appear-row3" style={{ flexGrow: REWARD }}>
                <div style={{ height: 3, borderRadius: 2, background: 'linear-gradient(90deg, rgba(74,222,128,0.25), rgba(74,222,128,0.7))' }} />
              </div>
              <MiniLadderItem
                color={LINES.entry.color}
                value="29,450"
                appearClass="plan-appear-ladder-entry"
                glowClass="plan-entry-label-glow"
              />
              <div className="plan-appear-row3" style={{ flexGrow: RISK }}>
                <div style={{ height: 3, borderRadius: 2, background: 'linear-gradient(90deg, rgba(248,113,113,0.7), rgba(248,113,113,0.25))' }} />
              </div>
              <MiniLadderItem color={LINES.stop.color} value="29,350" appearClass="plan-appear-row1" />
            </div>
          </div>
        </div>

        {/* Checklist — each check pops in synced with its counterpart above:
            row 1 with the stop ladder row, row 2 with the trend line
            finishing its draw, row 3 with both R:R zone bars landing. */}
        <div className="flex flex-col gap-2">
          {ROWS.map((row) => (
            <div key={row.text} className="flex items-center gap-2.5">
              <span className={`${row.appearClass} flex shrink-0`}>
                <Check size={16} style={{ color: '#22c55e' }} />
              </span>
              <span className="text-white/85" style={{ fontSize: 14.5 }}>{row.text}</span>
            </div>
          ))}
        </div>

        {/* Final beat — approval pill, bottom-right (RTL), clear of the chart above */}
        <span
          className="plan-approved-pill self-start mt-auto rounded-full px-3 py-1 text-xs font-bold"
          style={{ background: '#22c55e', color: '#052e16' }}
        >
          אושר לכניסה
        </span>
      </div>
    </MockFrame>
  );
}

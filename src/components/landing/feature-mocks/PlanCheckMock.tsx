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

// Trend-line anchors: 3 candle indices (roughly 10%, 50%, 85% through the
// sequence) whose LOW values are deliberately made collinear, so a straight
// line through anchor1/anchor3 also passes exactly through anchor2 — real
// coordinate math, not a visual approximation. Anchor2's low is *derived*
// (not hand-picked) so the 3 points stay exactly collinear even if the
// anchor indices/values above are ever edited again.
const ANCHOR_IDX = { a1: 2, a2: 10, a3: 17 };
const ANCHOR_LOW = { a1: 45, a3: 90 };
const ANCHOR2_LOW = ANCHOR_LOW.a1 + ((ANCHOR_LOW.a3 - ANCHOR_LOW.a1) * (ANCHOR_IDX.a2 - ANCHOR_IDX.a1)) / (ANCHOR_IDX.a3 - ANCHOR_IDX.a1);

// A believable but entirely made-up price silhouette — no longer tied to any
// entry/stop/target value (those moved to the ladder), just needs to read as
// real, slightly noisy price action: 3 small-bodied/doji-like bars and 2
// long-wick rejection candles mixed among the trend moves, overall drifting
// up to match the Long/Trend Follow framing. Every non-anchor candle's low
// sits strictly above the trend line at its own x-position (never below —
// it's acting as respected support), so the 3 anchors read as the only real
// touches.
const CANDLES = [
  { o: 52, h: 56, l: 50, c: 54 },
  { o: 51, h: 52, l: 47, c: 48 },
  { o: 48, h: 52, l: ANCHOR_LOW.a1, c: 51 }, // ANCHOR1 — hammer reversal at the swing low
  { o: 54, h: 59, l: 53, c: 57 },
  { o: 55, h: 59, l: 54, c: 56 }, // doji-like
  { o: 61, h: 68, l: 60, c: 66 },
  { o: 67, h: 68, l: 61, c: 63 },
  { o: 66, h: 74, l: 65, c: 72 },
  { o: 68, h: 72, l: 66, c: 67 }, // doji-like
  { o: 72, h: 78, l: 71, c: 74 }, // long upper wick — rejection
  { o: 71, h: 74, l: ANCHOR2_LOW, c: 73 }, // ANCHOR2 — bounces exactly off the line
  { o: 79, h: 86, l: 78, c: 84 },
  { o: 80, h: 81, l: 78, c: 79 }, // doji-like
  { o: 86, h: 93, l: 85, c: 91 },
  { o: 88, h: 93, l: 85, c: 86 }, // long upper wick — rejection
  { o: 91, h: 97, l: 90, c: 95 },
  { o: 94, h: 94, l: 90, c: 91 },
  { o: 92, h: 97, l: ANCHOR_LOW.a3, c: 95 }, // ANCHOR3 — final touch before breaking higher
  { o: 94, h: 99, l: 93, c: 98 },
  { o: 98, h: 99, l: 95, c: 96 },
];
const CANDLE_SPACING = CHART_W / CANDLES.length;
const CANDLE_BODY_W = CANDLE_SPACING * 0.6; // ~60% body / ~40% gap, standard chart proportions

// TradingView's standard candle palette — body fill plus a subtly darker
// shade of the same hue for the 1px border (definition against the dark
// background without reading as a contrasting outline).
const CANDLE_UP_FILL = '#26a69a';
const CANDLE_UP_BORDER = '#1d7d74';
const CANDLE_DOWN_FILL = '#ef5350';
const CANDLE_DOWN_BORDER = '#b33e3c';

const GRID_LINES_H = [0.2, 0.4, 0.6, 0.8].map((f) => PAD_Y + f * (CHART_H - PAD_Y * 2));
const GRID_LINES_V = [0.2, 0.4, 0.6, 0.8].map((f) => f * CHART_W);

// Trend line — a genuine straight line (not a smoothed curve) from anchor1
// to anchor3. toY() is an affine transform of price, and the x-per-candle
// spacing is affine in index too, so anchor2's collinearity in (index,
// price) space carries through unchanged into (x, y) pixel space — the
// rendered line passes through all 3 candles' exact low pixel, guaranteed by
// the linear algebra, not just by eye. Draws left-to-right via pathLength=100
// on the <line> (see plan-trend-draw in landing.css) so the dash math is
// plain 0-100 regardless of the line's real length.
const TREND_LINE_P1 = { x: (ANCHOR_IDX.a1 + 0.5) * CANDLE_SPACING, y: toY(ANCHOR_LOW.a1) };
const TREND_LINE_P3 = { x: (ANCHOR_IDX.a3 + 0.5) * CANDLE_SPACING, y: toY(ANCHOR_LOW.a3) };
// Pulled back from the line's exact endpoint (near the chart's right edge)
// so the label has room to breathe instead of overflowing the column, and
// parked just under the lowest point of any candle so it reads as attached
// to the line instead of floating alone. The label's own width is fixed
// CSS px while its x position is a percentage of the column, so the same
// pullback reads as much less physical clearance on a narrow column (e.g.
// the md breakpoint, where column 1 is only ~35% of a already-narrow card)
// than on a wide one — capping at 80% of the chart width keeps it clear of
// the right edge at every breakpoint, not just the widest.
const TREND_LABEL_X = Math.min(TREND_LINE_P3.x - CANDLE_SPACING, CHART_W * 0.8);
const TREND_LABEL_Y = Math.max(...CANDLES.map((k) => toY(k.l))) + 16;

// Column 2 — vertical price ladder. The three prices are the single source of
// truth: the reward/risk distances, the two zone heights and the R:R label are
// all derived from them, so editing a price here re-proportions the whole
// ladder and relabels it in one step. Nothing downstream is hand-tuned.
const PRICES = { target: 29700, entry: 29450, stop: 29350 };

const REWARD = PRICES.target - PRICES.entry; // 250
const RISK = PRICES.entry - PRICES.stop; // 100
const RR = REWARD / RISK; // 2.5

/** 29700 → "29,700". Hand-rolled rather than toLocaleString so the output can't
 *  drift between the server's ICU build and the browser's and trip a hydration
 *  mismatch (same reasoning as CalendarMock). */
function group(n: number) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Trailing .0 is noise on a whole-number ratio ("1:2.5" but "1:3", not "1:3.0"). */
const RR_LABEL = Number.isInteger(RR) ? String(RR) : RR.toFixed(1);

const LINES = {
  target: { label: `יעד: ${group(PRICES.target)}`, color: '#4ade80' },
  entry: { label: `כניסה: ${group(PRICES.entry)}`, color: '#00d2d2' },
  stop: { label: `סטופ: ${group(PRICES.stop)}`, color: '#f87171' },
};

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

/**
 * A filled reward/risk zone spanning the vertical gap between two price rows.
 *
 * The height is pure flex distribution: `flex-basis: 0` is the load-bearing
 * part. With the default `flex-basis: auto` a grown item's final size is its
 * own content height *plus* its share of the leftover space, so two items with
 * grow 250 and 100 only land on a true 2.5:1 ratio when both happen to measure
 * zero — an accident that survives right up until either zone gains a label or
 * a border. Zeroing the basis makes the whole height the distributed share, so
 * the ratio is exactly REWARD:RISK by construction and stays correct if the
 * prices change. `min-height: 0` stops the flex floor (min-height: auto) from
 * silently over-sizing the smaller zone on a short card.
 *
 * `stops` runs top→bottom in physical order, so each caller passes its own
 * fade direction — both zones fade toward the entry line between them, which
 * is the shared edge, not a fixed end of the gradient.
 */
function ZoneBlock({
  grow,
  stops,
  appearClass,
}: {
  grow: number;
  stops: [string, string];
  appearClass: string;
}) {
  return (
    <div className={`${appearClass} flex items-stretch`} style={{ flexGrow: grow, flexBasis: 0, minHeight: 0 }}>
      {/* Spine gutter keeps the zone's start edge flush with the dot column
          above and below it, so the ladder still reads as one vertical axis. */}
      <span className="shrink-0" style={{ width: SPINE_W / 2 }} />
      <span
        className="flex-1 rounded-[3px]"
        style={{ background: `linear-gradient(180deg, ${stops[0]}, ${stops[1]})` }}
      />
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
      <span style={{ color: '#4ade80' }}>{RR_LABEL}</span>
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
      {/* justify-between rather than a single flex-1 child: handing all the
          leftover height to the chart row just relocates the empty space into
          the middle of the chart (the candle silhouette only occupies its upper
          band, so a taller chart is a taller gap under the candles). Spreading
          the slack across the three gaps instead is what actually reads as
          "evenly filled". */}
      <div dir="rtl" className="flex flex-col flex-1 justify-between gap-3 w-full">
        {/* Context header — unchanged */}
        <div className="flex items-center gap-1.5 flex-wrap shrink-0" aria-hidden>
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
        {/* Capped growth: the row takes enough extra height to give the ladder
            zones room to be read, but not so much that the chart outgrows its
            own candle range. The cap is desktop-only — on mobile the row is a
            column and needs its natural height. */}
        <div className="flex min-h-0 flex-col md:flex-row gap-3 md:gap-2.5 w-full md:flex-1 md:max-h-[186px]">
          {/* Column 1 — clean price chart: candles + trend line only. Height is
              no longer the fixed CHART_H: this row is the card's flex-1 child,
              so the chart and ladder absorb whatever vertical space the header,
              checklist and pill leave over instead of pooling it above the pill.
              The SVG keeps its CHART_W×CHART_H viewBox with
              preserveAspectRatio="none", so it simply stretches — every
              percentage-positioned overlay still lands correctly. */}
          <div className="relative w-full h-[150px] md:h-auto md:flex-[0.65] md:min-h-0">
            <svg
              className="absolute inset-0 w-full h-full"
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              aria-hidden
            >
              {GRID_LINES_H.map((y, i) => (
                <line key={`h${i}`} x1={0} y1={y} x2={CHART_W} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
              ))}
              {GRID_LINES_V.map((x, i) => (
                <line key={`v${i}`} x1={x} y1={0} x2={x} y2={CHART_H} stroke="rgba(255,255,255,0.04)" strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
              ))}

              <g className="plan-candles">
                {CANDLES.map((k, i) => {
                  const x = (i + 0.5) * CANDLE_SPACING;
                  const top = toY(Math.max(k.o, k.c));
                  const bottom = toY(Math.min(k.o, k.c));
                  const up = k.c > k.o;
                  const fill = up ? CANDLE_UP_FILL : CANDLE_DOWN_FILL;
                  const border = up ? CANDLE_UP_BORDER : CANDLE_DOWN_BORDER;
                  return (
                    <g key={i}>
                      <line x1={x} y1={toY(k.h)} x2={x} y2={toY(k.l)} stroke={fill} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
                      <rect
                        x={x - CANDLE_BODY_W / 2}
                        y={top}
                        width={CANDLE_BODY_W}
                        height={Math.max(2, bottom - top)}
                        fill={fill}
                        stroke={border}
                        strokeWidth={1}
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  );
                })}
              </g>

              {/* Nothing else draws on this chart — the trend line is the
                  clear visual focus with no price lines competing against
                  it. A real ascending support line, anchored exactly to 3
                  candle lows (see ANCHOR_IDX above), not a curve. */}
              <line
                className="plan-trend-draw"
                x1={TREND_LINE_P1.x}
                y1={TREND_LINE_P1.y}
                x2={TREND_LINE_P3.x}
                y2={TREND_LINE_P3.y}
                stroke="#00d2d2"
                strokeWidth={2.2}
                strokeDasharray="100"
                pathLength={100}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                style={{ filter: 'drop-shadow(0 0 3px rgba(0,210,210,0.55))' }}
              />
            </svg>

            <span
              className="plan-appear-row2 hidden md:flex absolute items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[9px] font-bold"
              style={{
                left: pctX(TREND_LABEL_X),
                top: pctY(TREND_LABEL_Y),
                transform: 'translate(-50%, -50%)',
                background: 'rgba(10,12,16,0.8)',
                border: '1px solid rgba(0,210,210,0.4)',
                color: '#00d2d2',
              }}
              aria-hidden
            >
              קו מגמה
            </span>
          </div>

          {/* Column 2 — vertical price ladder (md and up). The two filled zones
              sit strictly between the price rows rather than reaching under
              them to the dot centres: stretching each zone by half a row at
              both ends would add the same constant to both, which pulls the
              visible 2.5:1 ratio toward 1:1 and costs exactly the thing the
              zones exist to show. The rows are kept compact instead, so the
              zones dominate the column. */}
          <div className="hidden md:flex md:flex-col w-full md:flex-[0.35] min-h-0">
            <RRLabel appearClass="plan-appear-row3" className="self-start mb-1.5" />
            <div className="flex flex-1 flex-col min-h-0">
              <LadderRow color={LINES.target.color} label={LINES.target.label} appearClass="plan-appear-ladder-target" />
              <ZoneBlock
                grow={REWARD}
                stops={['rgba(74,222,128,0.46)', 'rgba(74,222,128,0.05)']}
                appearClass="plan-appear-row3"
              />
              <LadderRow
                color={LINES.entry.color}
                label={LINES.entry.label}
                appearClass="plan-appear-ladder-entry"
                glowClass="plan-entry-label-glow"
              />
              <ZoneBlock
                grow={RISK}
                stops={['rgba(248,113,113,0.05)', 'rgba(248,113,113,0.46)']}
                appearClass="plan-appear-row3"
              />
              <LadderRow color={LINES.stop.color} label={LINES.stop.label} appearClass="plan-appear-row1" />
            </div>
          </div>

          {/* Column 2 — compact horizontal ladder (mobile only): same
              target→entry→stop order read right-to-left, zone bars run
              horizontally instead of vertically. */}
          {/* Mobile strip. Same flex-basis:0 reasoning as ZoneBlock, applied on
              the horizontal axis. The gradients read left→right in physical
              pixels regardless of dir, and under RTL this row lays out
              target(right) → entry(centre) → stop(left), so "fade toward the
              entry line" is a leftward fade for the green bar and a rightward
              one for the red — mirrored from the vertical ladder, not copied. */}
          <div className="flex md:hidden flex-col items-center gap-1.5 w-full shrink-0">
            <RRLabel appearClass="plan-appear-row3" />
            <div className="flex items-center w-full" style={{ height: 32 }}>
              <MiniLadderItem color={LINES.target.color} value={group(PRICES.target)} appearClass="plan-appear-ladder-target" />
              <div className="plan-appear-row3" style={{ flexGrow: REWARD, flexBasis: 0, minWidth: 0 }}>
                <div style={{ height: 7, borderRadius: 3, background: 'linear-gradient(90deg, rgba(74,222,128,0.08), rgba(74,222,128,0.62))' }} />
              </div>
              <MiniLadderItem
                color={LINES.entry.color}
                value={group(PRICES.entry)}
                appearClass="plan-appear-ladder-entry"
                glowClass="plan-entry-label-glow"
              />
              <div className="plan-appear-row3" style={{ flexGrow: RISK, flexBasis: 0, minWidth: 0 }}>
                <div style={{ height: 7, borderRadius: 3, background: 'linear-gradient(90deg, rgba(248,113,113,0.62), rgba(248,113,113,0.08))' }} />
              </div>
              <MiniLadderItem color={LINES.stop.color} value={group(PRICES.stop)} appearClass="plan-appear-row1" />
            </div>
          </div>
        </div>

        {/* Checklist — each check pops in synced with its counterpart above:
            row 1 with the stop ladder row, row 2 with the trend line
            finishing its draw, row 3 with both R:R zone bars landing. */}
        <div className="flex flex-col gap-2.5 shrink-0">
          {ROWS.map((row) => (
            <div key={row.text} className="flex items-center gap-2.5">
              <span className={`${row.appearClass} flex shrink-0`}>
                <Check aria-hidden="true" size={16} style={{ color: '#22c55e' }} />
              </span>
              <span className="text-white/85" style={{ fontSize: 14.5 }}>{row.text}</span>
            </div>
          ))}
        </div>

        {/* Final beat — approval pill, bottom-right (RTL), clear of the chart
            above. No mt-auto: the chart/ladder row above is the flex-1 child
            now, so there is no leftover space left to push against — the pill
            sits one gap under the checklist where it belongs. */}
        <span
          className="plan-approved-pill self-start shrink-0 rounded-full px-3 py-1 text-xs font-bold"
          style={{ background: '#22c55e', color: '#052e16' }}
        >
          אושר לכניסה
        </span>
      </div>
    </MockFrame>
  );
}

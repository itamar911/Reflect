import { Check } from 'lucide-react';
import { MockFrame } from './MockFrame';

const CHIPS = ['NQ1', 'Long', '5m', 'Trend Follow'];

const CHART_W = 280;
const CHART_H = 140;
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

// A believable but entirely made-up price silhouette — not real data. Mixed
// body sizes (a couple of near-doji bars alongside two large-body moves) and
// varied wick lengths so it reads as price action, not a repeating pattern.
const CANDLES = [
  { o: 25, c: 33, h: 36, l: 22 },
  { o: 33, c: 29, h: 35, l: 26 },
  { o: 29, c: 28, h: 32, l: 25 },
  { o: 28, c: 42, h: 44, l: 27 },
  { o: 42, c: 38, h: 45, l: 36 },
  { o: 38, c: 50, h: 52, l: 37 },
  { o: 50, c: 48, h: 54, l: 46 },
  { o: 48, c: 58, h: 60, l: 47 },
];
const CANDLE_SPACING = CHART_W / CANDLES.length;
const CANDLE_BODY_W = CANDLE_SPACING * 0.58; // ~58% body / ~42% gap, standard chart proportions

// Last 3 candles — the "matches strategy" highlight region (Task 3)
const HIGHLIGHT_START_X = (CANDLES.length - 3) * CANDLE_SPACING;

const GRID_LINES = [0.2, 0.4, 0.6, 0.8].map((f) => PAD_Y + f * (CHART_H - PAD_Y * 2));

// entry/stop/target values chosen so (target-entry) is exactly 2.5x
// (entry-stop) — the R:R bracket's ratio needs to be geometrically true, not
// just claimed in the label text. The price strings below match that same
// 1:2.5 ratio (risk 100, reward 250).
const LINES = {
  target: { value: 88, label: 'יעד: 29,700', textColor: '#4ade80' },
  entry: { value: 58, label: 'כניסה: 29,450', textColor: '#00d2d2' },
  stop: { value: 46, label: 'סטופ: 29,350', textColor: '#f87171' },
};

const BRACKET_X = CHART_W - 14;
const BRACKET_TICK = 5;

// Row text stays exactly as given; each row's reveal is synced to a specific
// line above (row 1 with entry, row 2 with stop, row 3 with target) — not a
// 1:1 semantic pairing with the row's own wording, that's intentional per spec.
const ROWS = [
  { text: 'סטופ מוגדר', appearClass: 'plan-appear-entry' },
  { text: 'מתאים לאסטרטגיה', appearClass: 'plan-appear-stop' },
  { text: 'יחס סיכוי/סיכון תקין', appearClass: 'plan-appear-target' },
];

export function PlanCheckMock() {
  const targetY = toY(LINES.target.value);
  const entryY = toY(LINES.entry.value);
  const stopY = toY(LINES.stop.value);

  return (
    <MockFrame height={380}>
      <div dir="rtl" className="flex flex-col gap-3.5 w-full h-full">
        {/* Context header — symbol chips unchanged, plus a strategy-name chip (Task 3) */}
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

        {/* Abstract chart: grid → candles → strategy-match highlight → R:R
            zones/bracket → price lines, drawing in sequence left-to-right
            (chart time always flows left-to-right, even on this RTL page —
            real trading platforms keep that convention regardless of text
            direction). */}
        <div className="relative w-full" style={{ height: CHART_H }}>
          <svg
            className="absolute inset-0 w-full h-full"
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            <defs>
              {/* Dashed lines can't "grow" via stroke-dashoffset the way a
                  solid line can (offset just shifts a repeating pattern's
                  phase, it doesn't reveal length) — so stop/target draw via
                  an animated clip instead. */}
              <clipPath id="plan-clip-stop">
                <rect
                  className="plan-clip-rect-stop"
                  x={0}
                  y={0}
                  width={CHART_W}
                  height={CHART_H}
                  style={{ transformBox: 'fill-box', transformOrigin: '0% 50%' }}
                />
              </clipPath>
              <clipPath id="plan-clip-target">
                <rect
                  className="plan-clip-rect-target"
                  x={0}
                  y={0}
                  width={CHART_W}
                  height={CHART_H}
                  style={{ transformBox: 'fill-box', transformOrigin: '0% 50%' }}
                />
              </clipPath>
            </defs>

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

            {/* Strategy-match highlight — soft turquoise box over the last 3
                candles, hidden below md since the right edge is already busy
                with price labels/R:R bracket at narrow widths. */}
            <rect
              className="plan-appear-stop hidden md:block"
              x={HIGHLIGHT_START_X}
              y={PAD_Y - 2}
              width={CHART_W - HIGHLIGHT_START_X}
              height={CHART_H - (PAD_Y - 2) * 2}
              rx={4}
              fill="rgba(0,210,210,0.07)"
              stroke="rgba(0,210,210,0.4)"
              strokeWidth={1}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />

            {/* R:R zones — reward (target→entry) visibly bigger than risk
                (entry→stop) since the geometry is a true 2.5x, not just the
                label's claim. */}
            <rect className="plan-zone-fade" x={0} y={targetY} width={CHART_W} height={entryY - targetY} fill="rgba(34,197,94,0.1)" />
            <rect className="plan-zone-fade" x={0} y={entryY} width={CHART_W} height={stopY - entryY} fill="rgba(239,68,68,0.12)" />

            {/* R:R caliper bracket, inset from the right edge (see BRACKET_X) */}
            <g className="plan-zone-fade">
              <line x1={BRACKET_X} y1={targetY} x2={BRACKET_X} y2={stopY} stroke="rgba(255,255,255,0.4)" strokeWidth={1} />
              <line x1={BRACKET_X - BRACKET_TICK} y1={targetY} x2={BRACKET_X + BRACKET_TICK} y2={targetY} stroke="#4ade80" strokeWidth={1} />
              <line x1={BRACKET_X - BRACKET_TICK} y1={entryY} x2={BRACKET_X + BRACKET_TICK} y2={entryY} stroke="#00d2d2" strokeWidth={1} />
              <line x1={BRACKET_X - BRACKET_TICK} y1={stopY} x2={BRACKET_X + BRACKET_TICK} y2={stopY} stroke="#f87171" strokeWidth={1} />
            </g>

            <line x1={0} y1={targetY} x2={CHART_W} y2={targetY} stroke="#22c55e" strokeWidth={1.5} strokeDasharray="6 4" clipPath="url(#plan-clip-target)" />
            <line x1={0} y1={stopY} x2={CHART_W} y2={stopY} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="6 4" clipPath="url(#plan-clip-stop)" />
            <line
              className="plan-line-entry"
              x1={0}
              y1={entryY}
              x2={CHART_W}
              y2={entryY}
              stroke="#00d2d2"
              strokeWidth={2}
              strokeDasharray={CHART_W}
            />
          </svg>

          {/* Strategy-match tag — bottom of the highlighted region, clear of
              every price label (all of which sit higher, at target/entry/stop). */}
          <span
            className="plan-appear-stop hidden md:flex absolute items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[9px] font-bold"
            style={{
              left: pctX((HIGHLIGHT_START_X + CHART_W) / 2),
              top: pctY(CHART_H - 10),
              transform: 'translate(-50%, -50%)',
              background: 'rgba(10,12,16,0.8)',
              border: '1px solid rgba(0,210,210,0.35)',
              color: '#00d2d2',
            }}
            aria-hidden
          >
            <Check size={9} />
            תואם לדפוס
          </span>

          {/* R:R label — vertically centered in the reward zone, clear of the
              target/entry price pills above and below it. */}
          <span
            className="plan-zone-fade absolute whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-bold"
            style={{
              top: pctY((targetY + entryY) / 2),
              right: 2,
              transform: 'translateY(-50%)',
              background: 'rgba(10,12,16,0.78)',
              color: '#e5e7eb',
            }}
            aria-hidden
          >
            R:R 1:2.5
          </span>

          {/* Label pills anchor to the chart's physical right edge (its
              "current price" side) — right/top are physical here on purpose,
              independent of the page's RTL flow. */}
          <span
            className="plan-appear-target absolute whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-bold"
            style={{ top: pctY(targetY), right: 2, transform: 'translateY(-50%)', background: 'rgba(10,12,16,0.78)', color: LINES.target.textColor }}
            aria-hidden
          >
            {LINES.target.label}
          </span>
          <span
            className="plan-appear-stop absolute whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-bold"
            style={{ top: pctY(stopY), right: 2, transform: 'translateY(-50%)', background: 'rgba(10,12,16,0.78)', color: LINES.stop.textColor }}
            aria-hidden
          >
            {LINES.stop.label}
          </span>
          <span
            className="plan-appear-entry plan-entry-label-glow absolute whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-bold"
            style={{
              top: pctY(entryY),
              right: 2,
              transform: 'translateY(-50%)',
              background: 'rgba(10,12,16,0.85)',
              border: '1px solid rgba(0,210,210,0.4)',
              color: LINES.entry.textColor,
            }}
            aria-hidden
          >
            {LINES.entry.label}
          </span>
        </div>

        {/* Checklist — each check pops in synced with its line above */}
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

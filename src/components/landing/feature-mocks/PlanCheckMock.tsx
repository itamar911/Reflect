import { Check } from 'lucide-react';
import { MockFrame } from './MockFrame';

const CHIPS = ['NQ1', 'Long', '5m'];

const CHART_W = 280;
const CHART_H = 130;
const PAD_Y = 10;

function toY(value: number) {
  return PAD_Y + ((100 - value) / 100) * (CHART_H - PAD_Y * 2);
}

function pctY(y: number) {
  return `${((y / CHART_H) * 100).toFixed(2)}%`;
}

// A believable but entirely made-up price silhouette — not real data, just a
// gentle net-upward zigzag of open/close/high/low on a 0-100 scale.
const CANDLES = [
  { o: 30, c: 38, h: 42, l: 27 },
  { o: 38, c: 33, h: 41, l: 30 },
  { o: 33, c: 45, h: 48, l: 31 },
  { o: 45, c: 41, h: 47, l: 38 },
  { o: 41, c: 52, h: 55, l: 39 },
  { o: 52, c: 58, h: 61, l: 50 },
  { o: 58, c: 50, h: 60, l: 47 },
  { o: 50, c: 68, h: 71, l: 48 },
];
const CANDLE_SPACING = CHART_W / CANDLES.length;
const CANDLE_BODY_W = CANDLE_SPACING * 0.42;

const LINES = {
  target: { value: 85, label: 'יעד: 29,680', textColor: '#4ade80' },
  entry: { value: 60, label: 'כניסה: 29,450', textColor: '#00d2d2' },
  stop: { value: 40, label: 'סטופ: 29,340', textColor: '#f87171' },
};

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
        {/* Context header — unchanged */}
        <div className="flex items-center gap-1.5" aria-hidden>
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

        {/* Abstract chart: candles behind, 3 price lines overlaid on top,
            drawing in sequence left-to-right (chart time always flows
            left-to-right, even on this RTL page — real trading platforms
            keep that convention regardless of text direction). */}
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

            <g className="plan-candles">
              {CANDLES.map((k, i) => {
                const x = (i + 0.5) * CANDLE_SPACING;
                const top = toY(Math.max(k.o, k.c));
                const bottom = toY(Math.min(k.o, k.c));
                const color = k.c > k.o ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)';
                return (
                  <g key={i}>
                    <line x1={x} y1={toY(k.h)} x2={x} y2={toY(k.l)} stroke={color} strokeWidth={1} />
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

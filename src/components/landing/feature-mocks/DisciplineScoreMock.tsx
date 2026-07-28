import { MockFrame } from './MockFrame';

const SIZE = 220;
const CENTER = SIZE / 2;
const MAX_R = 72; // plot radius for a value of 100
const LABEL_R = 92;

// Longest labels go on the horizontally-safest clock positions (top, then
// lower-left/right); the shortest go on the tightest ones (upper-left/right,
// closest to the card's vertical edges) — see the width math in the commit
// message. The (label, value) pairs themselves are exactly as specified.
const AXES = [
  { label: 'נאמנות לתוכנית', value: 92 }, // top
  { label: 'עקביות', value: 90 }, // upper-right
  { label: 'שליטה רגשית', value: 78 }, // lower-right
  { label: 'שמירה על סטופ', value: 85 }, // lower-left
  { label: 'סבלנות', value: 88 }, // upper-left
];

function polar(angleDeg: number, r: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CENTER + r * Math.cos(rad), y: CENTER + r * Math.sin(rad) };
}

function toPoints(pts: { x: number; y: number }[]) {
  return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

function pct(v: number) {
  return `${((v / SIZE) * 100).toFixed(2)}%`;
}

const ANGLES = AXES.map((_, i) => -90 + i * 72);
const DATA_PTS = AXES.map((axis, i) => polar(ANGLES[i], (axis.value / 100) * MAX_R));
const LABEL_PTS = ANGLES.map((a) => polar(a, LABEL_R));
const GUIDE_RINGS = [0.35, 0.68, 1].map((f) => ANGLES.map((a) => polar(a, f * MAX_R)));

export function DisciplineScoreMock() {
  return (
    <MockFrame className="items-center justify-center">
      {/* Floating corner badges, kept from the previous round — pulled in a
          bit tighter so they clear the wider pentagon shape below. */}
      <span
        className="hero-float-1 absolute top-2 right-2 z-[1] rounded-full px-2 py-1 text-[10px] font-bold"
        style={{ background: 'rgba(0,210,210,0.14)', border: '1px solid rgba(0,210,210,0.4)', color: '#00d2d2' }}
        aria-hidden
      >
        רצף נוכחי: 4
      </span>
      <span
        className="hero-float-2 absolute bottom-2 left-2 z-[1] rounded-full px-2 py-1 text-[10px] font-bold"
        style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.35)', color: '#4ade80' }}
        aria-hidden
      >
        מעל הממוצע האישי
      </span>

      <div className="radar-wrap relative" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
          {GUIDE_RINGS.map((ring, i) => (
            <polygon key={i} points={toPoints(ring)} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
          ))}

          {ANGLES.map((a, i) => {
            const outer = polar(a, MAX_R);
            return (
              <line
                key={i}
                className={`radar-spoke radar-spoke-${i}`}
                x1={CENTER}
                y1={CENTER}
                x2={outer.x}
                y2={outer.y}
                stroke="rgba(255,255,255,0.15)"
                strokeWidth={1}
                style={{ transition: 'stroke 0.25s ease, stroke-width 0.25s ease' }}
              />
            );
          })}

          <polygon
            className="radar-polygon"
            points={toPoints(DATA_PTS)}
            fill="rgba(0,210,210,0.18)"
            stroke="#00d2d2"
            strokeWidth={2}
            strokeLinejoin="round"
            style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
          />

          {DATA_PTS.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={6.5} fill="none" stroke="#00d2d2" strokeWidth={1} opacity={0.5} />
              <circle
                className={`radar-dot radar-dot-${i} radar-dot-pulse`}
                cx={p.x}
                cy={p.y}
                r={3.5}
                fill="#00d2d2"
                style={{
                  animationDelay: `${i * 0.3}s`,
                  transition: 'transform 0.2s ease',
                  transformBox: 'fill-box',
                  transformOrigin: 'center',
                }}
              />
            </g>
          ))}
        </svg>

        {AXES.map((axis, i) => {
          const lp = LABEL_PTS[i];
          const vp = DATA_PTS[i];
          const isUpper = lp.y < CENTER;
          return (
            <div key={axis.label} dir="rtl">
              <span
                className={`radar-hit-${i} absolute text-center`}
                style={{
                  left: pct(lp.x),
                  top: pct(lp.y),
                  transform: 'translate(-50%, -50%)',
                  maxWidth: 64,
                  fontSize: 11,
                  lineHeight: 1.25,
                  color: 'rgba(255,255,255,0.6)',
                }}
              >
                {axis.label}
              </span>

              {/* Extra invisible hover target right at the vertex — "hovering
                  near the label OR its vertex" both drive the same state. */}
              <span
                className={`radar-hit-${i} absolute w-6 h-6`}
                style={{ left: pct(vp.x), top: pct(vp.y), transform: 'translate(-50%, -50%)' }}
                aria-hidden
              />

              <span
                className={`radar-tooltip radar-tooltip-${i} absolute whitespace-nowrap rounded-lg px-2 py-1 text-[10px] font-bold z-20`}
                style={{
                  left: pct(lp.x),
                  top: pct(lp.y),
                  transform: isUpper ? 'translate(-50%, calc(-100% - 6px))' : 'translate(-50%, 6px)',
                  background: 'rgba(10,12,16,0.92)',
                  border: '1px solid rgba(0,210,210,0.4)',
                  color: '#fff',
                  boxShadow: '0 6px 16px rgba(0,0,0,0.4)',
                  pointerEvents: 'none',
                }}
                aria-hidden
              >
                {axis.label}: {axis.value}%
              </span>
            </div>
          );
        })}

        {/* Score readout — small dark glass chip so it reads over the polygon fill */}
        <div
          className="absolute rounded-full flex flex-col items-center justify-center"
          style={{
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 64,
            height: 64,
            background: 'rgba(10,12,16,0.75)',
            border: '1px solid rgba(0,210,210,0.3)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
          }}
        >
          <span className="text-2xl font-extrabold text-white leading-none">87</span>
          <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>מתוך 100</span>
        </div>
      </div>
    </MockFrame>
  );
}

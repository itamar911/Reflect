'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/lib/hooks';
import { MockFrame } from './MockFrame';

const SIZE = 320; // logical viewBox units — the wrap renders smaller on mobile via Tailwind, scaling everything (incl. % -positioned labels) proportionally
const CENTER = SIZE / 2;
const MAX_R = 105; // plot radius for a value of 100
const LABEL_R = 134;
const TARGET = 87;

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

// "Average trader" baseline, axis-aligned with AXES above — flat-ish and
// ~20-25pts under the user on every axis except שליטה רגשית, the user's own
// weakest axis at 78: pulling that one down by the same 20-25pts would drop
// it out of the requested 65-70 band, so its gap narrows to ~10pts instead.
const AVG_VALUES = [68, 65, 68, 66, 69];

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
const AVG_PTS = AVG_VALUES.map((v, i) => polar(ANGLES[i], (v / 100) * MAX_R));
const LABEL_PTS = ANGLES.map((a) => polar(a, LABEL_R));
const GUIDE_RINGS = [0.35, 0.68, 1].map((f) => ANGLES.map((a) => polar(a, f * MAX_R)));
const SWEEP_DIAMETER_PCT = ((MAX_R * 2) / SIZE) * 100;

export function DisciplineScoreMock() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;
    const el = wrapRef.current;
    if (!el) return;

    let raf = 0;
    const countUp = () => {
      const duration = 1100;
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        setValue(Math.round(eased * TARGET));
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    // No disconnect() here — re-triggers the count-up every time the card
    // scrolls back into view, not just once per page load (LoopSection's
    // own observer disconnects after the first hit; this one deliberately
    // doesn't, since re-entry is the point).
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          cancelAnimationFrame(raf);
          countUp();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [reducedMotion]);

  const displayValue = reducedMotion ? TARGET : value;

  return (
    <MockFrame className="items-center justify-center" height={440}>
      {/* Floating corner badges, kept from the previous round */}
      <span
        className="hero-float-1 absolute top-2 right-2 z-[25] rounded-full px-2 py-1 text-[10px] font-bold"
        style={{ background: 'rgba(0,210,210,0.14)', border: '1px solid rgba(0,210,210,0.4)', color: '#00d2d2' }}
        aria-hidden
      >
        רצף נוכחי: 4
      </span>
      <span
        className="hero-float-2 absolute bottom-2 left-2 z-[25] rounded-full px-2 py-1 text-[10px] font-bold"
        style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.35)', color: '#4ade80' }}
        aria-hidden
      >
        מעל הממוצע האישי
      </span>

      {/* Legend — the corner the badges don't occupy */}
      <div
        className="absolute bottom-2 right-2 z-[25] flex flex-col gap-1 rounded-lg px-2 py-1.5"
        style={{ background: 'rgba(10,12,16,0.55)', border: '1px solid rgba(255,255,255,0.08)' }}
        aria-hidden
      >
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: '#00d2d2' }} />
          <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.75)' }}>אתה</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'rgba(255,255,255,0.45)' }} />
          <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.55)' }}>ממוצע הסוחרים</span>
        </span>
      </div>

      <div ref={wrapRef} className="radar-wrap relative w-[270px] h-[270px] md:w-[320px] md:h-[320px]">
        {/* Bottom layer: guide rings, spokes, average-trader baseline */}
        <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
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
            points={toPoints(AVG_PTS)}
            fill="rgba(255,255,255,0.03)"
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        </svg>

        {/* Middle layer: rotating sweep beam — behind the data polygon/dots on purpose */}
        <span
          className="radar-sweep absolute z-10 rounded-full"
          style={{ width: `${SWEEP_DIAMETER_PCT}%`, height: `${SWEEP_DIAMETER_PCT}%`, left: '50%', top: '50%' }}
          aria-hidden
        />

        {/* Top layer: the user's data polygon + vertex dots, always crisp above the sweep */}
        <svg className="absolute inset-0 w-full h-full z-20" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
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
                className={`radar-hit-${i} absolute z-30 text-center`}
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
                className={`radar-hit-${i} absolute z-30 w-6 h-6`}
                style={{ left: pct(vp.x), top: pct(vp.y), transform: 'translate(-50%, -50%)' }}
                aria-hidden
              />

              <span
                className={`radar-tooltip radar-tooltip-${i} absolute z-40 whitespace-nowrap rounded-lg px-2 py-1 text-[10px] font-bold`}
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
          className="absolute z-30 rounded-full flex flex-col items-center justify-center"
          style={{
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 72,
            height: 72,
            background: 'rgba(10,12,16,0.75)',
            border: '1px solid rgba(0,210,210,0.3)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
          }}
        >
          <span className="text-3xl font-extrabold text-white leading-none">{displayValue}</span>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>מתוך 100</span>
        </div>
      </div>
    </MockFrame>
  );
}

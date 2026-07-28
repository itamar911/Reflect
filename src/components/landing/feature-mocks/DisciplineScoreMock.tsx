'use client';

import { useEffect, useRef, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { usePrefersReducedMotion } from '@/lib/hooks';
import { MockFrame } from './MockFrame';

const TARGET = 87;
const SIZE = 140;
const STROKE = 10;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function DisciplineScoreMock() {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [value, setValue] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reducedMotion || !inView) return;

    const duration = 1200;
    const start = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(eased * TARGET));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, reducedMotion]);

  // Reduced motion skips the count-up entirely and renders the resting value.
  const displayValue = reducedMotion ? TARGET : value;
  const offset = CIRCUMFERENCE - (displayValue / 100) * CIRCUMFERENCE;

  return (
    <MockFrame className="items-center justify-center">
      {/* Floating corner badges — same hero-float treatment as HeroMock's
          stat chips, sized down and pulled inward so they stay clear of
          the frame's overflow-hidden edges instead of poking off-card. */}
      <span
        className="hero-float-1 absolute top-3 right-3 z-[1] rounded-full px-2 py-1 text-[10px] font-bold"
        style={{ background: 'rgba(0,210,210,0.14)', border: '1px solid rgba(0,210,210,0.4)', color: '#00d2d2' }}
        aria-hidden
      >
        רצף נוכחי: 4
      </span>
      <span
        className="hero-float-2 absolute bottom-3 left-3 z-[1] rounded-full px-2 py-1 text-[10px] font-bold"
        style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.35)', color: '#4ade80' }}
        aria-hidden
      >
        מעל הממוצע האישי
      </span>

      <div ref={ref} dir="rtl" className="flex flex-col items-center gap-2">
        <div className="relative" style={{ width: SIZE, height: SIZE }}>
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="-rotate-90">
            <defs>
              <linearGradient id="disc-score-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#00d2d2" />
                <stop offset="100%" stopColor="#67e8f9" />
              </linearGradient>
            </defs>
            <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={STROKE} />
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="url(#disc-score-grad)"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={offset}
              style={{ transition: reducedMotion ? 'none' : 'stroke-dashoffset 0.1s linear' }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-3xl font-extrabold text-white leading-none">{displayValue}</span>
            <span className="text-[11px] mt-1" style={{ color: 'rgba(255,255,255,0.6)' }}>מתוך 100</span>
          </div>
        </div>
        <span className="flex items-center gap-1 text-xs font-bold" style={{ color: '#22c55e' }}>
          <TrendingUp size={13} />
          +5 השבוע
        </span>
      </div>
    </MockFrame>
  );
}

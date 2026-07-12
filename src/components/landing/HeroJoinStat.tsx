'use client';

import { useEffect, useRef, useState } from 'react';

// Update this as the real number grows.
const NEW_USERS_THIS_MONTH = 367;

const COUNT_DURATION_MS = 1700;

// Social-proof line under the hero CTA: a live-style pulsing dot and a
// count-up to NEW_USERS_THIS_MONTH, started once when the element enters
// the viewport. Reduced motion skips straight to the final number (the dot's
// pulse is killed by landing.css's global reduced-motion rule).
export function HeroJoinStat() {
  const [value, setValue] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || started.current) return;
        started.current = true;
        io.disconnect();

        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          setValue(NEW_USERS_THIS_MONTH);
          return;
        }

        const t0 = performance.now();
        const tick = (now: number) => {
          const t = Math.min((now - t0) / COUNT_DURATION_MS, 1);
          const eased = 1 - Math.pow(1 - t, 3); // ease-out: fast start, slow settle
          setValue(Math.round(eased * NEW_USERS_THIS_MONTH));
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 }
    );

    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <span
      ref={ref}
      className="inline-flex items-center gap-2.5 rounded-full px-4 py-1.5 text-sm text-tg-muted"
      style={{
        background: 'rgba(0, 210, 210, 0.07)',
        border: '1px solid rgba(0, 210, 210, 0.25)',
      }}
    >
      <span className="hero-live-dot" aria-hidden />
      <span
        className="text-base font-extrabold"
        style={{
          color: '#00d2d2',
          // Fixed-width LTR box sized for the final "+367" so the count-up
          // never pushes the surrounding text around; left-aligned so the
          // number stays glued to the text (which follows on its left in RTL).
          fontVariantNumeric: 'tabular-nums',
          direction: 'ltr',
          unicodeBidi: 'isolate',
          minWidth: '3.8ch',
          textAlign: 'left',
        }}
      >
        +{value}
      </span>
      סוחרים הצטרפו בחודש האחרון
    </span>
  );
}

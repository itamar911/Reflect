'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/lib/hooks';

/**
 * Registered Reflect accounts, cumulative. Update as the real number grows.
 *
 * Two things about this figure are deliberate and should not be casually
 * changed back:
 *
 *   - It is cumulative, with no timeframe. The line used to read "בחודש
 *     האחרון", which is a time-bound claim that a hardcoded constant starts
 *     falsifying the day after it is written. A cumulative total only ever
 *     understates itself, which is the safe direction to be wrong in.
 *   - It counts *registrations*, and the copy says exactly that ("נרשמו").
 *     Signups, trial starts and paying customers are three different numbers;
 *     "traders joined" quietly claimed the strongest of the three while
 *     counting the weakest.
 *
 * Worth replacing with a real count read from the database — the honest
 * source — rather than a constant anyone has to remember to bump.
 */
const REGISTERED_TRADERS = 147;

const COUNT_DURATION_MS = 1700;

// Social-proof line under the hero CTA: a live-style pulsing dot and a
// count-up to REGISTERED_TRADERS, started once when the element enters
// the viewport. Reduced motion skips straight to the final number (the dot's
// pulse is killed by landing.css's global reduced-motion rule).
export function HeroJoinStat() {
  const [value, setValue] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    // Reduced motion (OS setting or the accessibility widget's toggle) skips
    // the count-up entirely; the final number is shown from `display` below.
    // Flipping the toggle on mid-count re-runs this effect, and the cleanup
    // cancels the in-flight frame.
    if (reducedMotion) return;

    const el = ref.current;
    if (!el) return;

    let raf = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || started.current) return;
        started.current = true;
        io.disconnect();

        const t0 = performance.now();
        const tick = (now: number) => {
          const t = Math.min((now - t0) / COUNT_DURATION_MS, 1);
          const eased = 1 - Math.pow(1 - t, 3); // ease-out: fast start, slow settle
          setValue(Math.round(eased * REGISTERED_TRADERS));
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.4 }
    );

    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [reducedMotion]);

  const display = reducedMotion ? REGISTERED_TRADERS : value;

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
          // Fixed-width LTR box sized for a three-digit total so the count-up
          // never pushes the surrounding text around; left-aligned so the
          // number stays glued to the text (which follows on its left in RTL).
          fontVariantNumeric: 'tabular-nums',
          direction: 'ltr',
          unicodeBidi: 'isolate',
          minWidth: '3.8ch',
          textAlign: 'left',
        }}
      >
        +{display}
      </span>
      סוחרים נרשמו ל-Reflect
    </span>
  );
}

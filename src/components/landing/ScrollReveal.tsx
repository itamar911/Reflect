'use client';

import { useEffect, useRef, useState } from 'react';
import { useHydrated, usePrefersReducedMotion } from '@/lib/hooks';

/**
 * Must stay in step with the `animation-delay` on `.scroll-reveal`
 * (landing.css), which is what actually reveals the content when JS is absent.
 */
const FAIL_OPEN_DELAY_MS = 1800;

/**
 * Whether the CSS fallback had already started revealing by the time the client
 * took over.
 *
 * Latched on first read rather than sampled per element: hydration is a single
 * page-wide event, so the answer belongs to the page load, and a value that
 * drifted between reads would make this unusable during render.
 */
let failOpenStarted: boolean | null = null;

function hasFailOpenStarted(): boolean {
  failOpenStarted ??= performance.now() >= FAIL_OPEN_DELAY_MS;
  return failOpenStarted;
}

/**
 * The elements this can render as. A div is right almost everywhere; `li` is
 * there because this component is a wrapper, and a wrapper between `<ol>` and
 * `<li>` is not a styling detail — it empties the list. `<ol><div><li>` gives
 * a list with no items and items with no list, which axe reports as two
 * serious 1.3.1 failures and a screen reader reads as neither.
 *
 * Add to the union rather than reaching for a div and a nested child: the next
 * list wrapped in this should render as what its parent expects, not
 * reintroduce the same defect somewhere else.
 */
type ScrollRevealTag = 'div' | 'li';

interface ScrollRevealProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  /** The element to render. Inside a `<ul>`/`<ol>`, pass `"li"`. */
  as?: ScrollRevealTag;
}

export function ScrollReveal({
  children,
  className = '',
  delay = 0,
  as: Tag = 'div',
}: ScrollRevealProps) {
  /* Typed to the base element and attached through a callback: a plain
     RefObject<HTMLDivElement> would not satisfy an `li`'s ref, while a
     callback that accepts the base type satisfies both (parameter types are
     contravariant). Only IntersectionObserver reads it, and that takes an
     Element. */
  const ref = useRef<HTMLElement | null>(null);
  const setRef = (node: HTMLElement | null) => {
    ref.current = node;
  };
  const [intersected, setIntersected] = useState(false);
  /**
   * False on the server and through hydration, so the markup carries the CSS
   * fail-open class until the client bundle has demonstrably run. A bundle that
   * never parses never flips this, and the animation finishes the job.
   */
  const hydrated = useHydrated();
  const reducedMotion = usePrefersReducedMotion();
  /**
   * Reduced motion skips the reveal animation entirely.
   *
   * The last clause covers a hydration so late that the fallback is already
   * painting the element in: taking JS control at that point would snap it back
   * to opacity 0 and transition it a second time, so adopt the revealed state.
   */
  const visible = reducedMotion || intersected || (hydrated && hasFailOpenStarted());

  useEffect(() => {
    const el = ref.current;
    if (!el || !hydrated || reducedMotion) return;

    /**
     * The bottom margin extends the observation box *past* the viewport, so a
     * reveal starts while its element is still below the fold and the 850ms
     * transition has largely run by the time it crosses.
     *
     * It used to be -60px, which pulled the trigger 60px the other way — an
     * element could sit visibly above the fold and still be at opacity 0. That
     * is what kept the section heading under the hero unpainted at a 1440x800
     * viewport: laid out 31px above the fold, but 91px short of triggering.
     *
     * 120px is deliberately modest. The margin only ever pre-reveals elements
     * within 120px of the fold, so nothing further down the page is painted
     * before it is anywhere near view, and the entrance is still there to see
     * on everything a visitor scrolls to.
     */
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIntersected(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px 120px 0px' }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hydrated, reducedMotion]);

  // Pre-hydration markup: hidden, but on a timer that CSS alone will finish.
  if (!hydrated) {
    return (
      <Tag ref={setRef} className={`scroll-reveal ${className}`}>
        {children}
      </Tag>
    );
  }

  return (
    <Tag
      ref={setRef}
      className={`transition-all duration-[850ms] ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'} ${className}`}
      style={{
        transitionDelay: visible ? `${delay}ms` : '0ms',
        transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {children}
    </Tag>
  );
}

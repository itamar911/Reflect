'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/lib/hooks';

interface ScrollRevealProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}

export function ScrollReveal({ children, className = '', delay = 0 }: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [intersected, setIntersected] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  // Reduced motion skips the reveal animation entirely
  const visible = reducedMotion || intersected;

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion) return;

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
  }, [reducedMotion]);

  return (
    <div
      ref={ref}
      className={`transition-all duration-[850ms] ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'} ${className}`}
      style={{
        transitionDelay: visible ? `${delay}ms` : '0ms',
        transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {children}
    </div>
  );
}

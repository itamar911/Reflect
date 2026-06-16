'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const children = Array.from(ref.current.children) as HTMLElement[];
    children.forEach((el, i) => {
      el.style.animation = `card-enter 350ms ease-out both`;
      el.style.animationDelay = `${80 + i * 70}ms`;
    });
  }, [pathname]);

  return (
    <div key={pathname} ref={ref} className="page-enter">
      {children}
    </div>
  );
}

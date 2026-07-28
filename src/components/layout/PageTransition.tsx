'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

const FADE_DURATION_MS = 180;

// No key={pathname} here on purpose — that used to force React to unmount
// and remount the entire route subtree on every navigation (full re-render
// of every component + effect, worst on mobile CPUs). Routes now reconcile
// normally; this only toggles a class to replay a lightweight opacity fade.
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [prevPathname, setPrevPathname] = useState(pathname);
  const [fading, setFading] = useState(true);

  // Reset during render (React's documented pattern for "adjusting state
  // when a prop changes") rather than in an effect, which would cause an
  // extra committed render before the fade starts.
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setFading(true);
  }

  useEffect(() => {
    if (!fading) return;
    const id = setTimeout(() => setFading(false), FADE_DURATION_MS);
    return () => clearTimeout(id);
  }, [fading]);

  return (
    <div className={fading ? 'page-enter' : undefined}>
      {children}
    </div>
  );
}

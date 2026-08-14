'use client';

import { useCallback, useSyncExternalStore } from 'react';

// SSR-safe reads of browser state, exposed as external stores so components
// can use them during render instead of mirroring them into state from
// effects (react-hooks/set-state-in-effect).

const emptySubscribe = () => () => {};

/** True from the first post-hydration render; false on the server and during
 *  hydration — same timing as a `useEffect(() => setMounted(true))` gate. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const REDUCED_MOTION_ATTR = 'data-a11y-reduce-motion';

function subscribeReducedMotion(onChange: () => void) {
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener('change', onChange);

  // The accessibility widget writes its own toggle onto <html>, both from the
  // beforeInteractive init script and from AccessibilityProvider. Watching the
  // attribute is what lets the toggle take effect without a reload.
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [REDUCED_MOTION_ATTR],
  });

  return () => {
    mql.removeEventListener('change', onChange);
    observer.disconnect();
  };
}

function getReducedMotion(): boolean {
  // The attribute is written as the string 'true' | 'false' (never removed),
  // so this has to compare the value — presence alone would always be true.
  return (
    document.documentElement.getAttribute(REDUCED_MOTION_ATTR) === 'true' ||
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

/**
 * Live reduced-motion flag: true when the OS setting asks for reduced motion
 * OR the in-app accessibility widget's toggle is on.
 *
 * Always false on the server AND on the first client render, because neither
 * source is knowable during SSR. A snapshot that disagreed with the server
 * would be a hydration mismatch, and React 19 does not repair mismatched
 * className/style — a consumer that styles off this value would render the
 * server's markup and then never correct it. useSyncExternalStore re-renders
 * consumers right after hydration instead, which is safe.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotion,
    () => false,
  );
}

function subscribeScrollY(onChange: () => void) {
  window.addEventListener('scroll', onChange, { passive: true });
  return () => window.removeEventListener('scroll', onChange);
}

/** Live window.scrollY; 0 on the server and before hydration. */
export function useScrollY(): number {
  return useSyncExternalStore(
    subscribeScrollY,
    () => window.scrollY,
    () => 0,
  );
}

/** Live media-query match; `serverDefault` on the server / during hydration. */
export function useMediaQuery(query: string, serverDefault = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverDefault,
  );
}

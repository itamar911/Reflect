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

function subscribeReducedMotion(onChange: () => void) {
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** Live prefers-reduced-motion flag; false on the server. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
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

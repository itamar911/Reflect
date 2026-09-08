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

// ── Browser translation ──────────────────────────────────────────────────────

/**
 * Class Google's translate widget puts on <html>. Chrome's built-in translate
 * sets it too; the translate.goog proxy, measured against production, does NOT
 * — which is why the <font> probe below is the primary signal and this is only
 * a cheap corroborating one.
 */
const TRANSLATED_CLASSES = ['translated-ltr', 'translated-rtl'];

function getBrowserTranslated(): boolean {
  const root = document.documentElement;
  if (TRANSLATED_CLASSES.some((c) => root.classList.contains(c))) return true;
  // Every Google-family translator (Chrome's built-in and the proxy alike)
  // rewrites each text node into nested <font> wrappers. The app itself never
  // renders <font>, so their presence means the page has been translated.
  // A live HTMLCollection, so reading .length stays O(1) per check.
  return document.getElementsByTagName('font').length > 0;
}

function subscribeBrowserTranslated(onChange: () => void) {
  // Translation rewrites thousands of nodes in a burst, so the callback is
  // coalesced to one frame — without that this fires once per mutation across
  // the whole document.
  let frame = 0;
  const ping = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      onChange();
    });
  };
  const observer = new MutationObserver(ping);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}

/**
 * True once a browser translator has rewritten the page's text.
 *
 * Exists for one narrow reason: browser translators never walk into SVG
 * subtrees, so chart labels drawn as SVG <text> stay Hebrew on a page that is
 * otherwise fully English — which reads as a broken page rather than an
 * untranslated one. Consumers swap those few labels for real English strings.
 *
 * False on the server and through hydration, like every other hook here, so it
 * cannot introduce a server/client text mismatch: the server and the hydrating
 * client both render Hebrew, and the swap happens on a later render, long
 * after the translator has run.
 *
 * Deliberately NOT a general i18n signal. It says "some translator rewrote the
 * DOM", not which language was picked, so it is only sound for swapping text
 * the translator provably cannot reach.
 */
export function useBrowserTranslated(): boolean {
  return useSyncExternalStore(
    subscribeBrowserTranslated,
    getBrowserTranslated,
    () => false,
  );
}

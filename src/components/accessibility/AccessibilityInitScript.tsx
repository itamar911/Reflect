import Script from 'next/script';
import { A11Y_STORAGE_KEY } from './constants';

/**
 * Sets the data-a11y-* attributes on <html> synchronously, before the app's
 * own JS loads, so a returning visitor's settings (text scale, contrast,
 * grayscale, etc.) apply from the very first paint instead of flashing off
 * and then snapping on once AccessibilityProvider mounts.
 *
 * This has to be plain, standalone JS — it runs via next/script's
 * beforeInteractive strategy, ahead of any of our modules, so the reset
 * logic in constants.ts can't be imported here and is duplicated by hand.
 * Only the storage key itself is shared, via string interpolation below.
 */
export function AccessibilityInitScript() {
  return (
    // eslint-disable-next-line @next/next/no-before-interactive-script-outside-document -- this rule predates App Router; Next's own docs specify beforeInteractive belongs in app/layout.tsx there.
    <Script id="a11y-init" strategy="beforeInteractive">
      {`(function () {
        try {
          var raw = localStorage.getItem(${JSON.stringify(A11Y_STORAGE_KEY)});
          var s = raw ? JSON.parse(raw) : null;
          var reduceMotion = s && typeof s.reduceMotion === 'boolean'
            ? s.reduceMotion
            : window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          var root = document.documentElement;
          root.setAttribute('data-a11y-text-scale', String((s && s.textScale) || 100));
          root.setAttribute('data-a11y-contrast', (s && s.contrast) || 'normal');
          root.setAttribute('data-a11y-grayscale', String(!!(s && s.grayscale)));
          root.setAttribute('data-a11y-underline-links', String(!!(s && s.underlineLinks)));
          root.setAttribute('data-a11y-readable-font', String(!!(s && s.readableFont)));
          root.setAttribute('data-a11y-large-cursor', String(!!(s && s.largeCursor)));
          root.setAttribute('data-a11y-reduce-motion', String(reduceMotion));
        } catch (e) {}
      })();`}
    </Script>
  );
}

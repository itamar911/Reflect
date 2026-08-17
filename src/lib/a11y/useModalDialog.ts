'use client';

import { useEffect, useEffectEvent, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// One stack for every dialog in the app, the accessibility panel included.
// Only the topmost entry answers Escape or traps Tab, so a dialog opened on
// top of another (the fullscreen chart inside the trade sheet, the upgrade
// modal inside the strategy builder, the accessibility panel over anything)
// takes over cleanly and hands control back when it closes.
interface StackEntry { close: () => void }
const dialogStack: StackEntry[] = [];

/** Focusable *and* actually rendered — a control inside a collapsed panel is
    in the DOM but must not be a stop in the cycle. */
function tabbableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => {
      if (el.closest('[inert]')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 || r.height > 0;
    });
}

/**
 * Modal dialog behaviour for an already-styled overlay: dialog semantics,
 * focus moved in on open, a wrap-around focus trap, Escape on the topmost
 * dialog only, and focus returned to whatever had it before.
 *
 * Restore target is captured from `document.activeElement` at open time
 * rather than taken from the caller. Three of this app's overlays have no
 * trigger element to hand over — the trade sheet opens from an
 * `open-trade-form` window event, the upgrade modal from an async 403, the
 * demo upsell from a fetch interception — and capturing covers all of them,
 * plus close-by-route-change and close-by-completing-the-action, with one
 * code path.
 *
 * Deliberately no background inertness: `inert` on the page would take the
 * accessibility widget's trigger with it (it sits at z-110, above every
 * modal here), leaving a user unable to change contrast or text size
 * mid-flow. Tab cycles inside the dialog instead, so the trigger stays
 * clickable and opens the panel as a nested dialog on this same stack.
 */
export function useModalDialog<T extends HTMLElement = HTMLDivElement>({
  open,
  onClose,
  label,
  labelledBy,
  initialFocusRef,
  initialFocus = 'first-tabbable',
}: {
  open: boolean;
  onClose: () => void;
  /** Accessible name, for a dialog with no visible title of its own. */
  label?: string;
  /** Id of the existing visible title element — preferred over `label`. */
  labelledBy?: string;
  /** Explicit landing spot for focus. Wins over `initialFocus`. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Fallback when no ref is given. `'container'` suits read-first dialogs:
      focus the dialog itself so a screen reader starts at its title instead
      of at whichever control happens to come first in the markup (usually a
      close button). */
  initialFocus?: 'first-tabbable' | 'container';
}) {
  const containerRef = useRef<T>(null);

  // Keep the effect on the latest values without resubscribing: it must run
  // exactly once per open, or it would re-capture the restore target and
  // yank focus back to the top of the dialog on every render.
  const close = useEffectEvent(() => onClose());
  const resolveInitialFocus = useEffectEvent(() =>
    initialFocusRef?.current ?? (initialFocus === 'container' ? containerRef.current : null));

  useEffect(() => {
    if (!open) return;
    // Annotated as HTMLElement rather than the generic T: the trap only ever
    // needs the base element API, and narrowing a `T | null` const inside the
    // nested key handler below doesn't survive.
    const container: HTMLElement | null = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const entry: StackEntry = { close: () => close() };
    dialogStack.push(entry);

    (resolveInitialFocus() ?? tabbableWithin(container)[0] ?? container).focus();

    // An arrow const, not a function declaration: a hoisted declaration could
    // in principle run before the null check above, so TS drops the narrowing
    // of `container` inside one.
    const onKeyDown = (e: KeyboardEvent) => {
      // Not the topmost dialog — the one above owns Escape and the trap.
      if (dialogStack[dialogStack.length - 1] !== entry) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        entry.close();
        return;
      }
      if (e.key !== 'Tab') return;

      const stops = tabbableWithin(container);
      const active = document.activeElement;
      if (stops.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }

      const first = stops[0];
      const last = stops[stops.length - 1];
      const outside = !active || !container.contains(active) || active === container;

      if (e.shiftKey && (outside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const i = dialogStack.indexOf(entry);
      if (i !== -1) dialogStack.splice(i, 1);
      // The trigger can be gone by now — a route change unmounted it, or it
      // lived in a popup menu that closed when the dialog opened. Focusing a
      // detached node silently drops focus onto <body>, which is the exact
      // "lost my place" failure this hook exists to prevent, so fall back to
      // the page's content landmark.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
      else document.getElementById('main-content')?.focus();
    };
  }, [open]);

  return {
    dialogProps: {
      ref: containerRef,
      role: 'dialog' as const,
      'aria-modal': true,
      tabIndex: -1,
      ...(labelledBy ? { 'aria-labelledby': labelledBy } : {}),
      ...(label ? { 'aria-label': label } : {}),
    },
  };
}

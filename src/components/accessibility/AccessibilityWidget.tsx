'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Accessibility, RotateCcw, X } from 'lucide-react';
import { useAccessibility } from './AccessibilityContext';
import type { AccessibilityContrast } from './constants';
import { TEXT_SCALE_MAX, TEXT_SCALE_MIN } from './constants';

const CONTRAST_OPTIONS: { value: AccessibilityContrast; label: string }[] = [
  { value: 'normal', label: 'רגיל' },
  { value: 'high', label: 'גבוהה' },
  { value: 'inverted', label: 'הפוכה' },
];

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AccessibilityWidget() {
  const a11y = useAccessibility();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const panelId = `${baseId}-panel`;

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Focus trap: moves focus into the panel on open, cycles Tab/Shift+Tab
  // within it, and closes on Escape — returning focus to the trigger.
  useEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
    const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;

      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="הגדרות נגישות"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
        className="fixed bottom-5 right-5 z-[110] flex h-14 w-14 items-center justify-center rounded-full text-white transition-transform duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 sm:bottom-6 sm:right-6"
        style={{ backgroundColor: 'var(--color-tg-primary)', boxShadow: '0 4px 16px rgba(0, 210, 210, 0.4)' }}
      >
        <Accessibility size={28} aria-hidden />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[115] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            dir="rtl"
            className="w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-2xl p-6 flex flex-col gap-5"
            style={{
              background: 'var(--color-tg-surface)',
              border: '1px solid var(--color-tg-border)',
              boxShadow: '0 24px 64px rgba(0,0,0,0.8)',
            }}
          >
            <div className="flex items-center justify-between">
              <h2 id={headingId} className="text-lg font-bold" style={{ color: 'var(--color-tg-text)' }}>
                הגדרות נגישות
              </h2>
              <button
                type="button"
                onClick={close}
                aria-label="סגור"
                className="p-2 -m-2 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tg-primary"
                style={{ color: 'var(--text-muted)' }}
              >
                <X size={20} aria-hidden />
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--color-tg-text)' }}>
                גודל טקסט
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={a11y.decreaseTextScale}
                  disabled={a11y.textScale <= TEXT_SCALE_MIN}
                  aria-label="הקטן טקסט"
                  className="w-10 h-10 rounded-lg font-bold text-base disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tg-primary"
                  style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text)' }}
                >
                  א-
                </button>
                <span
                  className="flex-1 text-center text-sm font-bold tabular-nums"
                  style={{ color: 'var(--color-tg-primary)' }}
                  aria-live="polite"
                >
                  {a11y.textScale}%
                </span>
                <button
                  type="button"
                  onClick={a11y.increaseTextScale}
                  disabled={a11y.textScale >= TEXT_SCALE_MAX}
                  aria-label="הגדל טקסט"
                  className="w-10 h-10 rounded-lg font-bold text-base disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tg-primary"
                  style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text)' }}
                >
                  א+
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--color-tg-text)' }}>
                ניגודיות
              </span>
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="ניגודיות">
                {CONTRAST_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => a11y.setContrast(opt.value)}
                    aria-pressed={a11y.contrast === opt.value}
                    className="py-2 rounded-lg text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tg-primary"
                    style={
                      a11y.contrast === opt.value
                        ? { background: 'var(--color-tg-primary)', color: '#000' }
                        : { background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text)' }
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <ToggleRow label="גווני אפור" pressed={a11y.grayscale} onClick={a11y.toggleGrayscale} />
              <ToggleRow label="הדגשת קישורים" pressed={a11y.underlineLinks} onClick={a11y.toggleUnderlineLinks} />
              <ToggleRow label="גופן קריא" pressed={a11y.readableFont} onClick={a11y.toggleReadableFont} />
              <ToggleRow label="סמן עכבר גדול" pressed={a11y.largeCursor} onClick={a11y.toggleLargeCursor} />
              <ToggleRow label="עצירת אנימציות" pressed={a11y.reduceMotion} onClick={a11y.toggleReduceMotion} />
            </div>

            <button
              type="button"
              onClick={a11y.reset}
              className="w-full py-2.5 rounded-xl text-sm font-semibold mt-1 flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tg-primary"
              style={{
                background: 'var(--color-tg-primary-muted)',
                color: 'var(--color-tg-primary)',
                border: '1px solid rgba(0,210,210,0.3)',
              }}
            >
              <RotateCcw size={16} aria-hidden />
              איפוס הגדרות
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function ToggleRow({ label, pressed, onClick }: { label: string; pressed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tg-primary"
      style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text)' }}
    >
      {label}
      <span
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
        style={{ background: pressed ? 'var(--color-tg-primary)' : 'var(--color-tg-border)' }}
        aria-hidden
      >
        <span
          className="absolute h-3.5 w-3.5 rounded-full bg-white transition-all"
          style={{ insetInlineStart: pressed ? 'calc(100% - 16px)' : '2px' }}
        />
      </span>
    </button>
  );
}

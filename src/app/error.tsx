'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * Route-level error boundary for every segment under app/ that does not define
 * its own. Without one, a render- or commit-phase throw unmounts the tree and
 * the visitor is left with an empty <body> and no way forward.
 *
 * The failure this was written for is browser translation: Chrome's built-in
 * translate (and the translate.goog proxy) replace every text node with a
 * <font> wrapper, and any element React later has to insert next to one of
 * those nodes throws, because the sibling it recorded is no longer a child.
 * The specific site that did that here is fixed (see HeroMock's CTA), but the
 * class of bug is one bare text node away from returning, and a compliance
 * reviewer reading the page through a translator is exactly who would hit it.
 * So this boundary exists to make that failure mode a legible, recoverable
 * message instead of a blank page.
 *
 * `reset()` re-renders the same tree in place, which the translator will
 * simply translate again — so a hard reload is offered alongside it as the
 * option that actually clears a translation-induced fault.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[reflect] route error boundary:', error);
  }, [error]);

  return (
    <div
      dir="rtl"
      className="min-h-screen flex items-center justify-center px-4 py-16"
      style={{ background: 'var(--color-tg-bg, #292930)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl border p-8 text-center"
        style={{
          borderColor: 'var(--color-tg-border, #42424a)',
          background: 'var(--color-tg-surface, #303036)',
        }}
      >
        <span
          className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full"
          style={{ background: 'rgba(245, 158, 11, 0.12)' }}
        >
          <AlertTriangle size={24} style={{ color: '#f59e0b' }} aria-hidden="true" />
        </span>

        <h1 className="text-xl font-bold text-white">אירעה שגיאה בטעינת העמוד</h1>

        <p className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--color-tg-muted, #ffffff)', opacity: 0.7 }}>
          רענון העמוד פותר את זה ברוב המקרים. אם הדפדפן מתרגם את העמוד אוטומטית,
          כיבוי התרגום וטעינה מחדש אמורים לעזור.
        </p>

        {/* The reader most likely to meet this page is someone whose browser is
            translating the site, so the recovery instruction is repeated in
            English rather than left to the translator that may have just
            failed. */}
        <p lang="en" dir="ltr" className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--color-tg-muted, #ffffff)', opacity: 0.55 }}>
          Something went wrong rendering this page. Reloading usually fixes it. If your
          browser is auto-translating the page, turning translation off and reloading should help.
        </p>

        <div className="mt-7 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-base font-bold"
            style={{
              background: 'rgba(0, 210, 210, 0.14)',
              border: '1px solid rgba(0, 210, 210, 0.5)',
              color: '#7ff3f3',
            }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            <span>רענן את העמוד</span>
          </button>

          <button
            type="button"
            onClick={reset}
            className="w-full rounded-xl py-2.5 text-sm font-semibold"
            style={{ color: 'var(--color-tg-muted, #ffffff)', opacity: 0.75 }}
          >
            <span>נסה שוב בלי לרענן</span>
          </button>
        </div>

        {error.digest && (
          <p className="mt-6 text-xs" dir="ltr" style={{ color: 'var(--color-tg-muted, #ffffff)', opacity: 0.4 }}>
            <span>{`digest: ${error.digest}`}</span>
          </p>
        )}
      </div>
    </div>
  );
}

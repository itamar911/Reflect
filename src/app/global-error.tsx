'use client';

import { useEffect } from 'react';

/**
 * Last-resort boundary: catches throws in the root layout itself, which
 * app/error.tsx sits inside of and therefore cannot handle. It replaces the
 * document, so it renders its own <html>/<body> and cannot rely on the fonts,
 * providers or token stylesheet the root layout would have supplied — every
 * value here is literal on purpose. Lucide is skipped for the same reason.
 *
 * Only reachable in a production build; in dev the error overlay takes over.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[reflect] global error boundary:', error);
  }, [error]);

  return (
    <html lang="he" dir="rtl">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem 1rem',
          background: '#292930',
          color: '#f1f5f9',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        }}
      >
        <div
          style={{
            maxWidth: '28rem',
            width: '100%',
            textAlign: 'center',
            border: '1px solid #42424a',
            background: '#303036',
            borderRadius: '1rem',
            padding: '2rem',
          }}
        >
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
            אירעה שגיאה בטעינת העמוד
          </h1>

          <p style={{ marginTop: '0.75rem', fontSize: '0.875rem', lineHeight: 1.7, opacity: 0.7 }}>
            רענון העמוד פותר את זה ברוב המקרים. אם הדפדפן מתרגם את העמוד אוטומטית,
            כיבוי התרגום וטעינה מחדש אמורים לעזור.
          </p>

          <p lang="en" dir="ltr" style={{ marginTop: '0.75rem', fontSize: '0.875rem', lineHeight: 1.7, opacity: 0.55 }}>
            Something went wrong rendering this page. Reloading usually fixes it. If your
            browser is auto-translating the page, turning translation off and reloading should help.
          </p>

          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: '1.75rem',
              width: '100%',
              padding: '0.75rem',
              fontSize: '1rem',
              fontWeight: 700,
              borderRadius: '0.75rem',
              cursor: 'pointer',
              background: 'rgba(0, 210, 210, 0.14)',
              border: '1px solid rgba(0, 210, 210, 0.5)',
              color: '#7ff3f3',
            }}
          >
            <span>רענן את העמוד</span>
          </button>

          {error.digest && (
            <p dir="ltr" style={{ marginTop: '1.5rem', fontSize: '0.75rem', opacity: 0.4 }}>
              <span>{`digest: ${error.digest}`}</span>
            </p>
          )}
        </div>
      </body>
    </html>
  );
}

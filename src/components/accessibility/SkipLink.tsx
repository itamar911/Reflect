'use client';

/** Id carried by every route's content landmark — the skip link's target.
    Each layout owns exactly one: AppShell (the 11 app routes), the (auth)
    layout, the (protected) layout, and the standalone public pages. */
export const MAIN_CONTENT_ID = 'main-content';

// Rendered first inside <body> (src/app/layout.tsx) so it is the first tab
// stop on every route. Visually off-screen until focused — see .skip-link in
// globals.css, which pins it to the top inline-start corner when revealed.
//
// The href alone is enough in modern browsers (the target carries
// tabIndex={-1}, so fragment navigation moves focus to it), but the click
// handler makes it explicit rather than relying on that behaviour, and keeps
// the URL free of a #main-content fragment that would survive in history.
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="link-button skip-link"
      onClick={(e) => {
        const target = document.getElementById(MAIN_CONTENT_ID);
        if (!target) return;
        e.preventDefault();
        target.focus();
        target.scrollIntoView({ block: 'start' });
      }}
    >
      דלג לתוכן הראשי
    </a>
  );
}

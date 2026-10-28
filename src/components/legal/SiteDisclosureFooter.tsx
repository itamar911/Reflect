import Link from 'next/link';
import { FooterDisclosures } from './FooterDisclosures';

/** The four standing legal routes, in the order they are read. */
const LEGAL_LINKS = [
  { href: '/risk-disclosure', label: 'גילוי סיכון' },
  { href: '/terms', label: 'תנאי שימוש' },
  { href: '/privacy', label: 'מדיניות פרטיות' },
  { href: '/accessibility', label: 'הצהרת נגישות' },
] as const;

/**
 * The risk disclosure as a page footer, for every route that is not the
 * landing page (which has its own richer footer and renders RiskDisclosure
 * inside it).
 *
 * It carries the risk disclosure and the NinjaTrader trademark attribution
 * together (see FooterDisclosures).
 *
 * The guideline is "every page", so this is mounted at the layout level of
 * each route group rather than per page — that way nested and dynamic routes
 * inherit it and no future route can be added without it:
 *
 *   src/app/(app)/…        → AppShell, inside the sidebar's content column
 *   src/app/(auth)/…       → AuthLayout, under the centred card
 *   src/app/(protected)/…  → ProtectedLayout
 *   src/app/page.tsx       → LandingFooter
 *   standalone legal pages → rendered directly
 *
 * Two lines by construction: the links, then the prescribed disclosures. The
 * block was compacted (REF-118) by taking space out of the padding and the
 * gaps — **not** out of the text.
 *
 * What must not be done to make it shorter, each already tried and reversed:
 *
 *   - Dropping the English risk paragraph or the trademark attribution. Both
 *     are prescribed wording required on every page; this is audit finding F4
 *     (commit 36cfbe9), and FooterDisclosures carries the long-form note.
 *   - Replacing a paragraph with a link to /risk-disclosure. The guidelines
 *     permit a link only as a supplement to the visible text.
 *   - Shrinking the disclosures below 14px, or hiding them behind a
 *     disclosure/accordion. They have a legibility floor and must be easily
 *     visible — see disclosureStyle.ts, which owns that decision. A collapsed
 *     paragraph is not visible at all on the views where it is collapsed.
 */
export function SiteDisclosureFooter({ className = '' }: { className?: string }) {
  return (
    <footer
      dir="rtl"
      className={`border-t px-4 md:px-6 pt-6 ${className}`}
      style={{
        borderColor: 'var(--color-tg-border)',
        // Clearance for the fixed bottom-corner stack, derived from the tokens
        // the buttons themselves position against (globals.css) rather than
        // guessed as a padding step — slot 0 is the accessibility trigger and
        // it renders on every route this footer does. It occupies
        // inset → inset + size, so clearing it is that plus a visual gap.
        // Replaces a flat pb-40 (160px) that was ~2x what the stack needs and
        // carried no recorded reason for the figure.
        paddingBottom: 'calc(var(--floating-slot-0) + var(--floating-size) + 1.5rem)',
      }}
    >
      {/* 820px to share an edge with the legal pages' own column
          (terms/privacy/accessibility all run max-w-[820px]), which this
          footer sits directly beneath on three of its seven mount points. */}
      <div className="max-w-[820px] mx-auto flex flex-col gap-3">
        {/* Reading order is navigation first, fine print last — the same order
            the landing footer uses, so the two read alike. */}
        {/* Hovering to --color-tg-text-2, not --color-tg-primary: html.light
            does not override the accent token, so a hovered link here measured
            1.88:1 over the white page (REF-96) — and a hovered link is still
            text under WCAG 1.4.3, which axe does not check because it never
            evaluates hover. Resting stays --color-tg-muted; these are fine
            print and are meant to read as subordinate. 6.05:1 → 9.77:1 light,
            6.42:1 → 14.44:1 dark. */}
        <nav className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {LEGAL_LINKS.map(({ href, label }, i) => (
            <span key={href} className="flex items-center gap-x-2">
              {/* The separator is decoration between two links, so it is
                  hidden from assistive tech — read aloud it is just an
                  interruption between two list items. */}
              {i > 0 && <span aria-hidden="true" className="text-sm text-tg-muted">·</span>}
              {/* prefetch={false} (REF-129 item 1). This footer is on every
                  route in the app, and Link prefetch is viewport-triggered —
                  so the four legal routes were being fetched ahead for every
                  trader who scrolled to the bottom of any page, measured at 16
                  RSC requests. They are fine print: the trader who wants them
                  is a rare one, and they are static pages that load fast from
                  a cold click anyway. Nothing here is worth prefetching. */}
              <Link href={href} prefetch={false} className="text-sm text-tg-muted hover:text-tg-text-2 transition-colors">
                {label}
              </Link>
            </span>
          ))}
        </nav>

        <FooterDisclosures />
      </div>
    </footer>
  );
}

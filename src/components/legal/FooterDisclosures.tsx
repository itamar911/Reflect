import Link from 'next/link';
import { RiskDisclosure } from './RiskDisclosure';

/**
 * The site-level risk disclosure as it appears in a footer: the Hebrew
 * wording in full, with a link to the complete bilingual text beneath it.
 *
 * The link is *in addition to* the text, never instead of it. The guideline
 * requires the full wording to be visible on the page and permits a link only
 * as a supplement, so do not "tidy" this into a link-only footer — dropping
 * the paragraph breaks compliance even though the link still works.
 *
 * What is deliberately NOT here:
 *
 *   - **The English risk wording.** It lives on /risk-disclosure, which this
 *     block links to. Printing both languages in every footer doubled the
 *     block's height for a reader who needs one of them.
 *   - **The NinjaTrader trademark attribution.** It moved to
 *     PlatformsSection, adjacent to the logo and the platform's name. It is
 *     English-only by prescription and has no Hebrew twin, so it could not be
 *     shortened the way the risk text could — and it is required on any page
 *     that names the platform. Sitting next to the mention satisfies that more
 *     directly than a footer did. A future page that names NinjaTrader without
 *     rendering PlatformsSection must render NinjaTraderAttribution itself.
 *   - **The testimonial disclosure.** It qualifies a specific claim and stays
 *     with the testimonials.
 */
export function FooterDisclosures({
  className = '',
  /** Match the surrounding footer: the landing footer is a centred column,
      the app-shell footer is start-aligned. */
  align = 'start',
}: {
  className?: string;
  align?: 'center' | 'start';
}) {
  const centred = align === 'center';

  return (
    <div
      dir="rtl"
      className={`w-full flex flex-col gap-3 ${centred ? 'items-center text-center' : 'items-start text-start'} ${className}`}
    >
      <RiskDisclosure languages="he" />

      <Link
        href="/risk-disclosure"
        className="text-xs font-normal underline underline-offset-4 transition-colors hover:text-tg-primary"
        style={{ color: 'var(--color-tg-disclosure)' }}
      >
        קראו את הגילוי הנאות המלא
      </Link>
    </div>
  );
}

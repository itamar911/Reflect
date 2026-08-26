import Link from 'next/link';
import { RiskDisclosure } from './RiskDisclosure';
import { NinjaTraderAttribution } from './NinjaTraderAttribution';

/**
 * The two page-level disclosures that belong to the site rather than to any
 * one section: the risk disclosure and the NinjaTrader trademark attribution.
 *
 * Grouped and pushed to the footer deliberately. Both were previously
 * mid-page — the risk text under the hero's own footer block, the attribution
 * inside the supported-platforms section — where they carried the visual
 * weight of content. In the footer they are still on every page (both footers
 * render on every route), still complete, and no longer competing with the
 * page's argument.
 *
 * The link is *in addition to* the text, never instead of it: the guideline
 * requires the full wording to be visible on the page, and permits a link only
 * as a supplement. Removing either paragraph in favour of the link would
 * break compliance, so do not "tidy" this into a link-only footer.
 *
 * The testimonial disclosure is deliberately NOT here — it qualifies a
 * specific claim and has to stay adjacent to the testimonials themselves.
 */
export function FooterDisclosures({ className = '' }: { className?: string }) {
  return (
    <div dir="rtl" className={`w-full flex flex-col gap-4 text-start ${className}`}>
      <RiskDisclosure />

      <NinjaTraderAttribution />

      <Link
        href="/risk-disclosure"
        className="text-sm font-normal self-start underline underline-offset-4 transition-colors hover:text-tg-primary"
        style={{ color: 'var(--color-tg-disclosure)' }}
      >
        קראו את הגילוי הנאות המלא
      </Link>
    </div>
  );
}

import Link from 'next/link';
import { NINJATRADER_ATTRIBUTION, RISK_DISCLOSURE_HE } from './disclosureText';
import { DISCLOSURE_TEXT_CLASS, DISCLOSURE_TEXT_STYLE } from './disclosureStyle';

/**
 * The site-level disclosures as they appear in a footer: two flowing
 * paragraphs at the footer's own width, each led by a bold inline label — the
 * pattern the rest of the NinjaTrader vendor ecosystem uses.
 *
 * Why the label carries the weight instead of a box: a bordered block at a
 * narrow measure reads as a *component*, something the page is presenting. A
 * labelled paragraph running the width of the footer reads as fine print,
 * which is what these are. The label also does the job the removed heading
 * did, and does it for screen readers too — it is read inline, ahead of the
 * text it names, rather than as an extra landmark in the footer.
 *
 * The link is *in addition to* the text, never instead of it. The guideline
 * requires the full wording to be visible on the page and permits a link only
 * as a supplement, so do not "tidy" this into a link-only footer — dropping
 * the paragraph breaks compliance even though the link still works.
 *
 * Two deliberate absences:
 *
 *   - **The English risk wording.** It lives on /risk-disclosure, which the
 *     inline link points at. Printing both languages in every footer doubled
 *     the block's height for a reader who needs one of them. The prescribed
 *     English must stay reachable and complete somewhere on the site — this is
 *     a footer-density decision, not licence to retire it.
 *   - **The testimonial disclosure.** It qualifies a specific claim and stays
 *     with the testimonials it refers to.
 *
 * The trademark attribution IS here, and stays here: it is required on every
 * page that names the platform, and the footer is the only thing that renders
 * on every page. It is English-only by prescription, so its label is English
 * too — a Hebrew label on an LTR paragraph puts a lone RTL run at the head of
 * a left-aligned line, which resolves badly and reads worse than it looks.
 */
export function FooterDisclosures({ className = '' }: { className?: string }) {
  return (
    // Capped rather than run to the footer's full 1360px. At full width these
    // lines ran ~210 characters, which is past the point where the eye reliably
    // finds the start of the next one; 1100px pulls that back to ~170 while
    // keeping the flowing full-width look that makes the block read as
    // boilerplate rather than as content. Start-aligned, and centred as a block
    // by the footer's own centred column.
    <div className={`w-full max-w-[1100px] flex flex-col gap-3 text-start ${className}`}>
      <p dir="rtl" className={DISCLOSURE_TEXT_CLASS} style={DISCLOSURE_TEXT_STYLE}>
        <strong className="font-bold">גילוי סיכון: </strong>
        {RISK_DISCLOSURE_HE}{' '}
        <Link
          href="/risk-disclosure"
          className="underline underline-offset-2 transition-colors hover:text-tg-primary"
          style={{ color: 'inherit' }}
        >
          קראו את הגילוי הנאות המלא
        </Link>
      </p>

      <p dir="ltr" className={`${DISCLOSURE_TEXT_CLASS} text-start`} style={DISCLOSURE_TEXT_STYLE}>
        <strong className="font-bold">Trademark: </strong>
        {NINJATRADER_ATTRIBUTION}
      </p>
    </div>
  );
}

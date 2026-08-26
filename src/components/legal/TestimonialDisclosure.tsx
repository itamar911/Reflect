import { TESTIMONIAL_DISCLOSURE_EN, TESTIMONIAL_DISCLOSURE_HE } from './disclosureText';
import { DISCLOSURE_TEXT_CLASS, DISCLOSURE_TEXT_STYLE, DISCLOSURE_MEASURE } from './disclosureStyle';

/**
 * Required alongside any testimonial on the site.
 *
 * Unlike the risk disclosure and the trademark attribution, this one cannot
 * move to the footer or to another page: it qualifies a specific claim, so it
 * has to sit with the thing it qualifies. It takes the footer's fine-print
 * treatment instead — 14px, weight 400, bold inline label — so the two read as
 * the same class of text wherever they appear.
 *
 * It keeps the narrow measure that the footer dropped. The footer's paragraphs
 * span a footer, where a long thin ribbon reads as boilerplate; this one sits
 * under a centred grid of cards, where a full-width line would be wider than
 * anything above it.
 *
 * The English label is "Disclosure:", not "Testimonials:" — the sentence
 * already opens with the word "Testimonials", and labelling it with its own
 * first word reads as a stutter.
 *
 * Both languages render here, since there is no second page carrying the full
 * text the way /risk-disclosure carries the risk wording.
 *
 * If any testimonial on the page is ever paid for, that fact has to be
 * disclosed too — a payment disclosure is a separate requirement this
 * component does not cover.
 */
export function TestimonialDisclosure({ className = '' }: { className?: string }) {
  return (
    <div className={`text-xs flex flex-col gap-2.5 ${DISCLOSURE_MEASURE} ${className}`}>
      <p dir="rtl" className={DISCLOSURE_TEXT_CLASS} style={DISCLOSURE_TEXT_STYLE}>
        <strong className="font-bold">עדויות: </strong>
        {TESTIMONIAL_DISCLOSURE_HE}
      </p>

      <p dir="ltr" className={`${DISCLOSURE_TEXT_CLASS} text-start`} style={DISCLOSURE_TEXT_STYLE}>
        <strong className="font-bold">Disclosure: </strong>
        {TESTIMONIAL_DISCLOSURE_EN}
      </p>
    </div>
  );
}

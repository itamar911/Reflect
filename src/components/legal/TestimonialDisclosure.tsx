import { TESTIMONIAL_DISCLOSURE_EN, TESTIMONIAL_DISCLOSURE_HE } from './disclosureText';
import { disclosureTextProps, DISCLOSURE_MEASURE, type DisclosureVariant } from './disclosureStyle';

/**
 * Required alongside any testimonial on the site.
 *
 * Unlike the risk disclosure and the trademark attribution, this one cannot
 * move to the footer or to another page: it qualifies a specific claim, so it
 * has to sit with the thing it qualifies. It gets the same fine-print
 * treatment instead — subordinate, still legible.
 *
 * Both languages render here, since there is no second page carrying the full
 * text the way /risk-disclosure carries the risk wording.
 *
 * If any testimonial on the page is ever paid for, that fact has to be
 * disclosed too — a payment disclosure is a separate requirement this
 * component does not cover.
 */
export function TestimonialDisclosure({
  className = '',
  variant = 'footnote',
}: {
  className?: string;
  variant?: DisclosureVariant;
}) {
  const text = disclosureTextProps(variant);
  const measure = variant === 'footnote' ? DISCLOSURE_MEASURE : '';

  return (
    <section
      aria-label="גילוי נאות בנוגע לעדויות"
      className={`flex flex-col gap-2.5 ${className}`}
    >
      <p dir="rtl" style={text.style} className={`${text.className} ${measure}`}>
        {TESTIMONIAL_DISCLOSURE_HE}
      </p>

      <p dir="ltr" style={text.style} className={`${text.className} ${measure} text-start`}>
        {TESTIMONIAL_DISCLOSURE_EN}
      </p>
    </section>
  );
}

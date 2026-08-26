import { TESTIMONIAL_DISCLOSURE_EN, TESTIMONIAL_DISCLOSURE_HE } from './disclosureText';
import { disclosureTextProps, type DisclosureVariant } from './disclosureStyle';

/**
 * Required alongside any testimonial on the site.
 *
 * Unlike the risk disclosure and the trademark attribution, this one cannot
 * move to the footer: it qualifies a specific claim, so it has to sit with the
 * thing it qualifies. It gets the same fine-print treatment as the footer
 * disclosures instead — subordinate, still legible.
 *
 * The English is the prescribed wording and the Hebrew is its approved
 * equivalent; both render, and the English block is dir="ltr" so the RTL shell
 * cannot reorder its punctuation.
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

  return (
    <section
      aria-label="גילוי נאות בנוגע לעדויות"
      className={`w-full flex flex-col gap-2.5 ${className}`}
    >
      <p dir="rtl" {...text}>
        {TESTIMONIAL_DISCLOSURE_HE}
      </p>

      <p dir="ltr" {...text} className={`${text.className} text-start`}>
        {TESTIMONIAL_DISCLOSURE_EN}
      </p>
    </section>
  );
}

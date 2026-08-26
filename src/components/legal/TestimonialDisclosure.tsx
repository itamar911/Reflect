import { TESTIMONIAL_DISCLOSURE_EN, TESTIMONIAL_DISCLOSURE_HE } from './disclosureText';

/**
 * Required alongside any testimonial on the site, prominently displayed.
 *
 * Same construction as RiskDisclosure, for the same reason: body-size text in
 * the primary colour, never the muted token, because "prominently displayed"
 * rules out a grey footnote. The English is the prescribed wording and the
 * Hebrew is its approved equivalent; both render, and the English block is
 * dir="ltr" so the RTL shell cannot reorder its punctuation.
 *
 * Not rendered as a bare paragraph inside SocialProofSection: it lives here so
 * that if testimonials ever appear on a second page, the disclosure comes with
 * them rather than being retyped and drifting.
 *
 * If any testimonial on the page is ever paid for, that fact has to be
 * disclosed here too — a payment disclosure is a separate requirement that
 * this component does not currently cover.
 */
export function TestimonialDisclosure({ className = '' }: { className?: string }) {
  return (
    <section
      aria-label="גילוי נאות בנוגע לעדויות"
      className={`w-full rounded-2xl border px-5 py-5 md:px-7 md:py-6 flex flex-col gap-4 ${className}`}
      style={{
        borderColor: 'var(--color-tg-border)',
        background: 'rgba(255,255,255,0.03)',
      }}
    >
      <p dir="rtl" className="text-base leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
        {TESTIMONIAL_DISCLOSURE_HE}
      </p>

      <p
        dir="ltr"
        className="text-base leading-relaxed text-start"
        style={{ color: 'var(--color-tg-text)' }}
      >
        {TESTIMONIAL_DISCLOSURE_EN}
      </p>
    </section>
  );
}

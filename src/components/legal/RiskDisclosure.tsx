import { RISK_DISCLOSURE_EN, RISK_DISCLOSURE_HE } from './disclosureText';
import { disclosureTextProps, type DisclosureVariant } from './disclosureStyle';

/**
 * The site-wide risk disclosure, in both languages.
 *
 * Both paragraphs are mandatory and mandatory *together*: NinjaTrader
 * prescribes the English wording, and the app is Hebrew-first, so a Hebrew
 * reader has to be able to read it too. The English block carries dir="ltr"
 * for the same reason the recharts containers do — it is genuinely LTR content
 * sitting inside an RTL shell, and letting the shell reorder its punctuation
 * would corrupt prescribed wording.
 *
 * No border, no card, no fill: the text has to be present and legible, not
 * framed as a feature. See disclosureStyle.ts for how the weight is set.
 */
export function RiskDisclosure({
  className = '',
  /** Off on /risk-disclosure, where the page's own <h1> already says this. */
  showHeading = true,
  variant = 'footnote',
}: {
  className?: string;
  showHeading?: boolean;
  variant?: DisclosureVariant;
}) {
  const text = disclosureTextProps(variant);

  return (
    <section
      aria-label="גילוי נאות בדבר סיכון"
      className={`w-full flex flex-col gap-3 ${className}`}
    >
      {showHeading && (
        <h2 className="text-sm font-semibold" style={{ color: 'var(--color-tg-disclosure)' }}>
          גילוי נאות בדבר סיכון
        </h2>
      )}

      <p dir="rtl" {...text}>
        {RISK_DISCLOSURE_HE}
      </p>

      <p dir="ltr" {...text} className={`${text.className} text-start`}>
        {RISK_DISCLOSURE_EN}
      </p>
    </section>
  );
}

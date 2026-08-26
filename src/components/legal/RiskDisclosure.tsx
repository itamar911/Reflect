import { RISK_DISCLOSURE_EN, RISK_DISCLOSURE_HE } from './disclosureText';
import { disclosureTextProps, DISCLOSURE_MEASURE, type DisclosureVariant } from './disclosureStyle';

/**
 * The site-wide risk disclosure.
 *
 * `languages` decides how much of it renders:
 *
 *   'both'  — the Hebrew and the prescribed English. Used on
 *             /risk-disclosure, the canonical home of the full text.
 *   'he'    — Hebrew only. Used in the site footer, where printing both
 *             doubled the block's height for a reader who only needs one of
 *             them. The English is not dropped from the site: /risk-disclosure
 *             carries it, and the footer links straight there.
 *
 * The prescribed English wording must remain reachable and complete somewhere
 * on the site — 'he' is a footer-density decision, not licence to retire it.
 *
 * The English block carries dir="ltr" for the same reason the recharts
 * containers do: it is genuinely LTR content inside an RTL shell, and letting
 * the shell reorder its punctuation would corrupt prescribed wording.
 */
export function RiskDisclosure({
  className = '',
  /** Off on /risk-disclosure, where the page's own <h1> already says this. */
  showHeading = true,
  variant = 'footnote',
  languages = 'both',
}: {
  className?: string;
  showHeading?: boolean;
  variant?: DisclosureVariant;
  languages?: 'both' | 'he';
}) {
  const text = disclosureTextProps(variant);
  const measure = variant === 'footnote' ? DISCLOSURE_MEASURE : '';

  return (
    <section
      aria-label="גילוי נאות בדבר סיכון"
      className={`flex flex-col gap-3 ${className}`}
    >
      {showHeading && (
        <h2 className="text-xs font-semibold" style={{ color: 'var(--color-tg-disclosure)' }}>
          גילוי נאות בדבר סיכון
        </h2>
      )}

      <p dir="rtl" style={text.style} className={`${text.className} ${measure}`}>
        {RISK_DISCLOSURE_HE}
      </p>

      {languages === 'both' && (
        <p dir="ltr" style={text.style} className={`${text.className} ${measure} text-start`}>
          {RISK_DISCLOSURE_EN}
        </p>
      )}
    </section>
  );
}

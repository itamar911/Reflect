import { RISK_DISCLOSURE_EN, RISK_DISCLOSURE_HE } from './disclosureText';
import { disclosureTextProps, type DisclosureVariant } from './disclosureStyle';

/**
 * The full risk disclosure, both languages, for /risk-disclosure — the
 * canonical home of the complete text and the URL every footer links to.
 *
 * The footer does NOT use this component: it renders the Hebrew wording as a
 * labelled inline paragraph instead (see FooterDisclosures), which is a
 * different enough shape that sharing one component meant a prop for every
 * difference. Both read the same constants, so the wording cannot drift.
 *
 * The English block carries dir="ltr" for the same reason the recharts
 * containers do: it is genuinely LTR content inside an RTL shell, and letting
 * the shell reorder its punctuation would corrupt prescribed wording.
 */
export function RiskDisclosure({
  className = '',
  variant = 'page',
}: {
  className?: string;
  variant?: DisclosureVariant;
}) {
  const text = disclosureTextProps(variant);

  return (
    <section aria-label="גילוי נאות בדבר סיכון" className={`flex flex-col gap-3 ${className}`}>
      <p dir="rtl" {...text}>
        {RISK_DISCLOSURE_HE}
      </p>

      <p dir="ltr" style={text.style} className={`${text.className} text-start`}>
        {RISK_DISCLOSURE_EN}
      </p>
    </section>
  );
}

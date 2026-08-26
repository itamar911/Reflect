import { RISK_DISCLOSURE_EN, RISK_DISCLOSURE_HE } from './disclosureText';

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
 * Sized at body copy in the primary text colour, never the muted token: the
 * guideline this satisfies specifically rules out small grey footer type.
 */
export function RiskDisclosure({
  className = '',
  /** Off on /risk-disclosure, where the page's own <h1> already says this. */
  showHeading = true,
}: {
  className?: string;
  showHeading?: boolean;
}) {
  return (
    <section
      aria-label="גילוי נאות בדבר סיכוני מסחר"
      className={`w-full rounded-2xl border px-5 py-5 md:px-7 md:py-6 flex flex-col gap-4 ${className}`}
      style={{
        borderColor: 'var(--color-tg-border)',
        background: 'rgba(255,255,255,0.03)',
      }}
    >
      {showHeading && (
        <h2 className="text-base md:text-lg font-bold" style={{ color: 'var(--color-tg-text-2)' }}>
          גילוי נאות בדבר סיכון
        </h2>
      )}

      <p
        dir="rtl"
        className="text-base leading-relaxed"
        style={{ color: 'var(--color-tg-text)' }}
      >
        {RISK_DISCLOSURE_HE}
      </p>

      <p
        dir="ltr"
        className="text-base leading-relaxed text-start"
        style={{ color: 'var(--color-tg-text)' }}
      >
        {RISK_DISCLOSURE_EN}
      </p>
    </section>
  );
}

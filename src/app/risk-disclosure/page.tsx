import type { Metadata } from 'next';
import Link from 'next/link';
import { MAIN_CONTENT_ID } from '@/components/accessibility/SkipLink';
import { RiskDisclosure } from '@/components/legal/RiskDisclosure';
import { NinjaTraderAttribution } from '@/components/legal/NinjaTraderAttribution';
import { IllustrativeBadge } from '@/components/legal/IllustrativeBadge';

/**
 * The stable public home of the risk disclosure.
 *
 * It exists so there is one canonical URL to put in the profile description of
 * every social account (Instagram, X, Facebook, LinkedIn, TikTok…), which the
 * NinjaTrader guidelines require. Linking a bio at a section anchor on the
 * marketing page would break the moment that page is restructured; this route
 * will not move.
 *
 * The slug is deliberately generic — no product or platform trademark may
 * appear in a URL, page slug, meta title or social handle.
 *
 * No footer here: this page *is* the disclosure, so SiteDisclosureFooter would
 * print the same two paragraphs twice.
 */
export const metadata: Metadata = {
  title: 'גילוי נאות בדבר סיכון — Reflect',
  description:
    'גילוי נאות בדבר הסיכון הכרוך במסחר בחוזים עתידיים ובמט"ח, ומידע על אופי הנתונים המוצגים באתר Reflect.',
  alternates: { canonical: '/risk-disclosure' },
};

export default function RiskDisclosurePage() {
  return (
    <main
      id={MAIN_CONTENT_ID}
      tabIndex={-1}
      dir="rtl"
      className="max-w-[820px] mx-auto px-4 md:px-6 py-20 md:py-24 flex flex-col gap-8"
    >
      <h1 className="text-3xl md:text-4xl font-extrabold" style={{ color: 'var(--color-tg-text-2)' }}>
        גילוי נאות בדבר סיכון
      </h1>

      <RiskDisclosure showHeading={false} />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold" style={{ color: 'var(--color-tg-text-2)' }}>
          מהו Reflect
        </h2>
        <p className="text-base leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
          Reflect הינו כלי לניהול משמעת ותיעוד מסחר בלבד. הוא אינו ברוקר, אינו מבצע פעולות בחשבון
          המסחר שלך, ואינו מהווה ייעוץ השקעות, שיווק השקעות או המלצה לביצוע עסקה מכל סוג שהוא.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold" style={{ color: 'var(--color-tg-text-2)' }}>
          הנתונים המוצגים באתר
        </h2>
        <p className="text-base leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
          כל המספרים, הגרפים והמסכים המופיעים בעמודי השיווק של האתר הם המחשה בלבד של ממשק המוצר,
          ואינם תוצאות מסחר אמיתיות של סוחר כלשהו. אין להסיק מהם ביצועים כלשהם, בעבר או בעתיד.
        </p>
        {/* The real badge rather than its text in quotes: it shows the reader
            exactly what to look for, and a quoted string containing a middot
            reorders badly inside an RTL paragraph. */}
        <p className="text-base leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
          כל תצוגה כזו מסומנת באתר בתווית:
        </p>
        <IllustrativeBadge className="self-start" />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold" style={{ color: 'var(--color-tg-text-2)' }}>
          Trademarks
        </h2>
        <NinjaTraderAttribution />
      </section>

      <div className="flex flex-wrap gap-x-6 gap-y-2 pt-2">
        <Link href="/" className="text-tg-primary font-semibold">
          חזרה לעמוד הבית
        </Link>
        <Link href="/terms" className="text-tg-muted hover:text-tg-primary transition-colors">
          תנאי שימוש
        </Link>
        <Link href="/privacy" className="text-tg-muted hover:text-tg-primary transition-colors">
          מדיניות פרטיות
        </Link>
      </div>
    </main>
  );
}

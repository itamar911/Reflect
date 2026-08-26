import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';
import { RiskDisclosure } from '@/components/legal/RiskDisclosure';

const FOOTER_LINKS = [
  { href: '/login', label: 'כניסה' },
  { href: '/signup', label: 'הרשמה' },
  { href: '#pricing', label: 'מחירים' },
  { href: '#faq', label: 'שאלות נפוצות' },
  { href: '#contact', label: 'צור קשר' },
];

export function LandingFooter() {
  return (
    <footer className="relative border-t border-tg-border py-14 px-4 md:px-8 lg:px-10">
      <div className="max-w-[1360px] mx-auto flex flex-col items-center gap-6 text-center">
        <Logo />

        <p className="text-base text-tg-muted max-w-md">
          השוק בוחן את האסטרטגיה שלך. Reflect בוחן אותך.
        </p>

        <nav className="flex flex-wrap justify-center gap-x-6 gap-y-2">
          {FOOTER_LINKS.map((link) => (
            <a key={link.label} href={link.href} className="inline-block py-2 -my-2 text-sm text-tg-muted hover:text-tg-primary transition-colors">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
          <Link href="/terms" className="inline-block py-2 -my-2 text-sm text-tg-muted hover:text-tg-primary transition-colors">
            תנאי שימוש
          </Link>
          <Link href="/privacy" className="inline-block py-2 -my-2 text-sm text-tg-muted hover:text-tg-primary transition-colors">
            מדיניות פרטיות
          </Link>
          <Link href="/risk-disclosure" className="inline-block py-2 -my-2 text-sm text-tg-muted hover:text-tg-primary transition-colors">
            גילוי נאות בדבר סיכון
          </Link>
        </div>

        {/* The product disclaimer stays — it says what Reflect is, which the
            prescribed risk wording below deliberately does not. It sits above
            the disclosure rather than below it so the mandated block is the
            last thing on the page, not a postscript to ours. */}
        <p className="text-sm text-tg-muted max-w-xl leading-relaxed">
          Reflect הינו כלי לניהול משמעת ותיעוד מסחר בלבד, ואינו מהווה ייעוץ השקעות מכל סוג שהוא.
        </p>

        {/* Body-size, primary-colour, full width — not a grey footnote. See the
            presentation note in disclosureText.ts. */}
        <RiskDisclosure className="mt-2 max-w-[900px] text-start" />
      </div>
    </footer>
  );
}

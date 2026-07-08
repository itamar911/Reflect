import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';

const FOOTER_LINKS = [
  { href: '/login', label: 'כניסה' },
  { href: '/signup', label: 'הרשמה' },
  { href: '#pricing', label: 'מחירים' },
  { href: '#faq', label: 'שאלות נפוצות' },
  { href: 'mailto:hello@reflect.app', label: 'צור קשר' },
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
            <a key={link.label} href={link.href} className="text-sm text-tg-muted hover:text-tg-primary transition-colors">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
          <Link href="/terms" className="text-sm text-tg-muted hover:text-tg-primary transition-colors">
            תנאי שימוש
          </Link>
          <Link href="/privacy" className="text-sm text-tg-muted hover:text-tg-primary transition-colors">
            מדיניות פרטיות
          </Link>
        </div>

        <p className="text-sm text-tg-muted max-w-xl leading-relaxed">
          מסחר בשוקי ההון והקריפטו כרוך בסיכון משמעותי ועלול להוביל לאובדן מלוא ההון המושקע.
          Reflect הינו כלי לניהול משמעת ותיעוד מסחר בלבד, ואינו מהווה ייעוץ השקעות מכל סוג שהוא.
        </p>
      </div>
    </footer>
  );
}

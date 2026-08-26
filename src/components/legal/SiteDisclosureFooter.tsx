import Link from 'next/link';
import { RiskDisclosure } from './RiskDisclosure';

/**
 * The risk disclosure as a page footer, for every route that is not the
 * landing page (which has its own richer footer and renders RiskDisclosure
 * inside it).
 *
 * The guideline is "every page", so this is mounted at the layout level of
 * each route group rather than per page — that way nested and dynamic routes
 * inherit it and no future route can be added without it:
 *
 *   src/app/(app)/…        → AppShell, inside the sidebar's content column
 *   src/app/(auth)/…       → AuthLayout, under the centred card
 *   src/app/(protected)/…  → ProtectedLayout
 *   src/app/page.tsx       → LandingFooter
 *   standalone legal pages → rendered directly
 */
export function SiteDisclosureFooter({ className = '' }: { className?: string }) {
  return (
    <footer
      dir="rtl"
      className={`border-t px-4 md:px-8 lg:px-10 py-10 ${className}`}
      style={{ borderColor: 'var(--color-tg-border)' }}
    >
      <div className="max-w-[900px] mx-auto flex flex-col gap-4">
        <RiskDisclosure />

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/risk-disclosure" className="text-sm text-tg-muted hover:text-tg-primary transition-colors">
            גילוי נאות בדבר סיכון
          </Link>
          <Link href="/terms" className="text-sm text-tg-muted hover:text-tg-primary transition-colors">
            תנאי שימוש
          </Link>
          <Link href="/privacy" className="text-sm text-tg-muted hover:text-tg-primary transition-colors">
            מדיניות פרטיות
          </Link>
        </div>
      </div>
    </footer>
  );
}

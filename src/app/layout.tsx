import type { Metadata, Viewport } from 'next';
import { Rubik } from 'next/font/google';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { AccessibilityProvider } from '@/components/accessibility/AccessibilityContext';
import { AccessibilityInitScript } from '@/components/accessibility/AccessibilityInitScript';
import { AccessibilityWidget } from '@/components/accessibility/AccessibilityWidget';
import { SkipLink } from '@/components/accessibility/SkipLink';
import { FloatingWhatsApp } from '@/components/landing/FloatingWhatsApp';
import './globals.css';
import '@/components/accessibility/accessibility.css';

// Variable font (no weight array) so every weight in use (400–800) ships real
// glyphs — and the hebrew subset is essential: the whole UI is Hebrew, and a
// latin-only font silently falls back to the OS system font for it.
const rubik = Rubik({ variable: '--font-rubik', subsets: ['hebrew', 'latin'], display: 'swap' });

export const metadata: Metadata = {
  title: 'Reflect — השוק בוחן את האסטרטגיה שלך',
  description: 'השוק בוחן את האסטרטגיה שלך. Reflect בוחן אותך. מערכת משמעת מסחר מבוססת AI.',
  icons: {
    icon: '/icon.svg',
  },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0f',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={`${rubik.variable} h-full`} suppressHydrationWarning>
      <body className="min-h-full antialiased">
        {/* First element in the body ⇒ first tab stop on every route */}
        <SkipLink />
        <AccessibilityInitScript />
        <ThemeProvider>
          <AccessibilityProvider>
            {children}
            {/* Sibling to {children}, never a filtered ancestor of it — see
                accessibility.css for why grayscale/inverted contrast are
                implemented as a backdrop-filter here instead of a filter
                wrapping the page. */}
            <div className="a11y-filter-overlay" aria-hidden="true" />
            <FloatingWhatsApp />
            <AccessibilityWidget />
          </AccessibilityProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

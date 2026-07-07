import type { Metadata, Viewport } from 'next';
import { Rubik } from 'next/font/google';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import './globals.css';

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
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

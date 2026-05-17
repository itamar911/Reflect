import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Reflect ג€” ׳׳¢׳¨׳›׳× ׳׳©׳׳¢׳× ׳׳¡׳—׳¨ ׳׳‘׳•׳¡׳¡׳× AI',
  description: '׳”׳©׳•׳§ ׳‘׳•׳—׳ ׳׳× ׳”׳׳¡׳˜׳¨׳˜׳’׳™׳” ׳©׳׳. Reflect ׳‘׳•׳—׳ ׳׳•׳×׳. ׳׳¢׳¨׳›׳× ׳׳©׳׳¢׳× ׳׳¡׳—׳¨ ׳׳‘׳•׳¡׳¡׳× AI.',
};

export const viewport: Viewport = {
  themeColor: '#0A0A0A',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';

const NAV_LINKS = [
  { href: '#features', label: "פיצ'רים" },
  { href: '#pricing', label: 'מחירים' },
  { href: '#faq', label: 'שאלות נפוצות' },
];

export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 8);
    }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className="fixed top-0 inset-x-0 z-50 transition-colors duration-300"
      style={{
        background: scrolled ? 'rgba(8,8,16,0.85)' : 'rgba(8,8,16,0.4)',
        borderBottom: scrolled ? '1px solid var(--color-tg-border)' : '1px solid transparent',
        backdropFilter: 'blur(12px)',
      }}
    >
      <nav className="max-w-[1100px] mx-auto px-4 md:px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <Logo />
        </Link>

        <div className="hidden md:flex items-center gap-8">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} className="text-sm font-medium text-tg-muted hover:text-white transition-colors">
              {link.label}
            </a>
          ))}
        </div>

        <div className="hidden md:flex items-center gap-3">
          <Link
            href="/login"
            className="px-4 py-2 rounded-xl text-sm font-semibold border border-tg-border text-tg-text-2 hover:border-tg-primary hover:text-tg-primary transition-colors"
          >
            כניסה
          </Link>
          <Link
            href="/signup"
            className="shimmer-btn px-4 py-2 rounded-xl text-sm font-semibold text-black transition-all duration-150 active:scale-95"
          >
            התחל ניסיון חינם
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="md:hidden p-2 text-tg-text-2"
          aria-label={open ? 'סגור תפריט' : 'פתח תפריט'}
        >
          {open ? <X size={24} /> : <Menu size={24} />}
        </button>
      </nav>

      {open && (
        <div
          className="md:hidden px-4 pb-6 pt-2 flex flex-col gap-4 border-b border-tg-border"
          style={{ background: 'rgba(8,8,16,0.97)' }}
        >
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="text-base font-medium text-tg-text-2"
            >
              {link.label}
            </a>
          ))}
          <div className="flex flex-col gap-3 mt-2">
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="px-4 py-2.5 rounded-xl text-sm font-semibold border border-tg-border text-tg-text-2 text-center"
            >
              כניסה
            </Link>
            <Link
              href="/signup"
              onClick={() => setOpen(false)}
              className="shimmer-btn px-4 py-2.5 rounded-xl text-sm font-semibold text-black text-center active:scale-95"
            >
              התחל ניסיון חינם
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

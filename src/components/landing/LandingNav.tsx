'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Menu, X, Sparkles } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';

const NAV_LINKS = [
  { href: '#features', label: "פיצ'רים" },
  { href: '#pricing', label: 'מחירים' },
  { href: '#faq', label: 'שאלות נפוצות' },
];

function NewBadge() {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold whitespace-nowrap"
      style={{
        color: '#00d2d2',
        background: 'rgba(0,210,210,0.1)',
        border: '1px solid rgba(0,210,210,0.35)',
        boxShadow: '0 0 14px rgba(0,210,210,0.12)',
      }}
    >
      <Sparkles size={13} aria-hidden />
      חדש: תחקירי AI
    </span>
  );
}

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
      className="fixed top-0 inset-x-0 z-50 transition-all duration-300"
      style={{
        background: scrolled ? 'rgba(10,13,20,0.85)' : 'rgba(10,13,20,0.45)',
        backdropFilter: 'blur(18px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.4)',
        boxShadow: scrolled ? '0 10px 34px rgba(0,0,0,0.4)' : 'none',
      }}
    >
      {/* Letterhead mark — pinned to the page's top-right (start edge in RTL),
          outside the nav flow; fixed light tone since the landing is always dark */}
      <span
        className="absolute top-1 right-2.5 text-[11px] font-medium pointer-events-none select-none"
        style={{ color: 'rgba(226, 236, 244, 0.5)' }}
      >
        בס״ד
      </span>

      <nav className="max-w-[1360px] mx-auto px-4 md:px-8 lg:px-10 h-[76px] flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          {/* Scale-up only from md — at ≤360 the enlarged mark visually
              overflows its box into the edge padding and clips */}
          <span className="inline-block md:scale-[1.08]">
            <Logo />
          </span>
        </Link>

        <div className="hidden md:flex items-center gap-8">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} className="nav-link py-2.5 text-base font-medium text-tg-text-2 hover:text-white transition-colors">
              {link.label}
            </a>
          ))}
          <span className="hidden lg:inline-flex">
            <NewBadge />
          </span>
        </div>

        <div className="hidden md:flex items-center gap-3">
          <Link
            href="/login"
            className="px-4 py-2.5 rounded-xl text-sm font-semibold border border-tg-border text-tg-text-2 hover:border-tg-primary hover:text-tg-primary transition-colors"
          >
            כניסה למערכת
          </Link>
          <Link
            href="/signup"
            className="landing-cta cta-shine px-5 py-2.5 rounded-xl text-[15px] font-bold text-black"
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
          {open ? <X size={26} /> : <Menu size={26} />}
        </button>
      </nav>

      {/* bottom hairline: turquoise gradient fading to transparent */}
      <div
        className="absolute bottom-0 inset-x-0 h-px pointer-events-none"
        style={{
          background: 'linear-gradient(90deg, transparent 0%, rgba(0,210,210,0.55) 50%, transparent 100%)',
          opacity: scrolled ? 1 : 0.6,
          transition: 'opacity 0.3s ease',
        }}
        aria-hidden
      />

      {open && (
        <div
          className="md:hidden px-5 pb-7 pt-3 flex flex-col gap-5"
          style={{
            background: 'rgba(10,13,20,0.97)',
            backdropFilter: 'blur(18px)',
            WebkitBackdropFilter: 'blur(18px)',
            borderBottom: '1px solid rgba(0,210,210,0.25)',
            boxShadow: '0 18px 40px rgba(0,0,0,0.45)',
          }}
        >
          <div className="pt-1">
            <NewBadge />
          </div>
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="py-2 -my-2 text-base font-medium text-tg-text-2"
            >
              {link.label}
            </a>
          ))}
          <div className="flex flex-col gap-3 mt-1">
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="px-4 py-3 rounded-xl text-sm font-semibold border border-tg-border text-tg-text-2 text-center"
            >
              כניסה למערכת
            </Link>
            <Link
              href="/signup"
              onClick={() => setOpen(false)}
              className="landing-cta cta-shine px-4 py-3 rounded-xl text-[15px] font-bold text-black text-center"
            >
              התחל ניסיון חינם
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Menu, X, Sparkles } from 'lucide-react';
import { Logo } from '@/components/ui/Logo';
import { useScrollY } from '@/lib/hooks';

const NAV_LINKS = [
  { href: '#features', label: "פיצ'רים" },
  { href: '#pricing', label: 'מחירים' },
  { href: '#faq', label: 'שאלות נפוצות' },
  { href: '#contact', label: 'צור קשר' },
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
  const scrollY = useScrollY();
  const scrolled = scrollY > 8;
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  // Publishes the <nav> row's real rendered height as a CSS variable so
  // anything anchored to "clear the navbar" (ContactSection's scroll-mt)
  // follows it instead of assuming a fixed 76px — the row can grow past
  // that at larger text scales even with the hamburger switch above, since
  // min-height (not height) is what's set on it now.
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      document.documentElement.style.setProperty('--landing-nav-h', `${entry.contentRect.height}px`);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <header className="fixed top-0 inset-x-0 z-50">
      {/* The scrolled-state chrome (solid tint + blur) lives on this row
          wrapper, not <header> itself. <header> also contains the open
          mobile panel as a normal-flow sibling below; when the background
          was on <header>, it painted behind the panel too and the panel's
          own glass composited on top of an already near-opaque backdrop
          instead of the real page — the panel looked solid the moment
          `scrolled` flipped its alpha up, even though the panel's own rule
          was correct the whole time. */}
      <div
        className="relative transition-all duration-300"
        style={{
          background: scrolled ? 'rgba(10,13,20,0.85)' : 'rgba(10,13,20,0.45)',
          backdropFilter: 'blur(18px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.4)',
          boxShadow: scrolled ? '0 10px 34px rgba(0,0,0,0.4)' : 'none',
        }}
      >
        {/* Letterhead mark — pinned to the page's top-right (start edge in RTL),
            outside the nav flow; fixed light tone since the landing is always dark.
            Sized in rem (0.6875rem = the 11px used before) so it follows the
            browser's font-size preference like the rest of the nav's text. */}
        <span
          className="absolute top-1 right-2.5 text-[0.6875rem] font-medium pointer-events-none select-none"
          style={{ color: 'rgba(226, 236, 244, 0.5)' }}
        >
          בס״ד
        </span>

        <nav
          ref={navRef}
          // gap-x-8 is a floor CSS respects even under justify-between: it's
          // the minimum space between logo/links/CTA, topped up with whatever
          // extra room justify-between finds — not a margin that flex is free
          // to squeeze toward zero as the row gets tighter.
          className="max-w-[1360px] mx-auto px-4 md:px-8 lg:px-10 min-h-[76px] flex items-center justify-between gap-x-8"
        >
          <Link href="/" className="flex items-center gap-2 shrink-0">
            {/* Scale-up only from md — at ≤360 the enlarged mark visually
                overflows its box into the edge padding and clips */}
            <span className="inline-block md:scale-[1.08]">
              <Logo />
            </span>
          </Link>

          <div className="lnav-desktop items-center gap-8">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} className="nav-link py-2.5 text-base font-medium text-tg-text-2 hover:text-white transition-colors">
                {link.label}
              </a>
            ))}
            <span className="hidden lg:inline-flex">
              <NewBadge />
            </span>
          </div>

          <div className="lnav-desktop items-center gap-3">
            <Link
              href="/login"
              className="link-button px-4 py-2.5 rounded-xl text-sm font-semibold border border-tg-border text-tg-text-2 hover:border-tg-primary hover:text-tg-primary transition-colors"
            >
              כניסה למערכת
            </Link>
            {/* 0.9375rem = the 15px used before. In rem the CTA label follows the
                browser font-size preference — which does widen the desktop row,
                since the nav's own width thresholds are measured against it. */}
            <Link
              href="/signup"
              className="link-button landing-cta cta-shine px-5 py-2.5 rounded-xl text-[0.9375rem] font-bold text-black"
            >
              התחל ניסיון חינם
            </Link>
          </div>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="lnav-mobile p-2 text-tg-text-2"
            aria-label={open ? 'סגור תפריט' : 'פתח תפריט'}
          >
            {open ? <X aria-hidden="true" size={26} /> : <Menu aria-hidden="true" size={26} />}
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
      </div>

      {open && (
        <div
          className="lnav-mobile lnav-mobile-panel px-5 pb-7 pt-3 flex-col gap-5"
          style={{ boxShadow: '0 18px 40px rgba(0,0,0,0.45)' }}
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
              className="link-button px-4 py-3 rounded-xl text-sm font-semibold border border-tg-border text-tg-text-2 text-center"
            >
              כניסה למערכת
            </Link>
            {/* 0.9375rem = the 15px used before — mirrors the desktop CTA above */}
            <Link
              href="/signup"
              onClick={() => setOpen(false)}
              className="link-button landing-cta cta-shine px-4 py-3 rounded-xl text-[0.9375rem] font-bold text-black text-center"
            >
              התחל ניסיון חינם
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

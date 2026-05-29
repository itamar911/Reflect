'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import TradePlanForm from '@/components/trade/TradePlanForm';
import { cn } from '@/lib/utils';

// ── Icons ────────────────────────────────────────────────────────────────────

const IconHome = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);

const IconJournal = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
  </svg>
);

const IconCoach = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4l3 3" />
  </svg>
);

const IconSettings = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
);

const IconPlus = ({ size = 20, strokeColor = 'currentColor' }: { size?: number; strokeColor?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={strokeColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

// ── Nav config ───────────────────────────────────────────────────────────────

const SIDEBAR_NAV = [
  { href: '/dashboard', label: 'דשבורד', icon: <IconHome /> },
  { href: '/journal',   label: 'יומן',    icon: <IconJournal /> },
  { href: '/coach',     label: 'Coach',   icon: <IconCoach /> },
  { href: '/settings',  label: 'הגדרות',  icon: <IconSettings /> },
];

const MOBILE_NAV_LEFT = [
  { href: '/dashboard', label: 'בית',    icon: <IconHome /> },
  { href: '/journal',   label: 'עסקאות', icon: <IconJournal /> },
];

const MOBILE_NAV_RIGHT = [
  { href: '/coach',    label: "קואץ'",  icon: <IconCoach /> },
  { href: '/settings', label: 'הגדרות', icon: <IconSettings /> },
];

const GOLD = 'var(--color-tg-primary)';

// ── Component ─────────────────────────────────────────────────────────────────

export default function AppShell({
  children,
  userId,
  displayName,
}: {
  children: React.ReactNode;
  userId: string;
  displayName: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    const handler = () => setFormOpen(true);
    window.addEventListener('open-trade-form', handler);
    return () => window.removeEventListener('open-trade-form', handler);
  }, []);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  }

  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="min-h-screen" style={{ background: 'transparent' }}>

      {/* ── Desktop sidebar ──────────────────────────────────────────────── */}
      <aside
        className="hidden md:flex flex-col fixed inset-y-0 left-0 z-40 w-[220px]"
        style={{
          background: 'rgba(10, 10, 15, 0.97)',
          borderRight: '1px solid rgba(245, 197, 24, 0.13)',
          boxShadow: '4px 0 32px rgba(0,0,0,0.5)',
        }}
      >
        {/* Logo */}
        <div
          className="flex items-center gap-2.5 px-5 h-16 shrink-0"
          style={{ borderBottom: '1px solid rgba(245, 197, 24, 0.1)' }}
        >
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 animate-gold-breathe"
            style={{
              background: 'linear-gradient(135deg, #F5C518 0%, #D4A017 100%)',
              boxShadow: '0 0 12px rgba(245,197,24,0.45), 0 0 24px rgba(245,197,24,0.15)',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
              <polyline points="16 7 22 7 22 13" />
            </svg>
          </div>
          <span className="font-bold text-base text-glow-gold" style={{ color: GOLD }}>Reflect</span>
        </div>

        {/* Nav links */}
        <nav className="flex-1 flex flex-col gap-0.5 px-3 py-5 overflow-y-auto">
          {SIDEBAR_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={true}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 text-sm font-medium',
                active(item.href) ? '' : 'text-tg-muted hover:text-tg-text-2 hover:bg-white/5',
              )}
              style={active(item.href) ? {
                color: GOLD,
                background: 'rgba(245, 197, 24, 0.1)',
                boxShadow: 'inset 0 0 0 1px rgba(245,197,24,0.15)',
              } : {}}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          ))}

          {/* New trade */}
          <button
            onClick={() => setFormOpen(true)}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 text-sm font-semibold w-full mt-3"
            style={{
              color: '#0a0a0f',
              background: 'linear-gradient(135deg, #F5C518 0%, #D4A017 100%)',
              boxShadow: '0 2px 14px rgba(245,197,24,0.4)',
            }}
          >
            <IconPlus size={18} strokeColor="black" />
            <span>עסקה חדשה</span>
          </button>
        </nav>

        {/* User info */}
        <div
          className="px-3 pb-4 pt-3 shrink-0"
          style={{ borderTop: '1px solid rgba(245, 197, 24, 0.1)' }}
        >
          <div className="flex items-center gap-3 px-2 py-1.5 rounded-lg">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
              style={{ background: 'rgba(245,197,24,0.15)', color: GOLD }}
            >
              {(displayName || '?').charAt(0).toUpperCase()}
            </div>
            <p className="flex-1 text-xs font-medium text-tg-text truncate min-w-0">{displayName}</p>
            <button
              onClick={handleSignOut}
              className="text-xs text-tg-muted hover:text-tg-danger transition-colors shrink-0"
            >
              יציאה
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main content column ──────────────────────────────────────────── */}
      <div className="flex flex-col min-h-screen md:ml-[220px]">

        {/* Mobile-only top bar */}
        <header
          className="glass-dark sticky top-0 z-30 flex items-center justify-between px-4 h-14 border-b md:hidden"
          style={{
            background: 'rgba(10, 10, 15, 0.88)',
            borderColor: 'rgba(245, 197, 24, 0.13)',
            boxShadow: '0 1px 0 rgba(245,197,24,0.06), 0 4px 32px rgba(0,0,0,0.5)',
          }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center animate-gold-breathe"
              style={{
                background: 'linear-gradient(135deg, #F5C518 0%, #D4A017 100%)',
                boxShadow: '0 0 12px rgba(245,197,24,0.45), 0 0 24px rgba(245,197,24,0.15)',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                <polyline points="16 7 22 7 22 13" />
              </svg>
            </div>
            <span className="font-bold text-sm text-glow-gold" style={{ color: GOLD }}>Reflect</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-tg-muted hidden sm:block">{displayName}</span>
            <button onClick={handleSignOut} className="text-xs text-tg-muted hover:text-tg-danger transition-colors">
              יציאה
            </button>
          </div>
        </header>

        {/* Page content — no bottom padding on desktop since there's no bottom nav */}
        <main className="flex-1 overflow-auto pb-24 md:pb-0">{children}</main>

        {/* Mobile-only bottom navigation */}
        <nav
          className="glass-dark fixed bottom-0 left-0 right-0 z-30 flex items-center h-16 border-t md:hidden"
          style={{
            background: 'rgba(10, 10, 15, 0.92)',
            borderColor: 'rgba(245, 197, 24, 0.1)',
            boxShadow: '0 -1px 0 rgba(245,197,24,0.05), 0 -4px 32px rgba(0,0,0,0.6)',
            overflow: 'visible',
          }}
        >
          {MOBILE_NAV_LEFT.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={true}
              className={cn(
                'flex flex-col items-center gap-0.5 flex-1 py-2 transition-all duration-200',
                active(item.href) ? '' : 'text-tg-muted hover:text-tg-text-2',
              )}
              style={active(item.href) ? { color: GOLD, filter: 'drop-shadow(0 0 6px rgba(245,197,24,0.6))' } : {}}
            >
              {item.icon}
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          ))}

          {/* Centre raised add button */}
          <div className="flex-1 flex flex-col items-center justify-center -translate-y-3">
            <button
              onClick={() => setFormOpen(true)}
              aria-label="הוסף עסקה"
              className="w-14 h-14 rounded-full flex items-center justify-center transition-transform active:scale-95"
              style={{
                background: 'linear-gradient(135deg, #F5C518 0%, #D4A017 100%)',
                boxShadow: '0 4px 20px rgba(245,197,24,0.65), 0 0 48px rgba(245,197,24,0.25), inset 0 1px 0 rgba(255,255,255,0.25)',
              }}
            >
              <IconPlus size={24} strokeColor="black" />
            </button>
            <span className="text-[10px] font-semibold mt-1" style={{ color: GOLD }}>הוסף עסקה</span>
          </div>

          {MOBILE_NAV_RIGHT.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={true}
              className={cn(
                'flex flex-col items-center gap-0.5 flex-1 py-2 transition-all duration-200',
                active(item.href) ? '' : 'text-tg-muted hover:text-tg-text-2',
              )}
              style={active(item.href) ? { color: GOLD, filter: 'drop-shadow(0 0 6px rgba(245,197,24,0.6))' } : {}}
            >
              {item.icon}
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          ))}
        </nav>

      </div>

      <TradePlanForm
        userId={userId}
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={() => router.refresh()}
      />
    </div>
  );
}

'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import TradePlanForm from '@/components/trade/TradePlanForm';
import RuleBlockedModal from '@/components/rules/RuleBlockedModal';
import { fetchActiveRuleViolation, type RuleViolationResult } from '@/lib/rules/fetchActiveRuleViolation';
import { logRuleViolations } from '@/lib/rules/logRuleViolation';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { Logo } from '@/components/ui/Logo';
import { PageTransition } from '@/components/layout/PageTransition';
import { getPlanLimits, type PlanTier } from '@/lib/plans/config';

// ── Design tokens ─────────────────────────────────────────────────────────────
const ACCENT = '#00d2d2';
const NAV_BG = 'var(--shell-nav-bg)';
const SEP    = 'var(--shell-border)';
const W_OPEN = 240;
const W_SHUT = 64;

// ── Icon helper ───────────────────────────────────────────────────────────────
function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const IconDashboard  = () => <Svg><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></Svg>;
const IconCalendar   = () => <Svg><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></Svg>;
const IconList       = () => <Svg><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.2" fill="currentColor" stroke="none"/></Svg>;
const IconStats      = () => <Svg><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></Svg>;
const IconTag        = () => <Svg><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></Svg>;
const IconNotebook   = () => <Svg><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/></Svg>;
const IconAI         = () => <Svg><path d="M12 2l2.4 5.2 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8L12 2z"/></Svg>;
const IconShield     = () => <Svg><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></Svg>;
const IconStrategy   = () => <Svg><path d="M21 3H3v7h18V3z"/><path d="M21 14H3v7h18v-7z"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="10" x2="16" y2="14"/></Svg>;
const IconSettings   = () => <Svg><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></Svg>;
const IconFeedback   = () => <Svg><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="15" x2="12.01" y2="15"/></Svg>;
const IconLogout     = () => <Svg><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></Svg>;
const IconPlus       = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;

// ── Nav config ────────────────────────────────────────────────────────────────
interface NavItem { href: string; label: string; icon: React.ReactNode }

const PRIMARY_NAV: NavItem[] = [
  { href: '/dashboard',  label: 'דשבורד',            icon: <IconDashboard /> },
  { href: '/journal',    label: 'יומן חודשי',         icon: <IconCalendar /> },
  { href: '/trades',     label: 'כל העסקאות',         icon: <IconList /> },
  { href: '/stats',      label: 'סטטיסטיקה',          icon: <IconStats /> },
  { href: '/setups',     label: 'סטאפים ותגיות',      icon: <IconTag /> },
  { href: '/notebook',   label: 'מחברת',              icon: <IconNotebook /> },
  { href: '/coach',      label: 'מאמן AI',             icon: <IconAI /> },
  { href: '/rules',      label: 'חוקי מסחר',          icon: <IconShield /> },
  { href: '/strategies', label: 'אסטרטגיות',          icon: <IconStrategy /> },
];

const SECONDARY_NAV: NavItem[] = [
  { href: '/settings', label: 'הגדרות',            icon: <IconSettings /> },
  { href: '/feedback', label: 'באג / הצעה לשיפור', icon: <IconFeedback /> },
];

// ── NavLink ───────────────────────────────────────────────────────────────────
function NavLink({ item, expanded, active }: { item: NavItem; expanded: boolean; active: boolean }) {
  return (
    <Link
      href={item.href}
      prefetch={true}
      title={!expanded ? item.label : undefined}
      className={cn(
        'flex items-center rounded-xl transition-all duration-150 select-none',
        expanded ? 'gap-3 px-3 py-2.5' : 'justify-center py-3',
      )}
      style={{
        color:      active ? ACCENT : 'var(--text-primary)',
        background: active ? 'rgba(0,210,210,0.12)' : 'transparent',
        boxShadow:  active ? `inset 0 0 0 1px rgba(0,210,210,0.22)` : undefined,
      }}
    >
      {item.icon}
      {expanded && <span className="font-semibold truncate" style={{ fontSize: 16 }}>{item.label}</span>}
    </Link>
  );
}

// ── AppShell ──────────────────────────────────────────────────────────────────
export default function AppShell({
  children,
  userId,
  displayName,
  plan,
}: {
  children: React.ReactNode;
  userId: string;
  displayName: string;
  plan: PlanTier;
}) {
  const pathname = usePathname();
  const router   = useRouter();
  const limits   = getPlanLimits(plan);

  const [formOpen,  setFormOpen]  = useState(false);
  const [expanded,  setExpanded]  = useState(false);
  const [isMobile,  setIsMobile]  = useState(false);
  const [ruleBlock,   setRuleBlock]   = useState<RuleViolationResult | null>(null);
  const [ruleWarning, setRuleWarning] = useState<string | null>(null);

  async function tryOpenTradeForm() {
    const violation = await fetchActiveRuleViolation(userId, limits.realTimeBlocking);
    if (violation && (violation.actionType === 'block_day' || violation.actionType === 'block_timer')) {
      setRuleBlock(violation);
      // Only custom rules (structured, with an id/condition_type) are logged here —
      // the generic preset pre-check has no structured identity to attach a row to.
      if (violation.customRule) {
        logRuleViolations([{
          userId,
          ruleSource: 'custom',
          customRuleId: violation.customRule.id,
          ruleKey: violation.customRule.condition_type,
          ruleName: violation.customRule.name,
          outcome: 'blocked',
          tradePlanId: null,
        }]);
      }
    } else {
      setRuleWarning(violation?.actionType === 'warn' ? violation.description : null);
      setFormOpen(true);
    }
  }

  // Detect mobile viewport
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Restore desktop saved state
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('sidebar-expanded');
      if (saved === 'true') setExpanded(true);
    }
  }, []);

  // External trigger (other components can dispatch 'open-trade-form')
  useEffect(() => {
    const handler = () => { tryOpenTradeForm(); };
    window.addEventListener('open-trade-form', handler);
    return () => window.removeEventListener('open-trade-form', handler);
  }, [userId]);

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (!isMobile) localStorage.setItem('sidebar-expanded', String(next));
  }

  async function handleSignOut() {
    await createClient().auth.signOut();
    router.push('/login');
  }

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/');
  }

  const sidebarW  = expanded ? W_OPEN : W_SHUT;
  // On mobile, expanded sidebar overlays content (no push); collapsed always pushes W_SHUT
  const contentMr = isMobile ? W_SHUT : sidebarW;

  const easing = 'cubic-bezier(0.4,0,0.2,1)';

  return (
    <div dir="rtl" className="min-h-screen">

      {/* Mobile overlay when expanded */}
      {expanded && isMobile && (
        <div
          className="fixed inset-0 z-30"
          style={{ background: 'rgba(0,0,0,0.55)' }}
          onClick={() => setExpanded(false)}
        />
      )}

      {/* ── Toggle tab (fixed, left edge of sidebar) ───────────────── */}
      <button
        onClick={toggle}
        aria-label={expanded ? 'כווץ סרגל' : 'הרחב סרגל'}
        className="fixed z-50 flex items-center justify-center w-5 h-9 transition-[right]"
        style={{
          right:        sidebarW,
          top:          '50%',
          transform:    'translateY(-50%)',
          transition:   `right 250ms ${easing}`,
          background:   NAV_BG,
          border:       `1px solid ${SEP}`,
          borderRight:  'none',
          borderRadius: '6px 0 0 6px',
          color:        'rgba(0,210,210,0.55)',
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(180deg)', transition: `transform 250ms ${easing}` }}>
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>

      {/* ── Right sidebar ─────────────────────────────────────────── */}
      <aside
        dir="rtl"
        className="fixed inset-y-0 right-0 z-40 flex flex-col"
        style={{
          width:        sidebarW,
          background:   NAV_BG,
          borderLeft:   `1px solid ${SEP}`,
          transition:   `width 250ms ${easing}`,
          overflowX:    'hidden',
          overflowY:    'hidden',
        }}
      >

        {/* Logo */}
        <div
          className="flex items-center h-16 shrink-0 overflow-hidden"
          style={{
            borderBottom: `1px solid ${SEP}`,
            padding:       expanded ? '0 14px' : '0',
            justifyContent: expanded ? 'flex-start' : 'center',
          }}
        >
          <Logo showWordmark={expanded} />
        </div>

        {/* Primary nav */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 flex flex-col gap-0.5 px-2">
          {PRIMARY_NAV.map(item => (
            <NavLink key={item.href} item={item} expanded={expanded} active={isActive(item.href)} />
          ))}

          {/* Separator */}
          <div className="my-2 mx-1" style={{ height: 1, background: SEP }} />

          {SECONDARY_NAV.map(item => (
            <NavLink key={item.href} item={item} expanded={expanded} active={isActive(item.href)} />
          ))}

          {/* Sign out */}
          <button
            onClick={handleSignOut}
            title={!expanded ? 'התנתק' : undefined}
            className={cn(
              'flex items-center rounded-xl transition-colors hover:bg-white/5 cursor-pointer',
              expanded ? 'gap-3 px-3 py-2.5' : 'justify-center py-3',
            )}
            style={{ color: 'var(--text-primary)' }}
          >
            <IconLogout />
            {expanded && <span className="text-sm font-semibold">התנתק</span>}
          </button>
        </nav>

        {/* User area + CTA */}
        <div className="shrink-0 px-2 pb-3 pt-2 flex flex-col gap-2" style={{ borderTop: `1px solid ${SEP}` }}>

          {/* Avatar / user info */}
          {expanded ? (
            <div className="flex items-center gap-2 px-1 py-1">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                style={{ background: 'rgba(0,210,210,0.12)', color: ACCENT }}
              >
                {(displayName || '?').charAt(0).toUpperCase()}
              </div>
              <p className="flex-1 text-xs font-semibold truncate min-w-0" style={{ color: 'var(--text-primary)' }}>
                {displayName}
              </p>
              <ThemeToggle className="p-1 rounded-md transition-opacity hover:opacity-70 shrink-0" />
            </div>
          ) : (
            <div className="flex justify-center py-1">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                style={{ background: 'rgba(0,210,210,0.12)', color: ACCENT }}
                title={displayName}
              >
                {(displayName || '?').charAt(0).toUpperCase()}
              </div>
            </div>
          )}

          {/* New trade */}
          <button
            onClick={() => tryOpenTradeForm()}
            title={!expanded ? 'עסקה חדשה' : undefined}
            className={cn(
              'flex items-center justify-center rounded-xl py-2.5 font-semibold text-sm',
              'transition-opacity hover:opacity-85 active:scale-95',
              expanded ? 'gap-2 px-3' : '',
            )}
            style={{ background: ACCENT, color: '#000' }}
          >
            <IconPlus />
            {expanded && <span>עסקה חדשה</span>}
          </button>

        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────────────── */}
      <div
        className="min-h-screen"
        style={{
          marginRight: contentMr,
          transition:  `margin-right 250ms ${easing}`,
        }}
      >
        <PageTransition>
          {children}
        </PageTransition>
      </div>

      <TradePlanForm
        userId={userId}
        plan={plan}
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={() => router.refresh()}
        initialWarning={ruleWarning}
      />

      {ruleBlock && (
        <RuleBlockedModal
          ruleName={ruleBlock.ruleName}
          cooldownMinutes={ruleBlock.actionType === 'block_timer' ? ruleBlock.cooldownMinutes : null}
          onClose={() => setRuleBlock(null)}
        />
      )}
    </div>
  );
}

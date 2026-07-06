'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import TradePlanForm from '@/components/trade/TradePlanForm';
import RuleBlockedModal from '@/components/rules/RuleBlockedModal';
import { fetchActiveRuleViolation, type RuleViolationResult } from '@/lib/rules/fetchActiveRuleViolation';
import { logRuleViolations } from '@/lib/rules/logRuleViolation';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { Logo } from '@/components/ui/Logo';
import { PageTransition } from '@/components/layout/PageTransition';
import { getPlanLimits, type PlanTier } from '@/lib/plans/config';
import { SIDEBAR_DURATION, SIDEBAR_EASING, SIDEBAR_TRANSITION } from '@/lib/motion';

// ── Design tokens ─────────────────────────────────────────────────────────────
const ACCENT = '#00d2d2';
const NAV_BG = 'var(--shell-nav-bg)';
const SEP    = 'var(--shell-border)';
const W_OPEN = 240;
const W_SHUT = 64;
const RAIL_INSET = W_OPEN - W_SHUT; // px of the panel clipped away / handle offset when collapsed

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
// Layout never changes shape between expanded/collapsed — the icon always sits
// in the first ~64px (right edge, RTL) so the sidebar's clip-path can reveal
// just that strip when collapsed without reflowing this row's internals.
function NavLink({ item, expanded, active }: { item: NavItem; expanded: boolean; active: boolean }) {
  return (
    <Link
      href={item.href}
      prefetch={true}
      title={!expanded ? item.label : undefined}
      className="flex items-center gap-3 px-3 py-2.5 rounded-xl select-none transition-colors"
      style={{
        color:      active ? ACCENT : 'var(--text-primary)',
        background: active ? 'rgba(0,210,210,0.12)' : 'transparent',
        boxShadow:  active ? `inset 0 0 0 1px rgba(0,210,210,0.22)` : undefined,
        transitionDuration: `${SIDEBAR_DURATION}ms`,
        transitionTimingFunction: SIDEBAR_EASING,
      }}
    >
      <span className="shrink-0">{item.icon}</span>
      <span
        aria-hidden={!expanded}
        className="font-semibold truncate"
        style={{
          fontSize: 16,
          opacity: expanded ? 1 : 0,
          transform: expanded ? 'translateX(0)' : 'translateX(6px)',
          transition: `opacity ${SIDEBAR_TRANSITION}, transform ${SIDEBAR_TRANSITION}`,
          pointerEvents: expanded ? 'auto' : 'none',
        }}
      >
        {item.label}
      </span>
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
      } else if (violation.presetRuleKey) {
        logRuleViolations([{
          userId,
          ruleSource: 'preset',
          customRuleId: null,
          ruleKey: violation.presetRuleKey,
          ruleName: violation.ruleName,
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

  // Desktop: a fixed-width (240px) panel is always mounted; collapse/expand is
  // purely a clip-path reveal (paint-only, never triggers layout/reflow) of the
  // left 176px, leaving the rightmost 64px (where icons sit, RTL) always visible.
  // Mobile: a true off-canvas drawer — the whole panel translates fully out of
  // view when closed, so there's no persistent rail to reflow around.
  const railInset = isMobile ? 0 : (expanded ? 0 : RAIL_INSET);
  // Main content's gutter animates on the same curve/duration as the sidebar's
  // clip-path/transform, so the visible edge and the reclaimed space move as a
  // single motion instead of the sidebar finishing first and content snapping
  // afterward. It's a real reflow-driving property (margin-right), but it's a
  // single cheap container, not the original width/margin/right-on-three-elements
  // bug — and ResponsiveContainer's debounce (below) coalesces the resulting
  // per-frame ResizeObserver churn into one repaint near the end of the motion.
  const contentMr = isMobile ? 0 : (expanded ? W_OPEN : W_SHUT);

  return (
    <div dir="rtl" className="min-h-screen sidebar-motion">

      {/* Mobile backdrop — always mounted, fades so it never pops in/out */}
      <div
        className="fixed inset-0 z-30"
        style={{
          background:    'rgba(0,0,0,0.55)',
          opacity:       isMobile && expanded ? 1 : 0,
          pointerEvents: isMobile && expanded ? 'auto' : 'none',
          transition:    `opacity ${SIDEBAR_TRANSITION}`,
        }}
        onClick={() => setExpanded(false)}
      />

      {/* ── Toggle handle ────────────────────────────────────────── */}
      <button
        onClick={toggle}
        aria-label={expanded ? 'כווץ סרגל' : 'הרחב סרגל'}
        className="fixed z-50 flex items-center justify-center w-5 h-9"
        style={
          isMobile
            ? {
                // Fixed corner affordance — there's no persistent rail edge to attach to.
                right:        16,
                top:          16,
                background:   NAV_BG,
                border:       `1px solid ${SEP}`,
                borderRadius: 8,
                color:        'rgba(0,210,210,0.55)',
              }
            : {
                // Tracks the sidebar's visible edge via transform only (isolated
                // fixed element — moving it doesn't reflow any sibling).
                right:        W_SHUT,
                top:          '50%',
                transform:    `translate(${expanded ? -RAIL_INSET : 0}px, -50%)`,
                transition:   `transform ${SIDEBAR_TRANSITION}`,
                background:   NAV_BG,
                border:       `1px solid ${SEP}`,
                borderRight:  'none',
                borderRadius: '6px 0 0 6px',
                color:        'rgba(0,210,210,0.55)',
              }
        }
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(180deg)', transition: `transform ${SIDEBAR_TRANSITION}` }}>
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>

      {/* ── Right sidebar ─────────────────────────────────────────── */}
      <aside
        dir="rtl"
        className="fixed inset-y-0 right-0 z-40 flex flex-col"
        style={{
          width:        W_OPEN,
          background:   NAV_BG,
          borderLeft:   `1px solid ${SEP}`,
          overflowY:    'hidden',
          ...(isMobile
            ? {
                transform:  `translateX(${expanded ? 0 : W_OPEN}px)`,
                transition: `transform ${SIDEBAR_TRANSITION}`,
              }
            : {
                clipPath:   `inset(0 0 0 ${railInset}px)`,
                transition: `clip-path ${SIDEBAR_TRANSITION}`,
              }),
        }}
      >

        {/* Logo — right-side inset stays small & constant so the mark itself
            (no wordmark) sits fully inside the 64px rail that's always visible */}
        <div
          className="flex items-center h-16 shrink-0 pr-2 pl-3.5"
          style={{ borderBottom: `1px solid ${SEP}` }}
        >
          <Logo showWordmark={expanded} />
        </div>

        {/* Primary nav */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 flex flex-col gap-0.5 px-2 [scrollbar-gutter:stable]">
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
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors hover:bg-white/5 cursor-pointer"
            style={{ color: 'var(--text-primary)' }}
          >
            <span className="shrink-0"><IconLogout /></span>
            <span
              aria-hidden={!expanded}
              className="text-sm font-semibold"
              style={{
                opacity: expanded ? 1 : 0,
                transform: expanded ? 'translateX(0)' : 'translateX(6px)',
                transition: `opacity ${SIDEBAR_TRANSITION}, transform ${SIDEBAR_TRANSITION}`,
                pointerEvents: expanded ? 'auto' : 'none',
              }}
            >
              התנתק
            </span>
          </button>
        </nav>

        {/* User area + CTA */}
        <div className="shrink-0 px-2 pb-3 pt-2 flex flex-col gap-2" style={{ borderTop: `1px solid ${SEP}` }}>

          {/* Avatar / user info — avatar stays put (rail), name + theme toggle fade */}
          <div className="flex items-center gap-2 px-1 py-1">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
              style={{ background: 'rgba(0,210,210,0.12)', color: ACCENT }}
              title={!expanded ? displayName : undefined}
            >
              {(displayName || '?').charAt(0).toUpperCase()}
            </div>
            <div
              className="flex-1 flex items-center gap-2 min-w-0"
              aria-hidden={!expanded}
              style={{
                opacity: expanded ? 1 : 0,
                transform: expanded ? 'translateX(0)' : 'translateX(6px)',
                transition: `opacity ${SIDEBAR_TRANSITION}, transform ${SIDEBAR_TRANSITION}`,
                pointerEvents: expanded ? 'auto' : 'none',
              }}
            >
              <p className="flex-1 text-xs font-semibold truncate min-w-0" style={{ color: 'var(--text-primary)' }}>
                {displayName}
              </p>
              <ThemeToggle className="p-1 rounded-md transition-opacity hover:opacity-70 shrink-0" />
            </div>
          </div>

          {/* New trade */}
          <button
            onClick={() => tryOpenTradeForm()}
            title={!expanded ? 'עסקה חדשה' : undefined}
            className="flex items-center justify-center gap-2 px-3 rounded-xl py-2.5 font-semibold text-sm transition-opacity hover:opacity-85 active:scale-95"
            style={{ background: ACCENT, color: '#000' }}
          >
            <span className="shrink-0"><IconPlus /></span>
            <span
              aria-hidden={!expanded}
              style={{
                opacity: expanded ? 1 : 0,
                transform: expanded ? 'translateX(0)' : 'translateX(6px)',
                transition: `opacity ${SIDEBAR_TRANSITION}, transform ${SIDEBAR_TRANSITION}`,
                pointerEvents: expanded ? 'auto' : 'none',
              }}
            >
              עסקה חדשה
            </span>
          </button>

        </div>
      </aside>

      {/* ── Main content ───────────────────────────────────────────
          margin-right animates on the exact same spec as the sidebar so the
          two move together as one motion instead of content snapping into
          place after the sidebar has already finished. */}
      <div
        className="min-h-screen"
        style={{
          marginRight: contentMr,
          transition: `margin-right ${SIDEBAR_TRANSITION}`,
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
          description={ruleBlock.description}
          cooldownMinutes={ruleBlock.actionType === 'block_timer' ? ruleBlock.cooldownMinutes : null}
          onClose={() => setRuleBlock(null)}
        />
      )}
    </div>
  );
}

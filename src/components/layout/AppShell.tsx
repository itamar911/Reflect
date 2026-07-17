'use client';

import { useState, useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { triggerDemoUpsell } from '@/lib/demo/demoDb';
import '@/lib/demo/fetchGuard';
import TradePlanForm from '@/components/trade/TradePlanForm';
import RuleBlockedModal from '@/components/rules/RuleBlockedModal';
import { fetchActiveRuleViolation, type RuleViolationResult } from '@/lib/rules/fetchActiveRuleViolation';
import { logRuleViolations } from '@/lib/rules/logRuleViolation';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { Logo } from '@/components/ui/Logo';
import { PageTransition } from '@/components/layout/PageTransition';
import { getPlanLimits, type PlanTier } from '@/lib/plans/config';
import { SIDEBAR_TRANSITION } from '@/lib/motion';

// Demo-only chrome (fetch interception + upsell modal) — loaded only on /demo
// so the fixtures never enter the regular app bundle.
const DemoGuard = dynamic(() => import('@/components/demo/DemoGuard'), { ssr: false });

// ── Browser-state stores ──────────────────────────────────────────────────────
// Client-only facts read during render via useSyncExternalStore (false on the
// server / during hydration). getSnapshot re-runs on every render, so values
// that follow the URL stay fresh across soft navigations, which re-render via
// usePathname.
const emptySubscribe = () => () => {};
const getServerFalse = () => false;
const getBrowserDemo = () => window.location.pathname.startsWith('/demo');
const getEmbedded = () =>
  new URLSearchParams(window.location.search).get('embed') === '1' ||
  window.self !== window.top;
const getSavedExpanded = () => localStorage.getItem('sidebar-expanded') === 'true';
const getHandleUsed = () => localStorage.getItem('sidebar-handle-used') === 'true';
const subscribeWindowResize = (onChange: () => void) => {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
};
const getIsMobile = () => window.innerWidth < 768;

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
// The icon sits in a fixed, absolutely-positioned slot flush with the row's
// right edge, sized to exactly match the sidebar's revealed rail (W_SHUT wide)
// — so its position is identical in both states and never depends on the
// label's width. The active-state highlight is two separate pills (full-row
// vs rail-only) that cross-fade via opacity instead of one pill trying to be
// both sizes, so nothing needs to resize/reflow during the collapse motion.
function NavLink({ item, expanded, active, hardNav }: {
  item: NavItem;
  expanded: boolean;
  active: boolean;
  /** Demo mode: full-page <a> navigation. Soft (client-router) navigations
      through the /demo middleware rewrite can desync the router's pathname
      from the browser URL, which strips the /demo prefix off subsequent nav
      and silently drops the visitor into the real app. A hard load always
      goes through the middleware and always stays inside /demo. */
  hardNav?: boolean;
}) {
  const LinkOrAnchor = hardNav ? 'a' : Link;
  return (
    <LinkOrAnchor
      href={item.href}
      {...(hardNav ? {} : { prefetch: true })}
      title={!expanded ? item.label : undefined}
      className="relative flex items-center rounded-xl select-none"
      style={{
        height:       44,
        paddingRight: W_SHUT,
        paddingLeft:  12,
        color:        active ? ACCENT : 'var(--text-primary)',
      }}
    >
      {/* Expanded: full-row highlight */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-xl pointer-events-none"
        style={{
          background: active ? 'rgba(0,210,210,0.12)' : 'transparent',
          boxShadow:  active ? `inset 0 0 0 1px rgba(0,210,210,0.22)` : undefined,
          opacity:    expanded ? 1 : 0,
          transition: `opacity ${SIDEBAR_TRANSITION}`,
        }}
      />
      {/* Collapsed: compact pill confined to the rail */}
      <span
        aria-hidden
        className="absolute rounded-xl pointer-events-none"
        style={{
          top: 4, bottom: 4, right: 12, width: 40,
          background: active ? 'rgba(0,210,210,0.12)' : 'transparent',
          boxShadow:  active ? `inset 0 0 0 1px rgba(0,210,210,0.22)` : undefined,
          opacity:    expanded ? 0 : 1,
          transition: `opacity ${SIDEBAR_TRANSITION}`,
        }}
      />
      {/* Icon — fixed rail slot, position never changes between states */}
      <span
        className="absolute flex items-center justify-center"
        style={{ top: 0, bottom: 0, right: 0, width: W_SHUT }}
      >
        {item.icon}
      </span>
      {/* Label — normal flow, fades/slides in as the sidebar expands */}
      <span
        aria-hidden={!expanded}
        className="relative font-semibold truncate"
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
    </LinkOrAnchor>
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

  // Demo mode — same shell, but nav stays under /demo, account actions are
  // hidden, and anything mutating raises the signup upsell instead.
  // window.location is the fallback source of truth: after a soft navigation
  // through the /demo rewrite the router's pathname can report the rewritten
  // internal route (no /demo prefix) while the browser URL is still /demo/*.
  const browserDemo = useSyncExternalStore(emptySubscribe, getBrowserDemo, getServerFalse);
  const isDemo    = pathname.startsWith('/demo') || browserDemo;
  const navPrefix = isDemo ? '/demo' : '';

  // Embedded demo (landing iframe loads /demo/dashboard?embed=1) hides the
  // demo banner — the surrounding frame provides its own chrome. Demo nav is
  // hardNav and drops the query param, so also treat being inside an iframe
  // as embedded; standalone tabs (מסך מלא, direct links) keep the banner.
  const embedded = useSyncExternalStore(emptySubscribe, getEmbedded, getServerFalse);

  const [formOpen,  setFormOpen]  = useState(false);
  // Saved desktop preference applies until the user toggles in this session
  const savedExpanded = useSyncExternalStore(emptySubscribe, getSavedExpanded, getServerFalse);
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const expanded = expandedOverride ?? savedExpanded;
  const isMobile = useSyncExternalStore(subscribeWindowResize, getIsMobile, getServerFalse);
  // First-use attention pulse on the toggle handle — stops (forever) once the
  // user has toggled the sidebar once.
  const savedHandleUsed = useSyncExternalStore(emptySubscribe, getHandleUsed, getServerFalse);
  const [handleUsedNow, setHandleUsedNow] = useState(false);
  const handleUsed = savedHandleUsed || handleUsedNow;

  // Hold all sidebar transitions until the rendered state matches the saved
  // preference. The server always renders the sidebar collapsed (localStorage
  // is client-only), so a saved-open sidebar corrects itself shortly after
  // hydration — without this hold that correction plays as a 300ms slide of
  // the whole content area on every hard load ("the page jumps on its own").
  // The equality guard (not frame timing) decides the release: the correction
  // render can land several frames after hydration.
  const [motionReady, setMotionReady] = useState(false);
  useEffect(() => {
    if (motionReady || expanded !== getSavedExpanded()) return;
    let raf2: number | null = null;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setMotionReady(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
    };
  }, [motionReady, expanded]);
  const [ruleBlock,   setRuleBlock]   = useState<RuleViolationResult | null>(null);
  const [ruleWarning, setRuleWarning] = useState<string | null>(null);

  async function tryOpenTradeForm() {
    // read the path live — this also runs from the window event handler below,
    // whose closure may predate the current route
    if (window.location.pathname.startsWith('/demo')) {
      triggerDemoUpsell();
      return;
    }
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
  // External trigger (other components can dispatch 'open-trade-form').
  // useEffectEvent keeps the handler on the latest state without
  // resubscribing the listener.
  const onOpenTradeForm = useEffectEvent(() => { tryOpenTradeForm(); });
  useEffect(() => {
    const handler = () => { onOpenTradeForm(); };
    window.addEventListener('open-trade-form', handler);
    return () => window.removeEventListener('open-trade-form', handler);
  }, []);

  // Keep server components in sync with client-side session changes (token
  // refresh in this or another tab, sign-out) instead of bouncing to /login
  // on the next navigation with stale cookies.
  useEffect(() => {
    const { data: { subscription } } = createClient().auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED') {
        router.refresh();
      }
    });
    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle() {
    const next = !expanded;
    setExpandedOverride(next);
    if (!isMobile) localStorage.setItem('sidebar-expanded', String(next));
    setHandleUsedNow(true);
    localStorage.setItem('sidebar-handle-used', 'true');
    // A user-initiated toggle always animates — ends the post-hydration hold
    // even if the saved-state equality guard hasn't released it yet.
    setMotionReady(true);
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
    <div dir="rtl" className={`min-h-screen sidebar-motion${motionReady ? '' : ' sidebar-motion-hold'}`}>

      {/* Mobile backdrop — always mounted, fades so it never pops in/out */}
      <div
        className="fixed inset-0 z-30"
        style={{
          background:    'rgba(0,0,0,0.7)',
          opacity:       isMobile && expanded ? 1 : 0,
          pointerEvents: isMobile && expanded ? 'auto' : 'none',
          transition:    `opacity ${SIDEBAR_TRANSITION}`,
        }}
        onClick={() => setExpandedOverride(false)}
      />

      {/* ── Toggle handle ────────────────────────────────────────────
          The button owns positioning (differs per state/viewport, inline)
          and the hit area; the inner .sidebar-handle span owns every visual
          (gradient half-pill + glow + hover lift) — see globals.css. */}
      <button
        onClick={toggle}
        aria-label={expanded ? 'כווץ סרגל' : 'הרחב סרגל'}
        className="sidebar-handle-btn hit-40 fixed z-50 w-7 h-14"
        style={
          isMobile
            ? {
                // Open: vertically centered on the drawer's visible edge.
                // Closed: the drawer is fully off-canvas, so there's no panel
                // edge to attach to — sit flush on the screen edge instead.
                right:     expanded ? W_OPEN : 0,
                top:       '50%',
                transform: 'translateY(-50%)',
              }
            : {
                // Tracks the sidebar's visible edge via transform only (isolated
                // fixed element — moving it doesn't reflow any sibling).
                right:      W_SHUT,
                top:        '50%',
                transform:  `translate(${expanded ? -RAIL_INSET : 0}px, -50%)`,
                transition: `transform ${SIDEBAR_TRANSITION}`,
              }
        }
      >
        <span className={`sidebar-handle${handleUsed ? '' : ' sidebar-handle-pulse'}`}>
          <span className="sidebar-handle-icon flex items-center justify-center">
            {/* translateX(1px) = optical centering, nudged toward the point;
                it rides inside the rotation, so it flips with the chevron. */}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
              style={{
                transform: `rotate(${expanded ? 0 : 180}deg) translateX(1px)`,
                transition: `transform ${SIDEBAR_TRANSITION}`,
              }}>
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </span>
        </span>
      </button>

      {/* ── Right sidebar ─────────────────────────────────────────── */}
      <aside
        dir="rtl"
        className="fixed inset-y-0 right-0 z-40 flex flex-col"
        style={{
          width:        W_OPEN,
          // Solid surface on mobile: the drawer is a full overlay above live
          // content there (desktop never has content behind it), so NAV_BG's
          // built-in translucency would let content bleed through instead of
          // reading as a proper panel.
          background:   isMobile ? 'var(--color-tg-surface)' : NAV_BG,
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

        {/* Logo — no right padding, so the mark's row edge lines up with the
            aside's true right edge exactly like the nav rows below, and the
            mark sits fully inside the 64px rail that's always visible */}
        <div
          className="flex items-center h-16 shrink-0 pl-3.5"
          style={{ borderBottom: `1px solid ${SEP}` }}
        >
          <Logo showWordmark={expanded} />
        </div>

        {/* Primary nav — no right padding: rows' own right edges line up with
            the aside's true right edge, so each row's absolutely-positioned
            icon slot (right:0, width:W_SHUT) reproduces the visible rail
            exactly, regardless of collapsed/expanded state. */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 flex flex-col gap-0.5 pl-2 [scrollbar-gutter:stable]">
          {PRIMARY_NAV.map(item => (
            <NavLink
              key={item.href}
              item={{ ...item, href: navPrefix + item.href }}
              expanded={expanded}
              active={isActive(navPrefix + item.href)}
              hardNav={isDemo}
            />
          ))}

          {/* Separator */}
          <div className="my-2 mx-1" style={{ height: 1, background: SEP }} />

          {isDemo ? (
            /* Demo: no settings/feedback/sign-out — a single signup CTA instead */
            <NavLink
              item={{ href: '/signup', label: 'התחילו עכשיו', icon: <IconPlus /> }}
              expanded={expanded}
              active={false}
              hardNav
            />
          ) : (
          <>
          {SECONDARY_NAV.map(item => (
            <NavLink key={item.href} item={item} expanded={expanded} active={isActive(item.href)} />
          ))}

          {/* Sign out — same fixed rail-slot icon as NavLink; hover affordance
              is two differently-sized decorative spans (full-row vs
              rail-confined) rather than one background that would clip. */}
          <button
            onClick={handleSignOut}
            title={!expanded ? 'התנתק' : undefined}
            className="relative flex items-center rounded-xl cursor-pointer"
            style={{ height: 44, paddingRight: W_SHUT, paddingLeft: 12, color: 'var(--text-primary)' }}
          >
            <span
              aria-hidden
              className={expanded ? 'absolute inset-0 rounded-xl hover:bg-white/5 pointer-events-auto' : 'hidden'}
            />
            <span
              aria-hidden
              className={!expanded ? 'absolute rounded-xl hover:bg-white/5 pointer-events-auto' : 'hidden'}
              style={{ top: 4, bottom: 4, right: 12, width: 40 }}
            />
            <span
              className="absolute flex items-center justify-center"
              style={{ top: 0, bottom: 0, right: 0, width: W_SHUT }}
            >
              <IconLogout />
            </span>
            <span
              aria-hidden={!expanded}
              className="relative text-sm font-semibold"
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
          </>
          )}
        </nav>

        {/* User area + CTA — no right padding, matching nav rows above, so the
            avatar's and CTA icon's rail slots align exactly with the visible
            strip regardless of collapsed/expanded state. */}
        <div className="shrink-0 pl-2 pb-3 pt-2 flex flex-col gap-2" style={{ borderTop: `1px solid ${SEP}` }}>

          {/* Avatar / user info — avatar sits in a fixed rail slot (its
              position never changes), name + theme toggle fade in the
              remaining space when expanded. */}
          <div className="relative flex items-center" style={{ height: 40, paddingRight: W_SHUT, paddingLeft: 4 }}>
            <span
              className="absolute flex items-center justify-center"
              style={{ top: 0, bottom: 0, right: 0, width: W_SHUT }}
            >
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
                style={{ background: 'rgba(0,210,210,0.12)', color: ACCENT }}
                title={!expanded ? displayName : undefined}
              >
                {(displayName || '?').charAt(0).toUpperCase()}
              </div>
            </span>
            <div
              className="relative flex-1 flex items-center gap-2 min-w-0"
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

          {/* New trade — same fixed rail-slot icon pattern; the solid accent
              button cross-fades between a full-width pill (expanded) and a
              compact pill confined to the rail (collapsed) instead of one
              shape trying to be both. */}
          <button
            onClick={() => tryOpenTradeForm()}
            title={!expanded ? 'עסקה חדשה' : undefined}
            className="relative flex items-center rounded-xl transition-opacity hover:opacity-85 active:scale-95"
            style={{ height: 44, paddingRight: W_SHUT, paddingLeft: 12, color: '#000' }}
          >
            <span
              aria-hidden
              className="absolute inset-0 rounded-xl pointer-events-none"
              style={{ background: ACCENT, opacity: expanded ? 1 : 0, transition: `opacity ${SIDEBAR_TRANSITION}` }}
            />
            <span
              aria-hidden
              className="absolute rounded-xl pointer-events-none"
              style={{
                top: 4, bottom: 4, right: 12, width: 40,
                background: ACCENT, opacity: expanded ? 0 : 1, transition: `opacity ${SIDEBAR_TRANSITION}`,
              }}
            />
            <span
              className="absolute flex items-center justify-center"
              style={{ top: 0, bottom: 0, right: 0, width: W_SHUT }}
            >
              <IconPlus />
            </span>
            <span
              aria-hidden={!expanded}
              className="relative font-semibold text-sm"
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
        {isDemo && !embedded && (
          <div
            className="sticky top-0 z-20 flex items-center justify-center gap-3 px-4 py-2"
            style={{
              background: 'rgba(0,210,210,0.10)',
              borderBottom: '1px solid rgba(0,210,210,0.25)',
              backdropFilter: 'blur(8px)',
            }}
          >
            <span className="text-xs font-semibold" style={{ color: 'var(--color-tg-text)' }}>
              מצב דמו — כל הנתונים לדוגמה
            </span>
            <a
              href="/signup"
              className="text-xs font-bold px-3 py-1 rounded-full transition-opacity hover:opacity-85"
              style={{ background: ACCENT, color: '#0a0a0f' }}
            >
              התחילו עכשיו
            </a>
          </div>
        )}
        <PageTransition>
          {children}
        </PageTransition>
      </div>

      {isDemo && <DemoGuard />}

      {!isDemo && (
      <TradePlanForm
        userId={userId}
        plan={plan}
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={() => router.refresh()}
        initialWarning={ruleWarning}
      />
      )}

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

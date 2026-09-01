// Internal tooling — NOT linked anywhere in the UI.
//
// Curated phone-sized (390×844) composition of the app's key sections, fed by
// the demo fixtures, captured by Playwright to produce the phone-mockup image
// on the auth pages (public/auth/phone-demo.png). Re-capture with
// `node scripts/capture-phone-demo.mjs` against a running prod build. Reached
// via /demo/phone-showcase (the proxy rewrites it here with X-Robots-Tag:
// noindex); direct /phone-showcase access is gated to logged-in users like any
// app route.
//
// The visual language deliberately mirrors DashboardClient (Card, SectionTitle,
// SemiGauge, recent-trades rows) so the mockup looks exactly like the product.
//
// ── What this page must not show ──
//
// This composition previously led with a P&L balance (₪10,960 total, ₪4,796 for
// the month) and a 71% win-rate gauge, and the capture of it is published on
// every auth screen. A numeric win rate is on the NinjaTrader guidelines'
// explicit prohibition list, and money P&L figures read as hypothetical
// performance — neither is curable by an illustrative label, which is why this
// was recomposed rather than badged.
//
// So: no win rate, no P&L, no per-trade money or points result. What is shown
// instead is what the product actually measures — the discipline score, the
// rules the trader set, and whether each trade followed its plan. That is both
// compliant and a truer advertisement than a profit figure was.
//
// Anything added here later has to clear the same bar. Adherence counts ("18 of
// 20 trades followed the plan") are fine: they measure process, not profit.

import type { Metadata } from 'next';
import { Logo } from '@/components/ui/Logo';
import { MAIN_CONTENT_ID } from '@/components/accessibility/SkipLink';
import { SiteDisclosureFooter } from '@/components/legal/SiteDisclosureFooter';
import { DEMO_TABLES } from '@/lib/demo/fixtures';
import { mapDashTrade, type DashTrade } from '@/lib/dashboard/trades';
import { tradeDirection } from '@/lib/pnl';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const ACCENT = '#00d2d2';
const SURF   = 'var(--color-tg-surface)';
const BORDER = 'var(--color-tg-border)';
const TEXT   = 'var(--color-tg-text)';
const TEXT2  = 'var(--color-tg-text-2)';
const MUTED  = 'var(--color-tg-muted)';
const GREEN  = '#22c55e';
const RED    = '#ef4444';

// ── SemiGauge (copy of DashboardClient's internal helper) ─────────────────────

function semiArcPoint(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy - r * Math.sin(rad)];
}
function semiArcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = semiArcPoint(cx, cy, r, a0);
  const [x1, y1] = semiArcPoint(cx, cy, r, a1);
  const largeArc = Math.abs(a0 - a1) > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1}`;
}
function SemiGauge({ segments, width = 140, strokeWidth = 12 }: {
  segments: { value: number; color: string }[]; width?: number; strokeWidth?: number;
}) {
  const r      = (width - strokeWidth) / 2;
  const cx     = width / 2;
  const cy     = r + strokeWidth / 2;
  const height = cy + strokeWidth / 2;
  const total  = segments.reduce((s, sg) => s + Math.max(sg.value, 0), 0);
  if (total <= 0) return <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', maxWidth: width }} />;

  const validSegs = segments.filter(sg => Math.max(sg.value, 0) > 0);
  const spans = validSegs.map(sg => (Math.max(sg.value, 0) / total) * 180);
  const segsWithEnd = validSegs.map((sg, idx) => ({
    color: sg.color,
    end: idx === validSegs.length - 1
      ? 0
      : 180 - spans.slice(0, idx + 1).reduce((s, v) => s + v, 0),
  }));
  const layers = [...segsWithEnd].reverse().map(sg => ({
    d: semiArcPath(cx, cy, r, 180, sg.end),
    color: sg.color,
  }));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', maxWidth: width, height: 'auto', display: 'block' }}>
      {layers.map((l, i) => (
        <path key={i} d={l.d} fill="none" stroke={l.color} strokeWidth={strokeWidth} strokeLinecap="butt" />
      ))}
    </svg>
  );
}

// ── Shared card chrome (mirrors DashboardClient) ──────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-4"
      style={{
        background: SURF,
        border: `1px solid ${BORDER}`,
        boxShadow: '0 1px 3px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.03)',
      }}>
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <div style={{ width: 3, height: 14, background: ACCENT, borderRadius: 99, flexShrink: 0 }} />
      <p style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: MUTED }}>
        {children}
      </p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

/** The three rules the fixture trader has set, as the rules screen shows them. */
const RULE_ACTION_LABELS: Record<string, string> = {
  block_day: 'חסימה',
  block_timer: 'השהיה',
  warn: 'אזהרה',
};

export default function PhoneShowcasePage() {
  const trades: DashTrade[] = (DEMO_TABLES.trade_plans as unknown as Parameters<typeof mapDashTrade>[0][])
    .map(mapDashTrade)
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));

  const closed = trades.filter(t => t.status === 'closed' && t.exit_price != null);

  // Plan adherence — a process measure, not a performance one. This counts how
  // many closed trades were executed as planned; it says nothing about whether
  // they made money, which is the distinction that matters here.
  const followed         = closed.filter(t => t.followed_plan === true).length;
  const disciplineScore  = closed.length ? Math.round((followed / closed.length) * 100) : 0;

  const rules = (DEMO_TABLES.custom_rules as unknown as {
    id: string; name: string; action_type: string; is_active: boolean;
  }[]).filter(r => r.is_active).slice(0, 3);

  // At most one open trade on top, then the most recent closed ones. Three, not
  // four: the rules card added height above, and a fourth row runs past the
  // 844px viewport the capture uses, clipping mid-row.
  const recent = [
    ...(trades[0]?.status !== 'closed' ? [trades[0]] : []),
    ...closed,
  ].slice(0, 3);

  return (
    <div dir="rtl" className="min-h-screen" style={{ background: 'var(--color-tg-bg)' }}>
      <div className="mx-auto flex flex-col" style={{ maxWidth: 390, minHeight: 844 }}>

        {/* Status-bar safe zone — keeps content clear of the mockup's Dynamic
            Island overlay and the screen's rounded corners */}
        <div style={{ height: 44 }} />

        {/* App bar — logo small, aligned to the start edge like the real shell */}
        <header className="flex items-center" style={{ height: 48, paddingInline: 20, borderBottom: `1px solid ${BORDER}` }}>
          <span className="inline-block" style={{ transform: 'scale(0.55)', transformOrigin: 'right center' }}>
            <Logo />
          </span>
        </header>

        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex flex-col gap-3 px-3 pt-4 pb-5">
          {/* Greeting — same as the dashboard header */}
          <div className="px-1">
            <p style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>
              {new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
            <p style={{ fontSize: 24, fontWeight: 800, color: TEXT }}>
              בוקר טוב, <span style={{ color: ACCENT }}>סוחר</span>
            </p>
          </div>

          {/* Discipline score — the product's own metric, in the slot the P&L
              balance used to hold. */}
          <Card>
            <p style={{ fontSize: 14, fontWeight: 700, color: TEXT2, marginBottom: 12 }}>ציון משמעת</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 88, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <p style={{
                  fontSize: 40, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.02em',
                  color: ACCENT, direction: 'ltr', unicodeBidi: 'isolate',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {disciplineScore}
                  <span style={{ fontSize: 16, fontWeight: 700, color: TEXT2 }}>/100</span>
                </p>
                <p style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>
                  {followed} מתוך {closed.length} עסקאות בוצעו לפי התוכנית
                </p>
              </div>
              <div style={{ flex: '0 1 130px', minWidth: 72 }}>
                <SemiGauge width={130} strokeWidth={12} segments={[
                  { value: disciplineScore, color: ACCENT },
                  { value: 100 - disciplineScore, color: 'rgba(148,163,184,0.25)' },
                ]} />
              </div>
            </div>
          </Card>

          {/* The trader's own rules, with the enforcement level each carries. */}
          <Card>
            <SectionTitle>הכללים שלך</SectionTitle>
            <div className="flex flex-col gap-0">
              {rules.map((r, i) => (
                <div key={r.id} className="flex items-center gap-2 py-2.5"
                  style={{ borderTop: i > 0 ? `1px solid ${BORDER}` : undefined }}>
                  <span className="flex-1 min-w-0 text-sm font-semibold truncate" style={{ color: TEXT }}>
                    {r.name}
                  </span>
                  <span className="shrink-0 text-[10px] px-2 py-0.5 rounded font-semibold"
                    style={{
                      background: r.action_type === 'warn' ? 'rgba(245,158,11,0.14)' : 'rgba(0,210,210,0.12)',
                      color: r.action_type === 'warn' ? '#f59e0b' : ACCENT,
                    }}>
                    {RULE_ACTION_LABELS[r.action_type] ?? 'פעיל'}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          {/* Recent trades */}
          <Card>
            <SectionTitle>עסקאות אחרונות</SectionTitle>
            <div className="flex flex-col gap-0">
              {recent.map((t, i) => {
                const dir  = tradeDirection(t);
                const open = t.status !== 'closed';
                return (
                  <div key={t.id} className="flex items-center gap-2 py-3"
                    style={{ borderTop: i > 0 ? `1px solid ${BORDER}` : undefined }}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-semibold truncate" style={{ color: TEXT }}>
                          {t.symbol ?? t.strategy}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold"
                          style={{
                            background: dir === 'long' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                            color: dir === 'long' ? GREEN : RED,
                          }}>
                          {dir === 'long' ? '↑ לונג' : '↓ שורט'}
                        </span>
                      </div>
                      {/* Date and strategy only. Entry/exit prices are gone with
                          the P&L column: side by side they let a reader compute
                          the result the card is deliberately not stating. */}
                      <p className="text-[10px] mt-0.5" style={{ color: MUTED, fontWeight: 600 }}>
                        {new Date(t.submitted_at).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })}
                        {' · '}{t.strategy}
                      </p>
                    </div>
                    <div className="shrink-0">
                      {open ? (
                        <p className="text-xs font-semibold" style={{ color: ACCENT }}>פתוח</p>
                      ) : (
                        <span className="text-[10px] px-2 py-0.5 rounded font-semibold"
                          style={{
                            background: t.followed_plan ? 'rgba(0,210,210,0.12)' : 'rgba(245,158,11,0.14)',
                            color: t.followed_plan ? ACCENT : '#f59e0b',
                          }}>
                          {t.followed_plan ? 'לפי התוכנית' : 'חריגה מהכללים'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </main>
      </div>

      {/* Outside the 390px phone column, so it is page furniture rather than
          part of the mockup.

          This route is reachable without auth at /demo/phone-showcase, and it
          renders a trading interface — so it needs the risk disclosure like any
          other public page, noindex or not. It was the one public route without
          one.

          The capture script hides it before shooting, the same way it hides the
          floating accessibility button: it belongs on the page, not in the
          phone. */}
      <SiteDisclosureFooter />
    </div>
  );
}

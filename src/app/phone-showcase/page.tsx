// Internal tooling — NOT linked anywhere in the UI.
//
// Curated phone-sized (390×844) composition of the app's key sections, fed by
// the demo fixtures, captured by Playwright to produce the phone-mockup image
// on the auth pages (public/auth/phone-demo.png). Reached via
// /demo/phone-showcase (the proxy rewrites it here with X-Robots-Tag: noindex);
// direct /phone-showcase access is gated to logged-in users like any app route.
//
// The visual language deliberately mirrors DashboardClient (Card, SectionTitle,
// SemiGauge, recent-trades rows) so the mockup looks exactly like the product.

import type { Metadata } from 'next';
import { Logo } from '@/components/ui/Logo';
import { DEMO_TABLES } from '@/lib/demo/fixtures';
import { mapDashTrade, type DashTrade } from '@/lib/dashboard/trades';
import { tradeMoneyPnl, hasMoneyPnl, isWinningTrade, tradeDirection, tradePointsPnl } from '@/lib/pnl';
import { formatPnlIls, formatPnlPoints } from '@/lib/utils';

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

export default function PhoneShowcasePage() {
  const trades: DashTrade[] = (DEMO_TABLES.trade_plans as unknown as Parameters<typeof mapDashTrade>[0][])
    .map(mapDashTrade)
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));

  const closed = trades.filter(t => t.status === 'closed' && t.exit_price != null);

  const totalPnl   = closed.reduce((s, t) => s + tradeMoneyPnl(t), 0);
  const monthKey   = new Date().toISOString().slice(0, 7);
  const monthlyPnl = closed
    .filter(t => (t.closed_at ?? t.submitted_at).slice(0, 7) === monthKey)
    .reduce((s, t) => s + tradeMoneyPnl(t), 0);

  const wins   = closed.filter(t => isWinningTrade(t) === true).length;
  const losses = closed.length - wins;
  const winPct = closed.length ? Math.round((wins / closed.length) * 100) : 0;

  // Curated rows: money figures first — at most one open trade on top, the
  // rest recent closed trades with real ₪ values.
  const recent = [
    ...(trades[0]?.status !== 'closed' ? [trades[0]] : []),
    ...closed,
  ].slice(0, 4);

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

        <main className="flex flex-col gap-3 px-3 pt-4 pb-5">
          {/* Greeting — same as the dashboard header */}
          <div className="px-1">
            <p style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>
              {new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
            <p style={{ fontSize: 24, fontWeight: 800, color: TEXT }}>
              בוקר טוב, <span style={{ color: ACCENT }}>סוחר</span>
            </p>
          </div>

          {/* P&L balance */}
          <Card>
            <p style={{ fontSize: 14, fontWeight: 700, color: TEXT2, marginBottom: 10 }}>מאזן P&L</p>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
              {(['כללי', 'חודשי', 'שבועי', 'יומי'] as const).map((label, i) => (
                <span key={label}
                  style={{
                    background: i === 0 ? 'rgba(0,210,210,0.12)' : 'transparent',
                    color: i === 0 ? ACCENT : TEXT2,
                    border: i === 0 ? '1px solid rgba(0,210,210,0.3)' : `1px solid ${BORDER}`,
                    borderRadius: 6, padding: '5px 10px', fontSize: 11, fontWeight: 600,
                  }}>
                  {label}
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 32, fontWeight: 800, letterSpacing: '-0.02em', whiteSpace: 'nowrap',
                direction: 'ltr', unicodeBidi: 'isolate', fontVariantNumeric: 'tabular-nums',
                color: totalPnl >= 0 ? GREEN : RED,
              }}>
                {formatPnlIls(totalPnl)}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: TEXT2 }}>({closed.length} עסקאות)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>החודש</span>
              <span style={{
                fontSize: 15, fontWeight: 800, direction: 'ltr', unicodeBidi: 'isolate',
                fontVariantNumeric: 'tabular-nums', color: monthlyPnl >= 0 ? GREEN : RED,
              }}>
                {formatPnlIls(monthlyPnl)}
              </span>
            </div>
          </Card>

          {/* Win rate */}
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 88, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: TEXT2 }}>
                  אחוזי הצלחה
                </p>
                <p style={{ fontSize: 28, fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: winPct >= 50 ? GREEN : RED }}>
                  {winPct}%
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ fontSize: 14, fontWeight: 800, color: GREEN, fontVariantNumeric: 'tabular-nums' }}>{wins}</span>
                  <span style={{ fontSize: 10, color: MUTED, fontWeight: 600 }}>|</span>
                  <span style={{ fontSize: 14, fontWeight: 800, color: RED, fontVariantNumeric: 'tabular-nums' }}>{losses}</span>
                </div>
              </div>
              <div style={{ flex: '0 1 130px', minWidth: 72 }}>
                <SemiGauge width={130} strokeWidth={12} segments={[
                  { value: winPct, color: GREEN },
                  { value: 100 - winPct, color: RED },
                ]} />
              </div>
            </div>
          </Card>

          {/* Recent trades */}
          <Card>
            <SectionTitle>עסקאות אחרונות</SectionTitle>
            <div className="flex flex-col gap-0">
              {recent.map((t, i) => {
                const dir = tradeDirection(t);
                const pts = tradePointsPnl(t);
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
                      <p className="text-[10px] mt-0.5" style={{ color: MUTED, fontWeight: 600 }}>
                        {new Date(t.submitted_at).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })}
                        {' · כניסה '}{t.entry_price.toFixed(2)}
                        {t.exit_price != null ? ` · יציאה ${t.exit_price.toFixed(2)}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0">
                      {pts !== null ? (
                        <p className="text-sm font-bold" style={{ color: (hasMoneyPnl(t) ? tradeMoneyPnl(t) : pts) >= 0 ? GREEN : RED }}>
                          {hasMoneyPnl(t) ? (
                            <>
                              {formatPnlIls(tradeMoneyPnl(t), t.pnl_currency ?? '₪')}
                              <span className="text-[9px] font-semibold" style={{ opacity: 0.6 }}> ({formatPnlPoints(pts)})</span>
                            </>
                          ) : `${pts >= 0 ? '+' : ''}${pts.toFixed(2)}`}
                        </p>
                      ) : (
                        <p className="text-xs font-semibold" style={{ color: ACCENT }}>פתוח</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </main>
      </div>
    </div>
  );
}

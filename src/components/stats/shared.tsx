import type { CSSProperties, ReactNode } from 'react';

// ── Design tokens ────────────────────────────────────────────────────────────
export const SURF   = 'var(--color-tg-surface)';
export const ACCENT = 'var(--color-tg-primary)';
export const GREEN  = 'var(--color-tg-success)';
export const RED    = 'var(--color-tg-danger)';
export const AMBER  = 'var(--color-tg-warning)';
export const MUTED  = 'var(--color-tg-muted)';
export const TEXT   = 'var(--color-tg-text)';
export const BORDER = 'var(--color-tg-border-light)';

// Hex twins for raw-SVG paint (gradient stops and presentation attributes
// can't resolve CSS variables reliably)
export const GREEN_HEX  = '#22c55e';
export const RED_HEX    = '#ef4444';
export const AMBER_HEX  = '#f59e0b';
export const ACCENT_HEX = '#00d2d2';
export const GRAY_HEX   = '#64748b';

// ── Helpers ───────────────────────────────────────────────────────────────────
export function fmt(v: number, currency: string = '₪'): string {
  if (v === 0) return `${currency}0`;
  return `${v > 0 ? '+' : '−'}${currency}${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
}

export function pnlColor(v: number): string {
  return v < 0 ? RED : GREEN;
}

export function pnlHex(v: number): string {
  return v < 0 ? RED_HEX : GREEN_HEX;
}

// ── Section header: icon + title 18px + optional count ──────────────────────
export function Section({ title, icon, count, children }: {
  title: string; icon?: ReactNode; count?: string; children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="flex items-center gap-2" style={{ fontSize: 18, fontWeight: 700, color: TEXT }}>
        <span className="flex items-center" style={{ color: ACCENT }}>{icon}</span>
        {title}
        {count && <span style={{ fontSize: 12, fontWeight: 500, color: MUTED }}>· {count}</span>}
      </h2>
      {children}
    </div>
  );
}

// ── Tooltip shell shared by the recharts tooltips ────────────────────────────
export function TooltipCard({ children }: { children: ReactNode }) {
  const style: CSSProperties = {
    background: 'var(--color-tg-surface-2)',
    border: `1px solid ${BORDER}`,
    borderRadius: 10,
    padding: '8px 12px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    fontSize: 12,
  };
  return <div dir="rtl" style={style}>{children}</div>;
}

import type { ReactNode } from 'react';

// ── Design tokens ────────────────────────────────────────────────────────────
export const SURF   = 'var(--color-tg-surface)';
export const ACCENT = 'var(--color-tg-primary)';
export const GREEN  = 'var(--color-tg-success)';
export const RED    = 'var(--color-tg-danger)';
export const MUTED  = 'var(--color-tg-muted)';
export const TEXT   = 'var(--color-tg-text)';

const TRACK = 'var(--color-tg-surface-2)';

// ── Helpers ───────────────────────────────────────────────────────────────────
export function fmt(v: number, currency: string = '₪'): string {
  if (v === 0) return `${currency}0`;
  return `${v > 0 ? '+' : '−'}${currency}${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
}

export function pnlColor(v: number): string {
  return v < 0 ? RED : GREEN;
}

// ── Section title ────────────────────────────────────────────────────────────
export function Section({ title, icon, children }: {
  title: string; icon?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="flex items-center gap-2" style={{ fontSize: 18, fontWeight: 700, color: TEXT }}>
        {icon}
        {title}
      </h2>
      {children}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
export function StatCard({ label, value, sub, positive, icon, fixedHeight, valueColor, largeLabel }: {
  label: string; value: string; sub?: string; positive: boolean; icon?: ReactNode; fixedHeight?: boolean;
  valueColor?: string; largeLabel?: boolean;
}) {
  return (
    <div className={`rounded-xl flex flex-col justify-center gap-1.5 ${fixedHeight ? 'h-28' : ''}`}
      style={{ background: SURF, borderLeft: `4px solid ${positive ? GREEN : RED}`, padding: 20, borderRadius: 12 }}>
      <p className="flex items-center gap-1.5"
        style={largeLabel ? { fontSize: 15, fontWeight: 600, color: TEXT } : { fontSize: 12, color: MUTED }}>
        {icon}
        {label}
      </p>
      <p style={{ fontSize: 22, fontWeight: 700, color: valueColor ?? TEXT, lineHeight: 1.2 }}>{value}</p>
      {sub && <p style={{ fontSize: 11, color: MUTED }}>{sub}</p>}
    </div>
  );
}

// ── Breakdown row (strategy / symbol) ────────────────────────────────────────
export function BreakdownRow({ name, pnl, trades, winRate, rr, barPct }: {
  name: string; pnl: number; trades: number; winRate: number | null; rr?: number; barPct: number;
}) {
  return (
    <div className="rounded-xl flex items-center gap-4"
      style={{ background: SURF, borderLeft: `4px solid ${pnlColor(pnl)}`, padding: 20, borderRadius: 12 }}>
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>{name}</span>
          <span style={{ fontSize: 11, color: MUTED }}>{trades} עסקאות</span>
        </div>
        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: TRACK }}>
          <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: pnlColor(pnl) }} />
        </div>
      </div>
      <div className="flex flex-col items-end shrink-0 gap-1">
        <span style={{ fontSize: 22, fontWeight: 700, color: TEXT }}>{fmt(pnl)}</span>
        <div className="flex gap-2" style={{ fontSize: 11, color: MUTED }}>
          {winRate !== null && <span>{winRate}%</span>}
          {rr !== undefined && <span>R:R {rr.toFixed(1)}</span>}
        </div>
      </div>
    </div>
  );
}

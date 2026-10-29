import { ShieldAlert, Route, ArrowUpDown, Zap, Flame } from 'lucide-react';
import { Section } from './shared';

interface Props {
  deviatedPct: number | null;
  movedSlPct: number | null;
  fomoPct: number | null;
  revengePct: number | null;
  /**
   * `targetMoveLine(...)` — one sentence about the broker's target orders, or
   * null (REF-130 part ג, item 3).
   *
   * A ROW UNDER THE CHIPS AND NOT A FIFTH CHIP, because it is not a rate. The
   * four above are "x% of the trades that answered", over denominators in the
   * dozens; this is "N of M", over a denominator that is the number of broker
   * rows imported since REF-130 shipped — which starts at zero and stays small
   * for a while. A `33%` chip built on three trades reads as a measurement of
   * the trader, and `1 מתוך 3` reads as what it is.
   */
  targetMoveLine: string | null;
}

// Severity by rate: 0% calm/green · 1-14% amber · 15%+ red · null = no data
function severity(pct: number | null) {
  if (pct === null) return {
    color: 'var(--color-tg-muted)',
    bg: 'var(--color-tg-surface-2)',
    border: 'var(--color-tg-border-light)',
  };
  if (pct === 0) return {
    color: 'var(--color-tg-success)',
    bg: 'var(--color-tg-success-muted)',
    border: 'rgba(34,197,94,0.28)',
  };
  if (pct < 15) return {
    color: 'var(--color-tg-warning)',
    bg: 'var(--color-tg-warning-muted)',
    border: 'rgba(245,158,11,0.28)',
  };
  return {
    color: 'var(--color-tg-danger)',
    bg: 'var(--color-tg-danger-muted)',
    border: 'rgba(239,68,68,0.28)',
  };
}

export default function BehaviorChips({
  deviatedPct,
  movedSlPct,
  fomoPct,
  revengePct,
  targetMoveLine,
}: Props) {
  const metrics = [
    { label: 'סטייה מהתוכנית', pct: deviatedPct, icon: <Route aria-hidden="true" size={15} /> },
    { label: 'הזזת Stop Loss',  pct: movedSlPct,  icon: <ArrowUpDown aria-hidden="true" size={15} /> },
    { label: 'עסקאות FOMO',     pct: fomoPct,     icon: <Zap aria-hidden="true" size={15} /> },
    { label: 'Revenge Trades',  pct: revengePct,  icon: <Flame aria-hidden="true" size={15} /> },
  ];

  return (
    <Section title="מדדים התנהגותיים" icon={<ShieldAlert aria-hidden="true" size={18} />}>
      <div className="flex flex-wrap gap-3">
        {metrics.map((m) => {
          const s = severity(m.pct);
          return (
            <div key={m.label}
              className="flex items-center gap-2.5 rounded-xl px-4 py-2.5"
              style={{ background: s.bg, border: `1px solid ${s.border}` }}>
              <span className="flex items-center" style={{ color: s.color }}>{m.icon}</span>
              <span className="stats-num" style={{ fontSize: 16, fontWeight: 700, color: s.color }}>
                {m.pct !== null ? `${m.pct}%` : '—'}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-tg-text-2)' }}>{m.label}</span>
            </div>
          );
        })}
      </div>
      {/* The broker's target orders, in one neutral line (REF-130 part ג).
          UNCOLOURED AND UNICONED on purpose: moving a target is not a failing
          in either direction — see `targetMoveSentence` in
          lib/journal/stopHistory.ts, which argues the tone at length — so this
          sits in the muted text the rest of the page uses for a sub-figure
          rather than borrowing the chips' severity palette. */}
      {targetMoveLine !== null && (
        <p className="mt-3" style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-tg-text-2)' }}>
          {targetMoveLine}
        </p>
      )}
    </Section>
  );
}

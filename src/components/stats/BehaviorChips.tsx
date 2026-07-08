import { ShieldAlert, Route, ArrowUpDown, Zap, Flame } from 'lucide-react';
import { Section } from './shared';

interface Props {
  deviatedPct: number | null;
  movedSlPct: number | null;
  fomoPct: number | null;
  revengePct: number | null;
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

export default function BehaviorChips({ deviatedPct, movedSlPct, fomoPct, revengePct }: Props) {
  const metrics = [
    { label: 'סטייה מהתוכנית', pct: deviatedPct, icon: <Route size={15} /> },
    { label: 'הזזת Stop Loss',  pct: movedSlPct,  icon: <ArrowUpDown size={15} /> },
    { label: 'עסקאות FOMO',     pct: fomoPct,     icon: <Zap size={15} /> },
    { label: 'Revenge Trades',  pct: revengePct,  icon: <Flame size={15} /> },
  ];

  return (
    <Section title="מדדים התנהגותיים" icon={<ShieldAlert size={18} />}>
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
    </Section>
  );
}

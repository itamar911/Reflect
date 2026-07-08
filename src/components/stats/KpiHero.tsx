import type { PeriodPoint } from './PnlChart';
import {
  GREEN, RED, MUTED, TEXT, fmt, pnlColor,
  GREEN_HEX, RED_HEX, AMBER_HEX,
} from './shared';

interface Props {
  totalPnl: number;
  closedCount: number;
  winRate: number;
  winsCount: number;
  profitFactor: number;
  avgRR: number;
  tradesCount: number;
  disciplineScore: number | null;
  avgWin: number;
  avgLoss: number;
  currentStreak: { type: 'win' | 'loss'; count: number } | null;
  daily: PeriodPoint[];
}

export default function KpiHero({
  totalPnl, closedCount, winRate, winsCount, profitFactor, avgRR, tradesCount,
  disciplineScore, avgWin, avgLoss, currentStreak, daily,
}: Props) {
  // Cumulative equity series for the sparkline
  const cum: number[] = [];
  let run = 0;
  for (const d of daily) { run += d.pnl; cum.push(run); }

  const heroColor  = closedCount > 0 ? pnlColor(totalPnl) : MUTED;
  const sparkColor = totalPnl >= 0 ? GREEN_HEX : RED_HEX;

  return (
    <div className="stats-card p-5 md:p-6">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(300px,1fr)_1.35fr] gap-6 items-center">

        {/* Primary KPI — total PnL + sparkline (right side in RTL) */}
        <div className="flex items-center justify-between gap-4 lg:border-l lg:pl-6"
          style={{ borderColor: 'var(--color-tg-border-light)' }}>
          <div className="flex flex-col gap-1">
            <span style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>רווח/הפסד כולל</span>
            <span className="stats-num" style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.05, color: heroColor }}>
              {closedCount > 0 ? fmt(totalPnl) : '—'}
            </span>
            <span style={{ fontSize: 12, color: MUTED }}>{closedCount} עסקאות סגורות</span>
          </div>
          {cum.length > 1 && <Sparkline values={cum} color={sparkColor} />}
        </div>

        {/* Secondary KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Kpi
            label="אחוז הצלחה"
            sub={closedCount > 0 ? `${winsCount} מתוך ${closedCount}` : undefined}
            visual={closedCount > 0
              ? <MiniRing pct={winRate} color={winRate >= 50 ? GREEN_HEX : AMBER_HEX} text={`${winRate}%`} />
              : undefined}
            value={closedCount > 0 ? undefined : '—'}
          />
          <Kpi
            label="פקטור רווח"
            sub="רווח ÷ הפסד"
            value={profitFactor > 0 ? profitFactor.toFixed(2) : '—'}
            valueColor={profitFactor === 0 ? MUTED : profitFactor >= 1 ? GREEN : RED}
          />
          <Kpi
            label="ממוצע R:R"
            value={tradesCount > 0 ? `1:${avgRR.toFixed(1)}` : '—'}
            valueColor={TEXT}
          />
          <Kpi
            label="ציון משמעת"
            sub="מתוך 100"
            visual={disciplineScore !== null
              ? <MiniRing
                  pct={disciplineScore}
                  color={disciplineScore >= 70 ? GREEN_HEX : disciplineScore >= 40 ? AMBER_HEX : RED_HEX}
                  text={String(disciplineScore)}
                />
              : undefined}
            value={disciplineScore === null ? '—' : undefined}
          />
        </div>
      </div>

      {/* Tertiary strip */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-5 pt-4"
        style={{ borderTop: '1px solid var(--color-tg-border-light)' }}>
        <TertiaryStat label="ממוצע רווח" value={fmt(avgWin)} color={avgWin > 0 ? GREEN : MUTED} />
        <Divider />
        <TertiaryStat label="ממוצע הפסד" value={fmt(avgLoss)} color={avgLoss < 0 ? RED : MUTED} />
        <Divider />
        <TertiaryStat
          label="רצף נוכחי"
          value={currentStreak ? `${currentStreak.count} ${currentStreak.type === 'win' ? 'רווחים' : 'הפסדים'}` : '—'}
          color={!currentStreak ? MUTED : currentStreak.type === 'win' ? GREEN : RED}
          plain
        />
      </div>
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function Kpi({ label, sub, value, valueColor, visual }: {
  label: string; sub?: string; value?: string; valueColor?: string; visual?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 min-h-[56px]">
      {visual}
      <div className="flex flex-col gap-0.5">
        {value !== undefined && (
          <span className="stats-num" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1, color: valueColor ?? TEXT }}>
            {value}
          </span>
        )}
        <span style={{ fontSize: 11, fontWeight: 600, color: MUTED }}>{label}</span>
        {sub && <span style={{ fontSize: 10.5, color: MUTED, opacity: 0.75 }}>{sub}</span>}
      </div>
    </div>
  );
}

function TertiaryStat({ label, value, color, plain }: {
  label: string; value: string; color: string; plain?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5" style={{ fontSize: 12, color: MUTED }}>
      {label}
      <span className={plain ? undefined : 'stats-num'} style={{ fontWeight: 700, color }}>{value}</span>
    </span>
  );
}

function Divider() {
  return <span aria-hidden className="w-px h-4" style={{ background: 'var(--color-tg-border-light)' }} />;
}

function MiniRing({ pct, color, text }: { pct: number; color: string; text: string }) {
  const R = 19;
  const C = 2 * Math.PI * R;
  const clamped = Math.min(Math.max(pct, 0), 100);
  return (
    <span style={{ color: TEXT }} className="shrink-0">
      <svg width={46} height={46} viewBox="0 0 46 46" aria-hidden>
        <circle cx={23} cy={23} r={R} fill="none" stroke="rgba(128,128,128,0.25)" strokeWidth={4} />
        <circle cx={23} cy={23} r={R} fill="none" stroke={color} strokeWidth={4}
          strokeDasharray={`${(clamped / 100) * C} ${C}`}
          strokeLinecap="round" transform="rotate(-90 23 23)" />
        <text x={23} y={27} textAnchor="middle" fontSize={12} fontWeight={700} fill="currentColor"
          style={{ fontVariantNumeric: 'tabular-nums' }}>
          {text}
        </text>
      </svg>
    </span>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 160, H = 52, P = 2;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const x = (i: number) => P + (i / (values.length - 1)) * (W - P * 2);
  const y = (v: number) => P + (1 - (v - min) / range) * (H - P * 2);
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(values.length - 1).toFixed(1)},${H - P} L${x(0).toFixed(1)},${H - P} Z`;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden
      className="shrink-0 max-w-[38%]" preserveAspectRatio="none">
      <defs>
        <linearGradient id="kpi-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#kpi-spark)" />
      <path d={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

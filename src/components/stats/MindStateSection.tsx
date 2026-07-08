import { Brain, Lightbulb } from 'lucide-react';
import { MUTED, TEXT, Section, GREEN_HEX, RED_HEX } from './shared';

export interface ScaleBucket {
  level: number;
  trades: number;
  wins: number;
  closedN: number;
  pnl: number;
}

export interface ScalePanelData {
  title: string;
  buckets: ScaleBucket[];
  insights: string[];
}

const GRAY = 'rgba(128,128,128,0.45)';

export default function MindStateSection({ panels }: { panels: ScalePanelData[] }) {
  const legend = (
    <span className="flex items-center flex-wrap gap-x-2 gap-y-1" style={{ fontSize: 11, color: MUTED }}>
      גודל העיגול = כמות עסקאות · צבע = תוצאה ממוצעת
      <span className="flex items-center gap-1">
        <Dot color={GREEN_HEX} /> רווח
      </span>
      <span className="flex items-center gap-1">
        <Dot color={RED_HEX} /> הפסד
      </span>
      <span className="flex items-center gap-1">
        <Dot color={GRAY} /> ללא נתונים
      </span>
    </span>
  );

  return (
    <Section title="המצב הפנימי שלך" icon={<Brain size={18} />} aside={legend}>
      <div className={`grid grid-cols-1 ${panels.length > 1 ? 'lg:grid-cols-2' : ''} gap-4 items-start`}>
        {panels.map((p) => <ScalePanel key={p.title} {...p} />)}
      </div>
    </Section>
  );
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />;
}

function ScalePanel({ title, buckets, insights }: ScalePanelData) {
  const maxTrades = Math.max(...buckets.map(b => b.trades), 1);

  return (
    <div className="stats-card p-4 sm:p-5 flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <p style={{ fontSize: 13, fontWeight: 700, color: TEXT }}>{title}</p>
        <p style={{ fontSize: 10.5, color: MUTED }}>1 = נמוך · 5 = גבוה</p>
      </div>

      {/* 1→5 scale strip: circle size = trade count, color = avg outcome */}
      <div className="flex justify-between gap-1">
        {buckets.map((b) => {
          const avg   = b.closedN > 0 ? b.pnl / b.closedN : null;
          const color = avg === null ? GRAY : avg > 0 ? GREEN_HEX : avg < 0 ? RED_HEX : GRAY;
          const r     = b.trades === 0 ? 5 : 9 + (b.trades / maxTrades) * 13;
          const wr    = b.closedN > 0 ? Math.round((b.wins / b.closedN) * 100) : null;
          return (
            <div key={b.level} className="flex flex-col items-center gap-1.5 flex-1"
              title={b.trades > 0 ? `רמה ${b.level}: ${b.trades} עסקאות` : `רמה ${b.level}: אין עסקאות`}>
              <svg width={48} height={48} viewBox="0 0 48 48" aria-hidden>
                {b.trades > 0 && <circle cx={24} cy={24} r={Math.min(r + 3, 24)} fill={color} opacity={0.15} />}
                <circle
                  cx={24} cy={24} r={r}
                  fill={b.trades === 0 ? 'none' : color}
                  stroke={b.trades === 0 ? GRAY : 'none'}
                  strokeDasharray={b.trades === 0 ? '2 3' : undefined}
                  opacity={b.trades === 0 ? 1 : 0.92}
                />
                {b.trades > 0 && r >= 12 && (
                  <text x={24} y={27.5} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="#0b0f14"
                    style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {b.trades}
                  </text>
                )}
              </svg>
              <span className="stats-num" style={{ fontSize: 11.5, fontWeight: 700, color: wr === null ? MUTED : TEXT }}>
                {wr !== null ? `${wr}%` : '—'}
              </span>
              <span style={{ fontSize: 10, color: MUTED }}>{b.level}</span>
            </div>
          );
        })}
      </div>

      {/* Takeaways */}
      {insights.map((s, i) => (
        <div key={i} className="flex items-center gap-2 rounded-lg px-3 py-2"
          style={{ background: 'var(--color-tg-surface-2)', fontSize: 12, color: 'var(--color-tg-text-2)' }}>
          <Lightbulb size={13} style={{ color: '#f59e0b', flexShrink: 0 }} />
          {s}
        </div>
      ))}
    </div>
  );
}

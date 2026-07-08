import type { ReactNode } from 'react';
import { Trophy, Flame, Zap, TrendingDown, CalendarCheck, CalendarX } from 'lucide-react';
import { GREEN, RED, MUTED, Section } from './shared';

interface RecordValue {
  value: string;
  sub?: string;
}

interface Props {
  maxWinStreak: number;
  maxLossStreak: number;
  bestTrade: RecordValue | null;
  worstTrade: RecordValue | null;
  bestDay: RecordValue | null;
  worstDay: RecordValue | null;
}

export default function RecordsGrid({
  maxWinStreak, maxLossStreak, bestTrade, worstTrade, bestDay, worstDay,
}: Props) {
  const records: { label: string; icon: ReactNode; color: string; data: RecordValue | null }[] = [
    { label: 'רצף רווחים ארוך ביותר', icon: <Flame size={14} />,        color: GREEN, data: { value: String(maxWinStreak) } },
    { label: 'רצף הפסדים ארוך ביותר', icon: <Zap size={14} />,          color: RED,   data: { value: String(maxLossStreak) } },
    { label: 'עסקה טובה ביותר',       icon: <Trophy size={14} />,       color: GREEN, data: bestTrade },
    { label: 'עסקה גרועה ביותר',      icon: <TrendingDown size={14} />, color: RED,   data: worstTrade },
    { label: 'יום טוב ביותר',          icon: <CalendarCheck size={14} />, color: GREEN, data: bestDay },
    { label: 'יום גרוע ביותר',         icon: <CalendarX size={14} />,     color: RED,   data: worstDay },
  ];

  return (
    <Section title="רצפים ושיאים" icon={<Trophy size={18} />}>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {records.map((r) => (
          <div key={r.label} className="stats-card p-4 flex flex-col gap-1">
            <p className="flex items-center gap-1.5" style={{ fontSize: 11, fontWeight: 600, color: MUTED }}>
              <span className="flex items-center" style={{ color: r.data ? r.color : MUTED }}>{r.icon}</span>
              {r.label}
            </p>
            <p className="stats-num" style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2, color: r.data ? r.color : MUTED }}>
              {r.data ? r.data.value : '—'}
            </p>
            {r.data?.sub && <p className="truncate" style={{ fontSize: 11, color: MUTED }}>{r.data.sub}</p>}
          </div>
        ))}
      </div>
    </Section>
  );
}

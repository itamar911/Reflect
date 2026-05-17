interface StreakTrackerProps {
  disciplineStreak: number;
  noRevengeStreak: number;
  stopLossStreak: number;
  fullDisciplineStreak: number;
}

interface StreakItem {
  icon: string;
  label: string;
  current: number;
  color: string;
}

export default function StreakTracker({
  disciplineStreak,
  noRevengeStreak,
  stopLossStreak,
  fullDisciplineStreak,
}: StreakTrackerProps) {
  const streaks: StreakItem[] = [
    { icon: '🎯', label: 'לפי החוקים',  current: disciplineStreak,     color: '#F5C518' },
    { icon: '🧘', label: 'ללא Revenge', current: noRevengeStreak,      color: '#00C853' },
    { icon: '🛡️', label: 'עם Stop Loss', current: stopLossStreak,       color: '#60A5FA' },
    { icon: '⭐', label: 'משמעת מלאה',  current: fullDisciplineStreak, color: '#A78BFA' },
  ];

  return (
    <div className="grid grid-cols-2 gap-2">
      {streaks.map((s, i) => (
        <div key={i}
          className="rounded-2xl p-3 flex flex-col gap-1"
          style={{
            background: 'var(--color-tg-surface)',
            border: s.current >= 3 ? `1px solid ${s.color}40` : '1px solid var(--color-tg-border)',
          }}>
          <div className="flex items-center justify-between">
            <span className="text-base">{s.icon}</span>
            {s.current >= 3 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                style={{ background: `${s.color}20`, color: s.color }}>
                🔥
              </span>
            )}
          </div>
          <p className="text-2xl font-bold" style={{ color: s.current > 0 ? s.color : 'var(--color-tg-muted)' }}>
            {s.current}
          </p>
          <p className="text-[11px] text-tg-text-2 leading-tight">{s.label}</p>
          {s.current === 0 && <p className="text-[10px] text-tg-muted">התחל היום</p>}
        </div>
      ))}
    </div>
  );
}

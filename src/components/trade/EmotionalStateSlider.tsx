'use client';

const STATES = [
  { value: 1, emoji: '😰', label: 'מתוח מאוד', color: 'var(--color-tg-danger)' },
  { value: 2, emoji: '😟', label: 'לא בטוב', color: 'var(--color-tg-warning)' },
  { value: 3, emoji: '😐', label: 'ניטרלי', color: '#64748b' },
  { value: 4, emoji: '🙂', label: 'טוב', color: 'var(--color-tg-success)' },
  { value: 5, emoji: '😎', label: 'מצוין', color: 'var(--color-tg-primary)' },
];

interface EmotionalStateSliderProps {
  value: number;
  onChange: (v: number) => void;
}

export default function EmotionalStateSlider({ value, onChange }: EmotionalStateSliderProps) {
  const current = STATES[value - 1];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-tg-text-2">מצב רגשי</span>
        <div className="flex items-center gap-1.5">
          <span className="text-lg">{current.emoji}</span>
          <span className="text-xs font-medium" style={{ color: current.color }}>
            {current.label}
          </span>
        </div>
      </div>

      <div className="flex gap-2">
        {STATES.map((s) => (
          <button
            key={s.value}
            onClick={() => onChange(s.value)}
            className="flex-1 flex flex-col items-center gap-1.5 py-2 rounded-xl border transition-all duration-150"
            style={{
              background: value === s.value ? `${current.color}20` : 'var(--color-tg-surface-2)',
              borderColor: value === s.value ? current.color : 'var(--color-tg-border)',
              transform: value === s.value ? 'scale(1.05)' : 'scale(1)',
            }}
            title={s.label}
          >
            <span className="text-xl">{s.emoji}</span>
            <span className="text-xs font-bold" style={{ color: value === s.value ? current.color : 'var(--color-tg-muted)' }}>
              {s.value}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

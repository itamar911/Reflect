'use client';

const STATES = [
  { value: 1, color: '#ef4444', label: 'מתוח מאוד' },
  { value: 2, color: '#f97316', label: 'לא בטוב' },
  { value: 3, color: '#eab308', label: 'ניטרלי' },
  { value: 4, color: '#84cc16', label: 'טוב' },
  { value: 5, color: '#22c55e', label: 'מצוין' },
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
          <span className="w-3 h-3 rounded-full inline-block shrink-0" style={{ background: current.color }} />
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
              background: value === s.value ? `${s.color}20` : 'var(--color-tg-surface-2)',
              borderColor: value === s.value ? s.color : 'var(--color-tg-border)',
              transform: value === s.value ? 'scale(1.05)' : 'scale(1)',
            }}
            title={s.label}
          >
            <span className="w-5 h-5 rounded-full inline-block" style={{ background: s.color }} />
            <span className="text-xs font-bold" style={{ color: value === s.value ? s.color : 'var(--color-tg-muted)' }}>
              {s.value}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

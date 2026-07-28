import { Check } from 'lucide-react';
import { MockFrame } from './MockFrame';

const CHIPS = ['NQ1', 'Long', '5m'];

const ROWS = [
  { text: 'סטופ מוגדר', delay: '0s' },
  { text: 'מתאים לאסטרטגיה', delay: '0.5s' },
  { text: 'יחס סיכוי/סיכון תקין', delay: '1s' },
];

export function PlanCheckMock() {
  return (
    <MockFrame className="items-center justify-center">
      <div dir="rtl" className="flex flex-col gap-4 w-full">
        {/* Context header — what's being checked, echoing HeroMock's chip row */}
        <div className="flex items-center gap-1.5" aria-hidden>
          {CHIPS.map((chip) => (
            <span
              key={chip}
              className="rounded-md px-2 py-1 text-[11px] font-semibold"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.55)' }}
            >
              {chip}
            </span>
          ))}
        </div>

        {ROWS.map((row) => (
          <div key={row.text} className="plan-check-row flex items-center gap-2.5" style={{ animationDelay: row.delay }}>
            <Check size={16} className="shrink-0" style={{ color: '#22c55e' }} />
            <span className="text-white/85" style={{ fontSize: 14.5 }}>{row.text}</span>
          </div>
        ))}
        <span
          className="plan-check-row self-start mt-1 rounded-full px-3 py-1 text-xs font-bold"
          style={{
            animationDelay: '1.5s',
            background: 'rgba(34,197,94,0.14)',
            border: '1px solid rgba(34,197,94,0.4)',
            color: '#22c55e',
          }}
        >
          מוכן לביצוע
        </span>
      </div>
    </MockFrame>
  );
}

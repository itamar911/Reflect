import { Bot } from 'lucide-react';
import { MockFrame } from './MockFrame';

export function CoachMock() {
  return (
    <MockFrame>
      <div dir="rtl" className="flex flex-col h-full justify-center gap-5">
        {/* Header — names the feature, same avatar-chip pattern as DebriefMock */}
        <div className="flex items-center gap-2.5">
          <span
            className="flex items-center justify-center w-7 h-7 rounded-full shrink-0"
            style={{ background: 'rgba(0,210,210,0.14)', border: '1px solid rgba(0,210,210,0.35)' }}
            aria-hidden
          >
            <Bot size={13} style={{ color: '#00d2d2' }} />
          </span>
          <span className="text-sm font-bold text-white">מאמן AI</span>
        </div>

        {/* User question — right-aligned, muted */}
        <div className="flex justify-start">
          <div
            className="max-w-[75%] px-3.5 py-2.5"
            style={{
              background: 'var(--color-tg-surface-2)',
              color: 'var(--color-tg-text-2)',
              borderRadius: '18px 18px 4px 18px',
            }}
          >
            <span style={{ fontSize: 13.5 }}>למה אני מפר את הסטופ שלי?</span>
          </div>
        </div>

        {/* AI response — left-aligned, turquoise-tinted border. Typing dots and the
            resolved message are stacked in the same grid cell so the crossfade cycle
            (see .coach-typing / .coach-message in landing.css — ~1.5s typing, ~4s
            holding the full reply) never shifts layout. */}
        <div className="flex items-end justify-end gap-2">
          <div className="grid max-w-[230px]">
            <div
              className="coach-message px-3.5 py-2.5"
              style={{
                gridArea: '1 / 1',
                background: 'rgba(0,210,210,0.06)',
                border: '1px solid rgba(0,210,210,0.35)',
                borderRadius: '18px 18px 18px 4px',
              }}
            >
              <p style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.85)', lineHeight: 1.6, margin: 0 }}>
                שמתי לב שזה קורה בעיקר אחרי הפסד. נסה להוסיף המתנה של 10 דקות לפני העסקה הבאה.
              </p>
            </div>
            <div
              className="coach-typing flex items-center gap-1 px-3.5 py-3"
              style={{
                gridArea: '1 / 1',
                background: 'rgba(0,210,210,0.06)',
                border: '1px solid rgba(0,210,210,0.35)',
                borderRadius: '18px 18px 18px 4px',
              }}
            >
              {[0, 1, 2].map((j) => (
                <span
                  key={j}
                  className="w-1.5 h-1.5 rounded-full animate-bounce"
                  style={{ background: '#00d2d2', animationDelay: `${j * 0.15}s` }}
                />
              ))}
            </div>
          </div>
          <span
            className="flex items-center justify-center w-6 h-6 rounded-full shrink-0"
            style={{ background: 'rgba(0,210,210,0.14)', border: '1px solid rgba(0,210,210,0.35)' }}
            aria-hidden
          >
            <Bot size={12} style={{ color: '#00d2d2' }} />
          </span>
        </div>
      </div>
    </MockFrame>
  );
}

import { Sparkles, Check, AlertTriangle } from 'lucide-react';
import { MockFrame } from './MockFrame';

export function DebriefMock() {
  return (
    <MockFrame>
      <div dir="rtl" className="flex flex-col h-full gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className="flex items-center justify-center w-7 h-7 rounded-full shrink-0"
            style={{ background: 'rgba(0,210,210,0.14)', border: '1px solid rgba(0,210,210,0.35)' }}
            aria-hidden
          >
            <Sparkles size={13} style={{ color: '#00d2d2' }} />
          </span>
          <span className="text-sm font-bold text-white">תחקיר עסקה</span>
        </div>

        <div className="flex flex-col gap-2.5 flex-1 justify-center">
          <div className="debrief-line flex items-center gap-2" style={{ animationDelay: '0s' }}>
            <Check size={15} className="shrink-0" style={{ color: '#22c55e' }} />
            <span style={{ fontSize: 14, color: '#86efac' }}>הכניסה הייתה לפי התוכנית</span>
          </div>
          <div className="debrief-line flex items-center gap-2" style={{ animationDelay: '0.8s' }}>
            <AlertTriangle size={15} className="shrink-0" style={{ color: '#f59e0b' }} />
            <span style={{ fontSize: 14, color: '#fbbf24' }}>הסטופ הוזז פעמיים</span>
          </div>
        </div>

        <span
          className="debrief-line self-start rounded-full px-3 py-1 text-xs font-bold"
          style={{
            animationDelay: '1.6s',
            background: 'rgba(0,210,210,0.12)',
            border: '1px solid rgba(0,210,210,0.35)',
            color: '#00d2d2',
          }}
        >
          82/100
        </span>
      </div>
    </MockFrame>
  );
}

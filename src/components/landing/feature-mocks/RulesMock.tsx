import { Lock, Shield } from 'lucide-react';
import { MockFrame } from './MockFrame';

export function RulesMock() {
  return (
    <MockFrame>
      <div dir="rtl" className="flex flex-col h-full gap-2.5">
        <div className="flex items-center gap-1.5">
          <Shield size={12} className="shrink-0" style={{ color: 'rgba(255,255,255,0.45)' }} />
          <span style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.45)' }}>3 חוקים פעילים</span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-white">חוק פעיל</span>
          <span
            className="flex items-center w-9 h-5 rounded-full p-0.5"
            style={{ background: '#00d2d2', justifyContent: 'flex-end' }}
            aria-hidden
          >
            <span className="w-4 h-4 rounded-full bg-white shrink-0" />
          </span>
        </div>

        <div
          className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <span className="text-white/80" style={{ fontSize: 14 }}>מקסימום 2 הפסדים ביום</span>
          <span className="flex items-center gap-1 shrink-0" aria-hidden>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#00d2d2' }} />
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#00d2d2' }} />
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.2)' }} />
          </span>
        </div>

        <div
          className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <span className="text-white/80" style={{ fontSize: 14 }}>לא לפתוח עסקה 5 דקות מפתיחת המסחר</span>
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'rgba(255,255,255,0.2)' }} aria-hidden />
        </div>

        <div className="mt-auto flex flex-col items-center gap-2">
          <button
            type="button"
            disabled
            className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold cursor-not-allowed"
            style={{
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.4)',
              color: 'rgba(255,255,255,0.5)',
              boxShadow: '0 0 18px rgba(245,158,11,0.12)',
            }}
          >
            <span className="relative w-4 h-4 flex items-center justify-center shrink-0">
              <span className="mock-lock-halo" aria-hidden />
              <Lock size={14} style={{ color: '#f59e0b', position: 'relative' }} />
            </span>
            פתח עסקה
          </button>
          <span style={{ fontSize: 12, color: '#f59e0b' }}>חסום — הגעת למגבלה</span>
        </div>
      </div>
    </MockFrame>
  );
}

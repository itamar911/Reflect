import type { RulesetValidationResult } from '@/lib/types';
import { X, AlertTriangle } from 'lucide-react';

interface ValidationResultBannerProps {
  result: RulesetValidationResult;
}

export default function ValidationResultBanner({ result }: ValidationResultBannerProps) {
  if (result.status === 'valid') {
    return (
      <div className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm animate-fade-in"
        style={{ background: 'var(--color-tg-success-muted)', color: 'var(--color-tg-success)', border: '1px solid rgba(16,185,129,0.3)' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span className="font-medium">התוכנית עוברת את כל הבדיקות</span>
      </div>
    );
  }

  const isBlocked = result.status === 'blocked';
  const color = isBlocked ? 'var(--color-tg-danger)' : 'var(--color-tg-warning)';
  const bg = isBlocked ? 'var(--color-tg-danger-muted)' : 'var(--color-tg-warning-muted)';
  const border = isBlocked ? 'rgba(244,63,94,0.3)' : 'rgba(0,210,210,0.3)';

  return (
    <div className="flex flex-col gap-2 px-4 py-3 rounded-xl text-sm animate-fade-in"
      style={{ background: bg, border: `1px solid ${border}` }}>
      <div className="flex items-center gap-2 font-medium" style={{ color }}>
        {isBlocked ? (
          <>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
            עסקה חסומה — לא ניתן להגיש
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            אזהרה — ניתן להגיש בכל זאת
          </>
        )}
      </div>

      {result.blockedReasons.map((r, i) => (
        <div key={i} className="flex items-start gap-2 text-xs" style={{ color }}>
          <X size={10} className="shrink-0 mt-0.5" />
          <span>{r}</span>
        </div>
      ))}
      {result.warningReasons.map((r, i) => (
        <div key={i} className="flex items-start gap-2 text-xs" style={{ color: 'var(--color-tg-warning)' }}>
          <AlertTriangle size={10} className="shrink-0 mt-0.5" />
          <span>{r}</span>
        </div>
      ))}
    </div>
  );
}

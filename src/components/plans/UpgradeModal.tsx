'use client';

import Link from 'next/link';
import { Lock } from 'lucide-react';

export type UpgradeLimitType =
  | 'trades_per_week'
  | 'custom_rules'
  | 'strategies'
  | 'blocking_conditions'
  | 'ai_coach'
  | 'weekly_summary';

interface UpgradeModalProps {
  open: boolean;
  onClose: () => void;
  limitType: UpgradeLimitType;
}

const COPY: Record<UpgradeLimitType, { title: string; body: string }> = {
  trades_per_week: {
    title: 'הגעת למכסת העסקאות השבועית',
    body: 'במסלול Basic ניתן לתכנן עד 5 עסקאות בשבוע — המכסה מתאפסת כל יום שני. ב-Pro אין הגבלה על מספר העסקאות.',
  },
  custom_rules: {
    title: 'הגעת למכסת החוקים האישיים',
    body: 'במסלול Basic ניתן ליצור עד 3 חוקים אישיים. ב-Pro ניתן ליצור חוקים ללא הגבלה.',
  },
  strategies: {
    title: 'הגעת למכסת האסטרטגיות',
    body: 'במסלול Basic ניתן לשמור עד 3 אסטרטגיות אישיות. ב-Pro ניתן לשמור אסטרטגיות ללא הגבלה.',
  },
  blocking_conditions: {
    title: 'הגעת למכסת תנאי החסימה',
    body: 'במסלול Basic ניתן לבחור עד 3 מתוך 8 תנאי חסימה. ב-Pro ניתן להשתמש בכל 8 התנאים.',
  },
  ai_coach: {
    title: 'יועץ ה-AI זמין ב-Pro בלבד',
    body: 'מאמן אישי שמכיר את דפוסי המסחר שלך ועונה על כל שאלה בזמן אמת — זמין במסלול Pro.',
  },
  weekly_summary: {
    title: 'סיכום שבועי AI זמין ב-Pro בלבד',
    body: 'קבל כל שבוע ניתוח AI מלא עם תובנות מספריות והשוואה לשבועות קודמים — זמין במסלול Pro.',
  },
};

export default function UpgradeModal({ open, onClose, limitType }: UpgradeModalProps) {
  if (!open) return null;
  const { title, body } = COPY[limitType];

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm mx-auto rounded-2xl p-6 flex flex-col items-center gap-3 text-center animate-fade-in"
        style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)', boxShadow: '0 24px 64px rgba(0,0,0,0.8)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(0,210,210,0.12)' }}
        >
          <Lock size={26} style={{ color: '#00d2d2' }} />
        </div>

        <p className="text-base font-bold" style={{ color: 'var(--color-tg-text)' }}>
          {title}
        </p>

        <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text-2)' }}>
          {body}
        </p>

        <div className="flex flex-col gap-2 w-full mt-2">
          <Link
            href="/settings#pricing"
            onClick={onClose}
            className="shimmer-btn w-full py-2.5 rounded-xl text-sm font-semibold text-black transition-all duration-150 active:scale-95 text-center"
          >
            שדרוג ל-Pro
          </Link>
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl text-sm font-semibold"
            style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text-2)' }}
          >
            אולי מאוחר יותר
          </button>
        </div>
      </div>
    </div>
  );
}

'use client';

import { Ban } from 'lucide-react';
import { formatCooldownMinutes } from '@/lib/validators/RulesetValidator';

interface RuleBlockedModalProps {
  ruleName: string;
  description: string;
  cooldownMinutes?: number | null;
  onClose: () => void;
}

export default function RuleBlockedModal({ ruleName, description, cooldownMinutes, onClose }: RuleBlockedModalProps) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
    >
      <div
        className="w-full max-w-sm mx-auto rounded-2xl p-6 flex flex-col items-center gap-3 text-center"
        style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)', boxShadow: '0 24px 64px rgba(0,0,0,0.8)' }}
      >
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center"
          style={{ background: 'var(--color-tg-danger-muted)' }}
        >
          <Ban size={28} style={{ color: 'var(--color-tg-danger)' }} />
        </div>

        <p className="text-base font-bold" style={{ color: 'var(--color-tg-text)' }}>
          לא ניתן לפתוח עסקה
        </p>

        <p className="text-sm font-semibold" style={{ color: 'var(--color-tg-danger)' }}>
          {ruleName}
        </p>

        <p className="text-xs text-tg-text-2">
          {description}
        </p>

        {cooldownMinutes ? (
          <p className="text-xs text-tg-muted">
            נעילה למשך {formatCooldownMinutes(cooldownMinutes)}
          </p>
        ) : (
          <p className="text-xs text-tg-muted">
            החוק שלך מונע כניסה לעסקה חדשה כרגע
          </p>
        )}

        <button
          onClick={onClose}
          className="w-full py-2.5 rounded-xl text-sm font-semibold mt-2"
          style={{
            background: 'var(--color-tg-primary-muted)',
            color: 'var(--color-tg-primary)',
            border: '1px solid rgba(0,210,210,0.3)',
          }}
        >
          סגור
        </button>
      </div>
    </div>
  );
}

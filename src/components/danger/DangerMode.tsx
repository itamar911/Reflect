'use client';

import { useState } from 'react';

interface DangerModeProps {
  consecutiveLosses: number;
  emotionalState: number;
  dailyLossExceeded: boolean;
  maxDailyLoss: number | null;
  currentLoss: number;
}

export default function DangerMode({
  consecutiveLosses,
  emotionalState,
  dailyLossExceeded,
  maxDailyLoss,
  currentLoss,
}: DangerModeProps) {
  const [dismissed, setDismissed] = useState(false);

  const reasons: string[] = [];
  if (consecutiveLosses >= 2) reasons.push(`${consecutiveLosses} הפסדים רצופים`);
  if (emotionalState <= 2) reasons.push('מצב רגשי נמוך');
  if (dailyLossExceeded) reasons.push(`חריגת הפסד יומי (${currentLoss.toFixed(0)})`);

  if (reasons.length === 0 || dismissed) return null;

  return (
    <div className="animate-fade-in rounded-2xl p-4 border animate-pulse-danger"
      style={{
        background: 'linear-gradient(135deg, #FF3B3018 0%, #FF3B3008 100%)',
        borderColor: '#FF3B3060',
      }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
            style={{ background: '#FF3B3030' }}>
            <span className="text-sm">🚨</span>
          </div>
          <div>
            <p className="text-sm font-bold" style={{ color: '#FF3B30' }}>מצב סיכון — Danger Mode</p>
            <p className="text-xs text-tg-text-2 mt-0.5 leading-relaxed">
              {reasons.join(' • ')}
            </p>
            <p className="text-xs mt-2 font-medium" style={{ color: '#FF3B30' }}>
              שקול הפסקה לפני העסקה הבאה
            </p>
          </div>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-tg-muted hover:text-tg-text transition-colors shrink-0 p-1">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

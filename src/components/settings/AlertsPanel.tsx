'use client';

import { useState } from 'react';

type Plan = 'free' | 'basic' | 'pro';

interface AlertConfig {
  id: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  hasTime: boolean;
  defaultTime?: string;
  proOnly?: boolean;
}

const ALERTS: AlertConfig[] = [
  {
    id: 'pre_market',
    label: 'תזכורת לפני פתיחת השוק',
    description: 'תשלח אם לא הזנת אסטרטגיה להיום',
    defaultEnabled: true,
    hasTime: true,
    defaultTime: '08:30',
  },
  {
    id: 'end_of_day',
    label: 'תזכורת סוף יום',
    description: 'תשלח אם יש עסקה שלא תוחקרה',
    defaultEnabled: true,
    hasTime: true,
    defaultTime: '21:00',
  },
  {
    id: 'discipline',
    label: 'התראת משמעת',
    description: 'תופעל כשחורגים ממגבלה שהוגדרה בחוקים',
    defaultEnabled: true,
    hasTime: false,
  },
  {
    id: 'weekly_summary',
    label: 'סיכום שבועי AI',
    description: 'נשלח כל יום ראשון בבוקר עם ניתוח השבוע',
    defaultEnabled: true,
    hasTime: true,
    defaultTime: '09:00',
  },
  {
    id: 'realtime_pattern',
    label: 'התראת דפוס בזמן אמת',
    description: 'מזהה דפוס כושל לפני כניסה לעסקה',
    defaultEnabled: false,
    hasTime: false,
    proOnly: true,
  },
];

export default function AlertsPanel({ plan }: { plan: Plan }) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(
    Object.fromEntries(ALERTS.map((a) => [a.id, a.defaultEnabled && !(a.proOnly && plan !== 'pro')]))
  );
  const [times, setTimes] = useState<Record<string, string>>(
    Object.fromEntries(ALERTS.filter((a) => a.hasTime && a.defaultTime).map((a) => [a.id, a.defaultTime!]))
  );

  const canCustomize = plan !== 'free';

  return (
    <div className="flex flex-col gap-0">
      {ALERTS.map((alert, i) => {
        const isLocked = alert.proOnly && plan !== 'pro';
        const isDisabled = !canCustomize || isLocked;

        return (
          <div
            key={alert.id}
            className={`flex items-start justify-between gap-3 py-4 ${i < ALERTS.length - 1 ? 'border-b border-tg-border' : ''}`}
            style={{ opacity: isLocked ? 0.55 : 1 }}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium text-tg-text">{alert.label}</p>
                {alert.proOnly && (
                  <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold"
                    style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>
                    Pro
                  </span>
                )}
                {!canCustomize && !alert.proOnly && (
                  <span className="px-1.5 py-0.5 rounded-md text-[10px]"
                    style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-muted)' }}>
                    Basic+
                  </span>
                )}
              </div>
              <p className="text-xs text-tg-text-2 mt-0.5">{alert.description}</p>
              {alert.hasTime && canCustomize && !isLocked && enabled[alert.id] && (
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-xs text-tg-muted">שעת שליחה:</span>
                  <input
                    type="time"
                    value={times[alert.id] ?? '09:00'}
                    onChange={(e) => setTimes({ ...times, [alert.id]: e.target.value })}
                    className="h-7 px-2 rounded-lg text-xs text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary"
                    style={{ background: 'var(--color-tg-surface-2)' }}
                  />
                </div>
              )}
            </div>

            <button
              onClick={() => !isDisabled && setEnabled({ ...enabled, [alert.id]: !enabled[alert.id] })}
              className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 mt-0.5"
              style={{
                background: enabled[alert.id] && !isLocked ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                cursor: isDisabled ? 'default' : 'pointer',
              }}
              aria-label={`Toggle ${alert.label}`}
            >
              <span
                className="inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm"
                style={{ transform: enabled[alert.id] && !isLocked ? 'translateX(-18px)' : 'translateX(-2px)' }}
              />
            </button>
          </div>
        );
      })}

      {!canCustomize && (
        <p className="text-xs text-tg-muted mt-3 text-center">
          התאמת שעות שליחה זמינה ב-Basic ומעלה
        </p>
      )}
    </div>
  );
}

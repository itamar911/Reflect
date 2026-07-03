'use client';

import { useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { PlanTier } from '@/lib/plans/config';

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
  { id: 'pre_market', label: 'תזכורת לפני פתיחת השוק', description: 'תשלח אם לא הזנת אסטרטגיה להיום', defaultEnabled: true, hasTime: true, defaultTime: '08:30' },
  { id: 'end_of_day', label: 'תזכורת סוף יום', description: 'תשלח אם יש עסקה שלא תוחקרה', defaultEnabled: true, hasTime: true, defaultTime: '21:00' },
  { id: 'discipline', label: 'התראת משמעת', description: 'תופעל כשחורגים ממגבלה שהוגדרה בחוקים', defaultEnabled: true, hasTime: false },
  { id: 'weekly_summary', label: 'סיכום שבועי AI', description: 'נשלח כל יום ראשון בבוקר עם ניתוח השבוע', defaultEnabled: true, hasTime: true, defaultTime: '09:00' },
  { id: 'realtime_pattern', label: 'התראת דפוס בזמן אמת', description: 'מזהה דפוס כושל לפני כניסה לעסקה', defaultEnabled: false, hasTime: false, proOnly: true },
];

export interface AlertSettingsData {
  pre_market_enabled: boolean;
  pre_market_time: string;
  end_of_day_enabled: boolean;
  end_of_day_time: string;
  discipline_enabled: boolean;
  weekly_summary_enabled: boolean;
  weekly_summary_time: string;
  realtime_pattern_enabled: boolean;
}

interface AlertsPanelProps {
  plan: PlanTier;
  userId: string;
  initialSettings?: AlertSettingsData | null;
}

export default function AlertsPanel({ plan, userId, initialSettings }: AlertsPanelProps) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    pre_market: initialSettings?.pre_market_enabled ?? true,
    end_of_day: initialSettings?.end_of_day_enabled ?? true,
    discipline: initialSettings?.discipline_enabled ?? true,
    weekly_summary: initialSettings?.weekly_summary_enabled ?? true,
    realtime_pattern: initialSettings?.realtime_pattern_enabled ?? false,
  });
  const [times, setTimes] = useState<Record<string, string>>({
    pre_market: initialSettings?.pre_market_time ?? '08:30',
    end_of_day: initialSettings?.end_of_day_time ?? '21:00',
    weekly_summary: initialSettings?.weekly_summary_time ?? '09:00',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');

  const canCustomize = plan !== 'free';

  const save = useCallback(async (newEnabled: Record<string, boolean>, newTimes: Record<string, string>) => {
    if (!canCustomize) return;
    setSaving(true);
    setSaveError('');

    const payload = {
      pre_market_enabled: newEnabled.pre_market,
      pre_market_time: newTimes.pre_market ?? '08:30',
      end_of_day_enabled: newEnabled.end_of_day,
      end_of_day_time: newTimes.end_of_day ?? '21:00',
      discipline_enabled: newEnabled.discipline,
      weekly_summary_enabled: newEnabled.weekly_summary,
      weekly_summary_time: newTimes.weekly_summary ?? '09:00',
      realtime_pattern_enabled: newEnabled.realtime_pattern,
    };

    const supabase = createClient();
    const { data: existing } = await supabase
      .from('alert_settings')
      .select('id')
      .eq('user_id', userId)
      .single();

    const { error } = existing
      ? await supabase.from('alert_settings').update(payload).eq('user_id', userId)
      : await supabase.from('alert_settings').insert({ user_id: userId, ...payload });

    setSaving(false);
    if (error) {
      setSaveError(error.message);
    } else {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }, [canCustomize, userId]);

  function toggleAlert(id: string) {
    const isLocked = ALERTS.find((a) => a.id === id)?.proOnly && plan !== 'pro';
    if (!canCustomize || isLocked) return;
    const newEnabled = { ...enabled, [id]: !enabled[id] };
    setEnabled(newEnabled);
    save(newEnabled, times);
  }

  function updateTime(id: string, value: string) {
    const newTimes = { ...times, [id]: value };
    setTimes(newTimes);
    save(enabled, newTimes);
  }

  return (
    <div className="flex flex-col gap-0">
      {ALERTS.map((alert, i) => {
        const isLocked = alert.proOnly && plan !== 'pro';
        const isDisabled = !canCustomize || isLocked;

        return (
          <div key={alert.id}
            className={`flex items-start justify-between gap-3 py-4 ${i < ALERTS.length - 1 ? 'border-b border-tg-border' : ''}`}
            style={{ opacity: isLocked ? 0.55 : 1 }}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium text-tg-text">{alert.label}</p>
                {alert.proOnly && (
                  <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold"
                    style={{ background: 'rgba(0,210,210,0.12)', color: '#00d2d2' }}>Pro</span>
                )}
                {!canCustomize && !alert.proOnly && (
                  <span className="px-1.5 py-0.5 rounded-md text-[10px]"
                    style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-muted)' }}>Basic+</span>
                )}
              </div>
              <p className="text-xs text-tg-text-2 mt-0.5">{alert.description}</p>
              {alert.hasTime && canCustomize && !isLocked && enabled[alert.id] && (
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-xs text-tg-muted">שעת שליחה:</span>
                  <input
                    type="time"
                    value={times[alert.id] ?? '09:00'}
                    onChange={(e) => updateTime(alert.id, e.target.value)}
                    className="h-7 px-2 rounded-lg text-xs text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary"
                    style={{ background: 'var(--color-tg-surface-2)' }}
                  />
                </div>
              )}
            </div>

            <button
              onClick={() => toggleAlert(alert.id)}
              className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 mt-0.5"
              style={{
                background: enabled[alert.id] && !isLocked ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                cursor: isDisabled ? 'default' : 'pointer',
              }}>
              <span
                className="inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm"
                style={{ transform: enabled[alert.id] && !isLocked ? 'translateX(-18px)' : 'translateX(-2px)' }}
              />
            </button>
          </div>
        );
      })}

      {canCustomize && (
        <p className="text-xs text-tg-muted mt-3 text-center">⏰ שעות לפי שעון ישראל (UTC+2)</p>
      )}
      {!canCustomize && (
        <p className="text-xs text-tg-muted mt-3 text-center">התאמת שעות שליחה זמינה ב-Basic ומעלה</p>
      )}

      {saving && <p className="text-xs text-tg-muted text-center mt-2">שומר...</p>}
      {saved && <p className="text-xs text-tg-success text-center mt-2 animate-fade-in">הגדרות נשמרו</p>}
      {saveError && <p className="text-xs text-tg-danger text-center mt-2">{saveError}</p>}
    </div>
  );
}

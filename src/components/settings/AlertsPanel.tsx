'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface AlertConfig {
  id: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  hasTime: boolean;
  defaultTime?: string;
}

const ALERTS: AlertConfig[] = [
  { id: 'pre_market', label: 'תזכורת לפני פתיחת השוק', description: 'תשלח אם לא הזנת אסטרטגיה להיום', defaultEnabled: true, hasTime: true, defaultTime: '08:30' },
  { id: 'end_of_day', label: 'תזכורת סוף יום', description: 'תשלח אם יש עסקה שלא תוחקרה', defaultEnabled: true, hasTime: true, defaultTime: '21:00' },
  { id: 'discipline', label: 'התראת משמעת', description: 'תופעל כשחורגים ממגבלה שהוגדרה בחוקים', defaultEnabled: true, hasTime: false },
  { id: 'weekly_summary', label: 'סיכום שבועי AI', description: 'נשלח כל יום ראשון בבוקר עם ניתוח השבוע', defaultEnabled: true, hasTime: true, defaultTime: '09:00' },
  { id: 'realtime_pattern', label: 'התראת דפוס בזמן אמת', description: 'מזהה דפוס כושל לפני כניסה לעסקה', defaultEnabled: false, hasTime: false },
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
  userId: string;
  initialSettings?: AlertSettingsData | null;
}

export default function AlertsPanel({ userId, initialSettings }: AlertsPanelProps) {
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
  const router = useRouter();

  /**
   * Persist the whole settings row.
   *
   * `refreshShell` is not an optimisation, it is the fix for REF-91. One of
   * these toggles is read on the server: src/app/(app)/layout.tsx selects
   * alert_settings.discipline_enabled and passes it to AppShell as
   * disciplineAlertsEnabled, which decides whether opening the trade form
   * checks for rule violations. Writing the column without telling the server
   * to re-read it left the shell acting on the value it was rendered with:
   * discipline alerts switched off, the toggle showing off, and rule blocking
   * still firing until the next full page load. The toggle told the truth
   * about itself and only the behaviour disagreed, so the user had no way to
   * see it.
   *
   * True for every toggle rather than only for `discipline`: any flag here
   * could become one the layout reads, and a refresh that was not needed
   * costs one re-render of server components while a missing one is this bug
   * again. False for a time change, which nothing server-rendered depends on
   * and which fires on each component of the time input.
   */
  const save = useCallback(async (
    newEnabled: Record<string, boolean>,
    newTimes: Record<string, string>,
    refreshShell: boolean,
  ) => {
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
    const { error } = await supabase
      .from('alert_settings')
      .upsert({ user_id: userId, ...payload }, { onConflict: 'user_id' });

    setSaving(false);
    if (error) {
      setSaveError(error.message);
    } else {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      // Re-runs this route's server components, so the (app) layout re-reads
      // discipline_enabled and AppShell is handed the new value. The same
      // convention JournalClient and SetupsClient follow after a write.
      // Client state is preserved across a refresh, so the toggles do not
      // flicker back to their initial props.
      if (refreshShell) router.refresh();
    }
  }, [router, userId]);

  function toggleAlert(id: string) {
    const newEnabled = { ...enabled, [id]: !enabled[id] };
    setEnabled(newEnabled);
    save(newEnabled, times, true);
  }

  function updateTime(id: string, value: string) {
    const newTimes = { ...times, [id]: value };
    setTimes(newTimes);
    save(enabled, newTimes, false);
  }

  return (
    <div className="flex flex-col gap-0">
      {ALERTS.map((alert, i) => {
        return (
          <div key={alert.id}
            className={`flex items-start justify-between gap-3 py-4 ${i < ALERTS.length - 1 ? 'border-b border-tg-border' : ''}`}
            >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium text-tg-text">{alert.label}</p>
              </div>
              <p className="text-xs text-tg-text-2 mt-0.5">{alert.description}</p>
              {alert.hasTime && enabled[alert.id] && (
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
                background: enabled[alert.id] ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                cursor: 'pointer',
              }}>
              <span
                className="inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm"
                style={{ transform: enabled[alert.id] ? 'translateX(-18px)' : 'translateX(-2px)' }}
              />
            </button>
          </div>
        );
      })}

      <p className="text-xs text-tg-muted mt-3 text-center">⏰ שעות לפי שעון ישראל (UTC+2)</p>

      {saving && <p className="text-xs text-tg-muted text-center mt-2">שומר...</p>}
      {saved && <p className="text-xs text-tg-success text-center mt-2 animate-fade-in">הגדרות נשמרו</p>}
      {saveError && <p className="text-xs text-tg-danger text-center mt-2">{saveError}</p>}
    </div>
  );
}

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getUserPlan } from '@/lib/plans/getUserPlan';
import Card from '@/components/ui/Card';
import AlertsPanel from '@/components/settings/AlertsPanel';
import type { AlertSettingsData } from '@/components/settings/AlertsPanel';
import { Plug } from 'lucide-react';
import PricingPlans from '@/components/settings/PricingPlans';

export const metadata = { title: 'הגדרות — Reflect' };

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [profileRes, alertRes, { tier: plan }] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).single(),
    supabase.from('alert_settings').select('*').eq('user_id', user.id).single(),
    getUserPlan(supabase, user.id),
  ]);

  const profile = profileRes.data;
  const alertSettings = alertRes.data as AlertSettingsData | null;

  return (
    <div className="px-4 py-5 flex flex-col gap-5 md:max-w-none">
      <h1 className="text-xl font-bold text-tg-text">הגדרות</h1>

      {/* Profile section */}
      <Card>
        <h2 className="text-sm font-semibold text-tg-text mb-3">פרופיל</h2>
        <div className="flex flex-col gap-2">
          {([
            ['אימייל', user.email ?? '—', true],
            ['שם', profile?.display_name ?? '—', false],
            ['סגנון מסחר', tradingTypeLabel(profile?.trading_type), false],
            ['שוק עיקרי', marketLabel(profile?.default_market), false],
            ['רמת ניסיון', experienceLabel(profile?.experience_level), false],
          ] as const).map(([label, value, ltr]) => (
            <div key={label} className="flex justify-between items-center gap-3 py-1.5 border-b border-tg-border last:border-0">
              <span className="text-sm text-tg-text-2 shrink-0">{label}</span>
              {/* dir="ltr" keeps the ellipsis direction-safe for LTR values
                  (email) truncating inside the RTL row */}
              <span className="text-sm font-medium text-tg-text truncate min-w-0" dir={ltr ? 'ltr' : undefined}>
                {value}
              </span>
            </div>
          ))}
        </div>
      </Card>

      {/* Alerts */}
      <Card>
        <h2 className="text-sm font-semibold text-tg-text mb-4">התראות</h2>
        <AlertsPanel plan={plan} userId={user.id} initialSettings={alertSettings} />
      </Card>

      {/* Pricing */}
      <div id="pricing" className="scroll-mt-4">
        <PricingPlans plan={plan} />
      </div>

      {/* Integrations */}
      <div className="flex flex-col gap-3">
        <h2 className="text-base font-bold text-tg-text">אינטגרציות</h2>

        <Card className="opacity-75">
          <div className="flex items-start gap-3">
            <Plug size={20} style={{ color: '#00d2d2' }} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-bold text-tg-text">חיבור ברוקר בזמן אמת</h3>
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: 'rgba(0,210,210,0.12)', color: '#00d2d2' }}>
                  זמין בקרוב למנויי Pro
                </span>
              </div>
              <p className="text-xs text-tg-muted mt-1.5">
                העסקאות, הפוזיציות והביצועים שלך יסונכרנו באופן אוטומטי ישירות מהברוקר לאפליקציה.
              </p>
              <button
                disabled
                className="mt-3 w-full py-2.5 rounded-xl text-sm font-semibold cursor-not-allowed"
                style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-muted)' }}
              >
                חבר ברוקר
              </button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}


function tradingTypeLabel(v?: string[] | string | null) {
  const map: Record<string, string> = {
    scalping: 'Scalping', day: 'Day Trading', swing: 'Swing Trading', position: 'Position Trading', crypto: 'Crypto Trading',
  };
  const values = Array.isArray(v) ? v : v ? [v] : [];
  return values.length > 0 ? values.map((t) => map[t] ?? t).join(', ') : '—';
}
function marketLabel(v?: string[] | string | null) {
  const map: Record<string, string> = {
    stocks: 'מניות', crypto: 'קריפטו', forex: 'פורקס', options: 'אופציות',
    futures: 'חוזים עתידיים', etf: 'ETFs', commodities: 'סחורות',
  };
  const values = Array.isArray(v) ? v : v ? [v] : [];
  return values.length > 0 ? values.map((m) => map[m] ?? m).join(', ') : '—';
}
function experienceLabel(v?: string) {
  const map: Record<string, string> = { beginner: 'מתחיל', intermediate: 'בינוני', advanced: 'מתקדם' };
  return v ? (map[v] ?? v) : '—';
}

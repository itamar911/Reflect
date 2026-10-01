import { redirect } from 'next/navigation';
import { createClient, getCachedUser } from '@/lib/supabase/server';
import Card from '@/components/ui/Card';
import AlertsPanel from '@/components/settings/AlertsPanel';
import type { AlertSettingsData } from '@/components/settings/AlertsPanel';
import { Plug } from 'lucide-react';
import DeleteAccountSection from '@/components/settings/DeleteAccountSection';
import TradovateConnectionActions from '@/components/settings/TradovateConnectionActions';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { readConnectionSummary, type ConnectionStatus } from '@/lib/tradovate/connections';
// CONNECTION-READ DIAGNOSTICS — remove with lib/tradovate/connection-read-diagnostics.ts.
import {
  logConnectionRead,
  reportConnectionRead,
} from '@/lib/tradovate/connection-read-diagnostics';

export const metadata = { title: 'הגדרות — Reflect' };

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) redirect('/login');

  const [profileRes, alertRes] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).single(),
    supabase.from('alert_settings').select('*').eq('user_id', user.id).single(),
  ]);

  const profile = profileRes.data;
  const alertSettings = alertRes.data as AlertSettingsData | null;

  // Tradovate is closed to everyone but an allowlist until the production OAuth
  // test has passed. This only decides whether the button is live — the real
  // gate is in /api/tradovate/connect and /api/tradovate/callback, which check
  // the same list independently. A hidden button is still a URL.
  const canConnectTradovate = isUserAllowed(user.id);

  // Only read for an allowlisted user — nobody else can have a connection, and
  // this call uses the service-role client.
  //
  // A failure here must not take down a page whose other five sections do not
  // depend on it, but it must not be mistaken for an answer either. This used to
  // catch the throw into the same `null` that means "no connection", so an
  // unreadable connection and an absent one rendered identically and the log
  // line was the only difference. Now the three outcomes stay apart all the way
  // to the card: a read that failed says so, to the user and in the logs.
  let tradovateStatus: ConnectionStatus | null = null;
  let tradovateReadFailed = false;

  if (canConnectTradovate) {
    const read = await readConnectionSummary(user.id);

    if (read.outcome === 'error') {
      tradovateReadFailed = true;
      console.error(
        '[settings] could not read the Tradovate connection:',
        `code=${read.code ?? 'none'}`,
        JSON.stringify(read.message)
      );
    } else if (read.outcome === 'row') {
      tradovateStatus = read.summary.status;
    }

    // ========================================================================
    // CONNECTION-READ DIAGNOSTICS — DELETE THIS BLOCK WITH
    // lib/tradovate/connection-read-diagnostics.ts
    //
    // Answers why this read finds nothing for a row that exists. Costs one
    // extra, unfiltered SELECT of user_id per Settings render, for an
    // allowlisted user only. Ids and result shape only — no token column is
    // read by anything in that module.
    // ========================================================================
    logConnectionRead('settings', await reportConnectionRead(user.id));
    // ==================== END CONNECTION-READ DIAGNOSTICS ===================
  }

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
        <AlertsPanel userId={user.id} initialSettings={alertSettings} />
      </Card>

      {/* Integrations */}
      <div className="flex flex-col gap-3">
        <h2 className="text-base font-bold text-tg-text">אינטגרציות</h2>

        <Card className={canConnectTradovate ? undefined : 'opacity-75'}>
          <div className="flex items-start gap-3">
            <Plug aria-hidden="true" size={20} style={{ color: '#00d2d2' }} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-bold text-tg-text">חיבור לחשבון הברוקר</h3>
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: 'rgba(0,210,210,0.12)', color: '#00d2d2' }}>
                  {!canConnectTradovate
                    ? 'זמין בקרוב'
                    : tradovateReadFailed
                      ? 'מצב לא ידוע'
                      : tradovateStatus === 'active'
                        ? 'מחובר'
                        : 'בדיקה מוקדמת'}
                </span>
              </div>
              <p className="text-xs text-tg-muted mt-1.5">
                כשתפתח תוכנית עסקה, Reflect ימשוך מהברוקר את נתוני העסקאות שלך באותו רגע. אין סנכרון אוטומטי ברקע.
              </p>
              <TradovateConnectionActions
                canConnect={canConnectTradovate}
                hasConnection={tradovateStatus !== null}
                isActive={tradovateStatus === 'active'}
                readFailed={tradovateReadFailed}
              />
            </div>
          </div>
        </Card>
      </div>

      {/* Account deletion — last on the page, and separated by extra space so
          it is never the thing under a thumb reaching for the section above. */}
      <div className="mt-4">
        <DeleteAccountSection />
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

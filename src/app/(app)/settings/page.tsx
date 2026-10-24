import { redirect } from 'next/navigation';
import { createClient, getCachedUser } from '@/lib/supabase/server';
import Card from '@/components/ui/Card';
import AlertsPanel from '@/components/settings/AlertsPanel';
import type { AlertSettingsData } from '@/components/settings/AlertsPanel';
import DeleteAccountSection from '@/components/settings/DeleteAccountSection';
import TradovateConnectionCard from '@/components/settings/TradovateConnectionCard';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { readConnectionSummary, type ConnectionStatus } from '@/lib/tradovate/connections';
import { TRADOVATE_RESULT_PARAM, TradovateResult } from '@/lib/tradovate/oauth-results';

export const metadata = { title: 'הגדרות — Reflect' };

export default async function SettingsPage({ searchParams }: {
  /** A Promise on Next 16 — see the note in app/(app)/trades/page.tsx. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) redirect('/login');

  // REF-112 §5.17, item 5. THE FIRST READER `?tradovate=` HAS EVER HAD.
  // oauth-results.ts has said "the UI for this is not built yet; the codes
  // are stable" since it was written, and §2 of the investigation lists the
  // unread codes as a defect in their own right — a refusal nobody translates
  // is a refusal the trader cannot act on. This builds the reader for the one
  // code item 5 adds; the other six are REF-112 §2's to finish.
  //
  // ONE SHOT, BY CONSTRUCTION. It is a query parameter on the redirect the
  // callback issued, so it survives exactly as long as the trader stays on
  // that URL — which is the "show once on connect" this item asks for, with
  // nothing stored and nothing to clear.
  const resultParam = (await searchParams)[TRADOVATE_RESULT_PARAM];
  const noLiveAccounts =
    (Array.isArray(resultParam) ? resultParam[0] : resultParam) ===
    TradovateResult.ConnectedNoLive;

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

        {/* Only the shell is server-rendered. The badge used to live here, next
            to the heading, while the actions under it were client state — so a
            disconnect updated the body and left the badge reading "מחובר" until
            the next refresh. Everything that a client action can change now sits
            inside one component and derives from one flag. */}
        <Card className={canConnectTradovate ? undefined : 'opacity-75'}>
          <TradovateConnectionCard
            canConnect={canConnectTradovate}
            hasConnection={tradovateStatus !== null}
            isActive={tradovateStatus === 'active'}
            readFailed={tradovateReadFailed}
            // REF-112 item 5. Only ever true on the redirect the callback
            // just issued; see the note where it is computed.
            noLiveAccounts={noLiveAccounts}
          />
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

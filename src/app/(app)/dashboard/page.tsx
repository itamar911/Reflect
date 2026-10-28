import { createClient, getCachedUser } from '@/lib/supabase/server';
import { getUserPlan } from '@/lib/plans/getUserPlan';
import DashboardClient from '@/components/dashboard/DashboardClient';
import { DASH_TRADE_SELECT, mapDashTrade } from '@/lib/dashboard/trades';
import type { DashTrade, RawTradeRow } from '@/lib/dashboard/trades';
import AccountFilterChip from '@/components/accounts/AccountFilterChip';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { isImportEnabled } from '@/lib/tradovate/import';
import { visibleTrades, withAccount, withHidden } from '@/lib/trades/visible';
import { resolveAccountParam, type RawSearchParams } from '@/lib/portfolios/filter';
import { readPortfolioLabel } from '@/lib/portfolios/read';
import { readBrokerState } from '@/lib/tradovate/broker-state';
import { brokerStateNotices } from '@/lib/tradovate/notices';
import BrokerNotices from '@/components/tradovate/BrokerNotices';

export const metadata = { title: 'דשבורד — Reflect' };

export default async function DashboardPage({ searchParams }: {
  /** A Promise on Next 16 — see the note in app/(app)/trades/page.tsx. */
  searchParams: Promise<RawSearchParams>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) return null;

  // isImportEnabled() is the flag the owner sets AFTER running migration 034.
  const hiddenColumnExists = isImportEnabled();

  // Server-side, and the id travels down to DashboardClient as well: the
  // realtime refetch there has to issue the SAME query, or a filtered
  // dashboard would widen to every portfolio the first time another tab
  // touched a trade. The same argument `hiddenColumnExists` is passed for.
  const accountId = resolveAccountParam((await searchParams).account, hiddenColumnExists);
  const accountLabel = await readPortfolioLabel(supabase, user.id, accountId);

  const [profileRes, tradesRes, { tier: plan }, brokerState] = await Promise.all([
    supabase.from('profiles').select('display_name').eq('id', user.id).single(),
    // 'not_entered' is excluded here and in DashboardClient's own refetch,
    // which has to stay in step with this query: a plan the user never entered
    // is not a trade (REF-82 §5.2), and the dashboard also reads a non-empty
    // trade list as "this user is past the welcome state".
    withAccount(
      supabase.from('trade_plans')
        // `hidden` only where the column exists (lib/trades/visible.ts). The
        // same decision is passed to DashboardClient, whose realtime refetch
        // has to issue the same query — see `hiddenColumnExists` there.
        .select(withHidden(DASH_TRADE_SELECT, hiddenColumnExists))
        .eq('user_id', user.id)
        .neq('status', 'not_entered'),
      accountId,
    )
      .order('submitted_at', { ascending: false })
      .limit(500),
    getUserPlan(user.id),
    // REF-112 §5.4 — the one broker state this screen can report that nothing
    // else will. A connection whose environment no longer matches the
    // deployment's still says 'active', so neither the sync panel nor /settings
    // calls it expired; it simply stops refreshing and dies at token lifetime,
    // counted by the keep-alive as a routine skip the whole way down.
    //
    // `brokerAccounts: null` — NOT COUNTED, deliberately. The dashboard does
    // not read the `accounts` table and must not start for this: "you have no
    // portfolios" belongs on the screen whose subject is portfolios, and
    // /accounts says it there.
    //
    // IN THE Promise.all RATHER THAN AFTER IT (REF-129 item 4). It is a
    // service-role read over its own client, so it shares nothing with the two
    // queries above and never depended on their results — awaiting it
    // afterwards simply added its round trip to the page's critical path. It
    // does not throw: readBrokerState answers with a state, including for the
    // trader who has no connection at all, so it cannot reject the Promise.all
    // and take the dashboard down with it.
    readBrokerState({ userId: user.id, brokerAccounts: null }),
  ]);

  const displayName = profileRes.data?.display_name?.split(' ')[0] ?? 'סוחר';

  // Through `unknown`: the select string is chosen at runtime, so supabase-js
  // cannot infer the row shape and `RawTradeRow` is asserted instead.
  const trades: DashTrade[] = visibleTrades(
    (tradesRes.data ?? []) as unknown as RawTradeRow[]
  ).map(mapDashTrade);

  // The same gate Settings uses, evaluated here because allowlist.ts is
  // server-only. Cosmetic either way: /api/tradovate/connect checks the list
  // itself, so this only decides whether the banner is a link or a placeholder.
  const canConnectBroker = isUserAllowed(user.id);

  // Whether the sync button is rendered at all (REF-107 Stage 2.5). A stricter
  // gate than `canConnectBroker` above and a different question: that one asks
  // whether a connection can be MADE, this asks whether a sync could do
  // anything if it ran — which also needs the import flag. Server-side because
  // both halves are, and the same reason the two props above are here.
  const canSync = canConnectBroker && hiddenColumnExists;

  // The state itself is read in the Promise.all above — see the note there.
  const brokerNotices = brokerStateNotices(brokerState);

  return (
    <>
      {/* Outside DashboardClient for the chip's reason below: a paragraph with
          no state, and threading it through a 1,900-line client component
          would make that component know about the connection for the first
          time. */}
      {brokerNotices.length > 0 && (
        <div dir="rtl" className="px-4 pt-4">
          <BrokerNotices notices={brokerNotices} />
        </div>
      )}
      {/* Outside DashboardClient rather than inside it: the chip is a link
          and a label, it needs no state, and threading it through a
          1,900-line client component to render six words would be the only
          reason that component would have to know the filter exists. The id
          below is a different matter — the refetch genuinely needs it. */}
      {accountLabel !== null && (
        <div dir="rtl" className="px-4 pt-4">
          <AccountFilterChip label={accountLabel} clearHref="/dashboard" />
        </div>
      )}
      <DashboardClient
        trades={trades}
        displayName={displayName}
        userId={user.id}
        plan={plan}
        canConnectBroker={canConnectBroker}
        hiddenColumnExists={hiddenColumnExists}
        canSync={canSync}
        accountId={accountId}
      />
    </>
  );
}

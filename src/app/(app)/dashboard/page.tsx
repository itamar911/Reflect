import { createClient, getCachedUser } from '@/lib/supabase/server';
import { getUserPlan } from '@/lib/plans/getUserPlan';
import DashboardClient from '@/components/dashboard/DashboardClient';
import { DASH_TRADE_SELECT, mapDashTrade } from '@/lib/dashboard/trades';
import type { DashTrade, RawTradeRow } from '@/lib/dashboard/trades';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { isImportEnabled } from '@/lib/tradovate/import';
import { visibleTrades, withHidden } from '@/lib/trades/visible';

export const metadata = { title: 'דשבורד — Reflect' };

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) return null;

  // isImportEnabled() is the flag the owner sets AFTER running migration 034.
  const hiddenColumnExists = isImportEnabled();

  const [profileRes, tradesRes, { tier: plan }] = await Promise.all([
    supabase.from('profiles').select('display_name').eq('id', user.id).single(),
    // 'not_entered' is excluded here and in DashboardClient's own refetch,
    // which has to stay in step with this query: a plan the user never entered
    // is not a trade (REF-82 §5.2), and the dashboard also reads a non-empty
    // trade list as "this user is past the welcome state".
    supabase.from('trade_plans')
      // `hidden` only where the column exists (lib/trades/visible.ts). The
      // same decision is passed to DashboardClient, whose realtime refetch
      // has to issue the same query — see `hiddenColumnExists` there.
      .select(withHidden(DASH_TRADE_SELECT, hiddenColumnExists))
      .eq('user_id', user.id)
      .neq('status', 'not_entered')
      .order('submitted_at', { ascending: false })
      .limit(500),
    getUserPlan(supabase, user.id),
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

  return (
    <DashboardClient
      trades={trades}
      displayName={displayName}
      userId={user.id}
      plan={plan}
      canConnectBroker={canConnectBroker}
      hiddenColumnExists={hiddenColumnExists}
      canSync={canSync}
    />
  );
}

import { createClient, getCachedUser } from '@/lib/supabase/server';
import { getUserPlan } from '@/lib/plans/getUserPlan';
import DashboardClient from '@/components/dashboard/DashboardClient';
import { DASH_TRADE_SELECT, mapDashTrade } from '@/lib/dashboard/trades';
import type { DashTrade } from '@/lib/dashboard/trades';
import { isUserAllowed } from '@/lib/tradovate/allowlist';

export const metadata = { title: 'דשבורד — Reflect' };

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) return null;

  const [profileRes, tradesRes, { tier: plan }] = await Promise.all([
    supabase.from('profiles').select('display_name').eq('id', user.id).single(),
    supabase.from('trade_plans')
      .select(DASH_TRADE_SELECT)
      .eq('user_id', user.id)
      .order('submitted_at', { ascending: false })
      .limit(500),
    getUserPlan(supabase, user.id),
  ]);

  const displayName = profileRes.data?.display_name?.split(' ')[0] ?? 'סוחר';

  const trades: DashTrade[] = (tradesRes.data ?? []).map(mapDashTrade);

  // The same gate Settings uses, evaluated here because allowlist.ts is
  // server-only. Cosmetic either way: /api/tradovate/connect checks the list
  // itself, so this only decides whether the banner is a link or a placeholder.
  const canConnectBroker = isUserAllowed(user.id);

  return (
    <DashboardClient
      trades={trades}
      displayName={displayName}
      userId={user.id}
      plan={plan}
      canConnectBroker={canConnectBroker}
    />
  );
}

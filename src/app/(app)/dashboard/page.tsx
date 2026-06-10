import { createClient } from '@/lib/supabase/server';
import DashboardClient, { DASH_TRADE_SELECT, mapDashTrade } from '@/components/dashboard/DashboardClient';
import type { DashTrade } from '@/components/dashboard/DashboardClient';

export const metadata = { title: 'דשבורד — Reflect' };

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const [profileRes, tradesRes] = await Promise.all([
    supabase.from('profiles').select('display_name').eq('id', user.id).single(),
    supabase.from('trade_plans')
      .select(DASH_TRADE_SELECT)
      .eq('user_id', user.id)
      .order('submitted_at', { ascending: false })
      .limit(500),
  ]);

  const displayName = profileRes.data?.display_name?.split(' ')[0] ?? 'סוחר';

  const trades: DashTrade[] = (tradesRes.data ?? []).map(mapDashTrade);

  return <DashboardClient trades={trades} displayName={displayName} userId={user.id} />;
}

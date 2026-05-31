import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import SetupsClient, { type Setup, type LinkedTrade } from '@/components/setups/SetupsClient';

export const metadata = { title: 'סטאפים ותגיות — Reflect' };

export default async function SetupsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [setupsRes, tradesRes] = await Promise.all([
    supabase
      .from('setups')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false }),
    supabase
      .from('trade_plans')
      .select('id, strategy, symbol, entry_price, exit_price, status, setup_id, submitted_at, rr_ratio')
      .eq('user_id', user.id)
      .order('submitted_at', { ascending: false }),
  ]);

  return (
    <SetupsClient
      initialSetups={(setupsRes.data ?? []) as Setup[]}
      initialTrades={(tradesRes.data ?? []) as LinkedTrade[]}
      userId={user.id}
    />
  );
}

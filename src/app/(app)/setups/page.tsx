import { redirect } from 'next/navigation';
import { createClient, getCachedUser } from '@/lib/supabase/server';
import { signSetupImages } from '@/lib/setups/imageUrls';
import SetupsClient, { type Setup, type LinkedTrade } from '@/components/setups/SetupsClient';

export const metadata = { title: 'סטאפים ותגיות — Reflect' };

export default async function SetupsPage() {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) redirect('/login');

  const [setupsRes, tradesRes] = await Promise.all([
    supabase
      .from('setups')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false }),
    // Win rate and P&L per setup. A plan the user never entered is not a trade
    // (REF-82 §5.2) and would dilute a setup's trade count without ever
    // contributing an outcome.
    supabase
      .from('trade_plans')
      .select('id, strategy, symbol, entry_price, exit_price, status, setup_id, submitted_at, rr_ratio')
      .eq('user_id', user.id)
      .neq('status', 'not_entered')
      .order('submitted_at', { ascending: false }),
  ]);

  // image_url on the row is the legacy public URL, which stops resolving once
  // the bucket goes private (020). Every URL the client renders is minted here
  // instead, from image_path, and lives for SIGNED_URL_TTL_SECONDS.
  const setups = await signSetupImages(
    supabase,
    (setupsRes.data ?? []) as Setup[],
    user.id,
  );

  return (
    <SetupsClient
      initialSetups={setups}
      initialTrades={(tradesRes.data ?? []) as LinkedTrade[]}
      userId={user.id}
    />
  );
}

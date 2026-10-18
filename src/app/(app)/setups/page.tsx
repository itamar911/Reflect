import { redirect } from 'next/navigation';
import { createClient, getCachedUser } from '@/lib/supabase/server';
import { isImportEnabled } from '@/lib/tradovate/import';
import { visibleTrades, withHidden } from '@/lib/trades/visible';
import { signSetupImages } from '@/lib/setups/imageUrls';
import SetupsClient, { type Setup, type LinkedTrade } from '@/components/setups/SetupsClient';

export const metadata = { title: 'סטאפים ותגיות — Reflect' };

export default async function SetupsPage() {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) redirect('/login');

  // isImportEnabled() is the flag the owner sets AFTER running migration 034,
  // which is what makes naming the column safe. See lib/trades/visible.ts.
  const hiddenExists = isImportEnabled();

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
      // `direction` and the money columns are selected because this page's
      // P&L is MONEY and its win test reads a real figure rather than
      // comparing two prices (REF-106 / REF-115 site 3). Without them the
      // client could only subtract entry from exit, which is a price
      // difference shown under a `$` — and, read without `direction`, calls
      // every profitable short a loss (REF-107 §0ד). The same column list
      // /strategies already selects, for the same reason.
      //
      // `hidden` only where the column exists — this reader names its
      // columns, so it has to ask (lib/trades/visible.ts).
      .select(withHidden('id, strategy, symbol, entry_price, exit_price, take_profit, status, direction, pnl_amount, actual_pnl, setup_id, submitted_at, rr_ratio', hiddenExists))
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
      initialTrades={visibleTrades((tradesRes.data ?? []) as unknown as LinkedTrade[])}
      userId={user.id}
    />
  );
}

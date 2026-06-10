import { createClient } from '@/lib/supabase/server';
import DashboardClient from '@/components/dashboard/DashboardClient';
import type { DashTrade } from '@/components/dashboard/DashboardClient';

export const metadata = { title: 'דשבורד — Reflect' };

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const [profileRes, tradesRes] = await Promise.all([
    supabase.from('profiles').select('display_name').eq('id', user.id).single(),
    supabase.from('trade_plans')
      .select('id,strategy,symbol,entry_price,exit_price,stop_loss,take_profit,rr_ratio,emotional_state,trade_reason,status,exit_reason,submitted_at,closed_at,quantity,multiplier,pnl_amount,pnl_currency')
      .eq('user_id', user.id)
      .order('submitted_at', { ascending: false })
      .limit(500),
  ]);

  const displayName = profileRes.data?.display_name?.split(' ')[0] ?? 'סוחר';

  const trades: DashTrade[] = (tradesRes.data ?? []).map(t => ({
    id:               t.id               as string,
    strategy:         t.strategy         as string,
    symbol:           (t.symbol          as string | null) ?? null,
    entry_price:      Number(t.entry_price),
    exit_price:       t.exit_price != null ? Number(t.exit_price) : null,
    stop_loss:        Number(t.stop_loss),
    take_profit:      Number(t.take_profit),
    rr_ratio:         Number(t.rr_ratio),
    emotional_state:  Number(t.emotional_state),
    trade_reason:     t.trade_reason     as string,
    status:           t.status           as string,
    exit_reason:      (t.exit_reason     as string | null) ?? null,
    submitted_at:     t.submitted_at     as string,
    closed_at:        (t.closed_at       as string | null) ?? null,
    quantity:         t.quantity != null ? Number(t.quantity) : null,
    multiplier:       t.multiplier != null ? Number(t.multiplier) : 1,
    pnl_amount:       t.pnl_amount != null ? Number(t.pnl_amount) : null,
    pnl_currency:     (t.pnl_currency as string | null) ?? null,
  }));

  return <DashboardClient trades={trades} displayName={displayName} />;
}

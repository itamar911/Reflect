import { createClient } from '@/lib/supabase/server';
import JournalExport from '@/components/journal/JournalExport';
import JournalClient from '@/components/journal/JournalClient';

export const metadata = { title: 'כל העסקאות — Reflect' };

export default async function TradesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: trades } = await supabase
    .from('trade_plans')
    .select('*')
    .eq('user_id', user.id)
    .order('submitted_at', { ascending: false })
    .limit(1000);

  const allTrades = (trades ?? []).map((t) => ({
    id:               t.id               as string,
    strategy:         t.strategy         as string,
    symbol:           (t.symbol          as string | null) ?? null,
    entry_price:      Number(t.entry_price),
    stop_loss:        Number(t.stop_loss),
    take_profit:      Number(t.take_profit),
    rr_ratio:         Number(t.rr_ratio),
    emotional_state:  Number(t.emotional_state),
    trade_reason:     t.trade_reason     as string,
    status:           t.status           as string,
    exit_price:       t.exit_price != null ? Number(t.exit_price) : null,
    exit_reason:      t.exit_reason      as string | null,
    post_trade_notes: t.post_trade_notes as string | null,
    debrief_answer:   t.debrief_answer   as string | null,
    submitted_at:     t.submitted_at     as string,
    closed_at:        t.closed_at        as string | null,
    plan_score:       t.plan_score       as number | null,
    quantity:         t.quantity != null ? Number(t.quantity) : null,
    units:            t.units != null ? Number(t.units) : null,
    point_value:      t.point_value != null ? Number(t.point_value) : null,
    direction:        (t.direction as 'long' | 'short' | null) ?? null,
    pnl_amount:       t.pnl_amount != null ? Number(t.pnl_amount) : null,
    pnl_currency:     (t.pnl_currency as string | null) ?? null,
  }));

  const exportTrades = allTrades.map((t) => ({
    submitted_at:    t.submitted_at,
    strategy:        t.strategy,
    entry_price:     t.entry_price,
    stop_loss:       t.stop_loss,
    take_profit:     t.take_profit,
    rr_ratio:        t.rr_ratio,
    emotional_state: t.emotional_state,
    trade_reason:    t.trade_reason,
    status:          t.status,
    debrief_answer:  t.debrief_answer,
  }));

  return (
    <div dir="rtl" className="px-4 py-5 flex flex-col gap-4 md:max-w-none">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-tg-text">כל העסקאות</h1>
          <p className="text-xs text-tg-muted mt-0.5">
            {allTrades.filter((t) => t.status === 'open').length} פתוחות ·{' '}
            {allTrades.filter((t) => t.status === 'closed').length} סגורות
          </p>
        </div>
        <JournalExport trades={exportTrades} />
      </div>
      <JournalClient trades={allTrades} />
    </div>
  );
}

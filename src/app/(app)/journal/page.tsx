import { createClient } from '@/lib/supabase/server';
import { BookOpen } from 'lucide-react';
import JournalExport from '@/components/journal/JournalExport';
import TradeCalendar from '@/components/journal/TradeCalendar';

export const metadata = { title: 'יומן חודשי — Reflect' };

export default async function JournalPage() {
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
    pnl_amount:       t.pnl_amount != null ? Number(t.pnl_amount) : null,
    actual_pnl:       t.actual_pnl != null ? Number(t.actual_pnl) : null,
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
          <h1 className="text-xl font-bold text-tg-text">יומן חודשי</h1>
          <p className="text-xs text-tg-muted mt-0.5">
            {allTrades.filter((t) => t.status === 'open').length} פתוחות ·{' '}
            {allTrades.filter((t) => t.status === 'closed').length} סגורות
          </p>
        </div>
        <JournalExport trades={exportTrades} />
      </div>
      {allTrades.length === 0 ? (
        <div className="text-center py-12 rounded-2xl border border-tg-border"
          style={{ background: 'var(--color-tg-surface)' }}>
          <div className="mb-3"><BookOpen size={40} /></div>
          <h3 className="text-base font-semibold text-tg-text mb-1">היומן ריק עדיין</h3>
          <p className="text-sm text-tg-text-2">לחץ על + כדי להגיש את תוכנית העסקה הראשונה שלך</p>
        </div>
      ) : (
        <TradeCalendar trades={allTrades} />
      )}
    </div>
  );
}

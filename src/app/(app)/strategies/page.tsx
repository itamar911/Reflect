import { createClient } from '@/lib/supabase/server';
import { getUserPlan } from '@/lib/plans/getUserPlan';
import StrategiesClient from '@/components/strategies/StrategiesClient';
import type { PersonalStrategy, TradeSummary } from '@/components/strategies/StrategiesClient';

export const metadata = { title: 'אסטרטגיות — Reflect' };

export default async function StrategiesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const [strategiesRes, tradesRes, { tier: plan }] = await Promise.all([
    supabase.from('personal_strategies').select('*').eq('user_id', user.id).order('created_at'),
    supabase.from('trade_plans')
      .select('id, strategy, symbol, entry_price, exit_price, take_profit, rr_ratio, status, submitted_at, closed_at')
      .eq('user_id', user.id)
      .order('submitted_at', { ascending: false })
      .limit(1000),
    getUserPlan(supabase, user.id),
  ]);

  const strategies = (strategiesRes.data ?? []) as PersonalStrategy[];
  const allTrades  = (tradesRes.data ?? []).map(t => ({
    id:           t.id           as string,
    strategy:     t.strategy     as string,
    symbol:       (t.symbol      as string | null) ?? null,
    entry_price:  Number(t.entry_price),
    exit_price:   t.exit_price != null ? Number(t.exit_price) : null,
    take_profit:  Number(t.take_profit),
    rr_ratio:     Number(t.rr_ratio),
    status:       t.status       as string,
    submitted_at: t.submitted_at as string,
    closed_at:    (t.closed_at   as string | null) ?? null,
  })) as TradeSummary[];

  return (
    <div dir="rtl" className="px-4 py-5 flex flex-col gap-5 md:max-w-none">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-tg-text">האסטרטגיות שלי</h1>
          <p className="text-xs text-tg-muted mt-0.5">
            {strategies.length} אסטרטגיות · {allTrades.length} עסקאות בסה״כ
          </p>
        </div>
      </div>
      <StrategiesClient
        userId={user.id}
        initialStrategies={strategies}
        allTrades={allTrades}
        plan={plan}
      />
    </div>
  );
}

import { createClient, getCachedUser } from '@/lib/supabase/server';
import { isImportEnabled } from '@/lib/tradovate/import';
import { visibleTrades, withHidden } from '@/lib/trades/visible';
import StrategiesClient from '@/components/strategies/StrategiesClient';
import type { PersonalStrategy, TradeSummary } from '@/components/strategies/StrategiesClient';

export const metadata = { title: 'אסטרטגיות — Reflect' };

export default async function StrategiesPage() {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) return null;

  const [strategiesRes, tradesRes] = await Promise.all([
    supabase.from('personal_strategies').select('*').eq('user_id', user.id).order('created_at'),
    // Per-strategy performance, plus the "N עסקאות בסה״כ" line below. Both
    // count trades, and a plan the user never entered is not one (REF-82 §5.2)
    // — excluded here so StrategiesClient's own counts and its per-trade
    // רווח/הפסד/פתוח labels never have to represent a third state.
    supabase.from('trade_plans')
      // `direction` and the money columns are selected because win/loss is
      // read, not guessed: deriving it from take_profit-vs-entry calls every
      // profitable short a loss (REF-107 §0ד), and the shared win test prefers
      // a real P&L figure over price points.
      // `hidden` only where the column exists (lib/trades/visible.ts).
      .select(withHidden('id, strategy, symbol, entry_price, exit_price, take_profit, rr_ratio, status, direction, pnl_amount, actual_pnl, submitted_at, closed_at', isImportEnabled()))
      .eq('user_id', user.id)
      .neq('status', 'not_entered')
      .order('submitted_at', { ascending: false })
      .limit(1000),
  ]);

  const strategies = (strategiesRes.data ?? []) as PersonalStrategy[];
  // Through `unknown`: supabase-js infers the row shape by parsing the select
  // string at the type level and cannot do that for one chosen at runtime.
  const allTrades  = visibleTrades((tradesRes.data ?? []) as unknown as Record<string, unknown>[]).map(t => ({
    id:           t.id           as string,
    strategy:     (t.strategy    as string | null) ?? null,
    symbol:       (t.symbol      as string | null) ?? null,
    entry_price:  Number(t.entry_price),
    exit_price:   t.exit_price != null ? Number(t.exit_price) : null,
    take_profit:  t.take_profit != null ? Number(t.take_profit) : null,
    rr_ratio:     t.rr_ratio != null ? Number(t.rr_ratio) : null,
    status:       t.status       as string,
    direction:    (t.direction as 'long' | 'short' | null) ?? null,
    pnl_amount:   t.pnl_amount != null ? Number(t.pnl_amount) : null,
    actual_pnl:   t.actual_pnl != null ? Number(t.actual_pnl) : null,
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
      />
    </div>
  );
}

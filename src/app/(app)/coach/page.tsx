import { createClient, getCachedUser } from '@/lib/supabase/server';
import { visibleTrades } from '@/lib/trades/visible';
import { Bot } from 'lucide-react';
import ChartAnalysis from '@/components/ai/ChartAnalysis';
import AICoachCard from '@/components/ai/AICoachCard';
import PatternDetection from '@/components/ai/PatternDetection';
import TradingBot from '@/components/ai/TradingBot';

export const metadata = { title: 'יועץ מסחר — Reflect' };

export default async function CoachPage() {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) return null;

  // These rows become the prompt for /api/ai-coach and /api/ai-patterns, both
  // of which average over every row (avgRR, average emotional state, the
  // discipline score) and read runs of consecutive trades. A plan the user
  // never entered would be described to the coach as a trade (REF-82 §5.2) —
  // and it would break the revenge-trade detection, which looks at the gap
  // between one trade and the next.
  const { data: rawTrades } = await supabase
    .from('trade_plans')
    .select('*')
    .eq('user_id', user.id)
    .neq('status', 'not_entered')
    .order('submitted_at', { ascending: false })
    .limit(100);

  // Nulls are passed through, not defaulted. `Number(x || 3)` and
  // `Number(x || 0)` turned "the trader recorded nothing" into "the trader
  // felt exactly neutral" and "the trader planned exactly 1:0" before either
  // route saw the row, so no care downstream could tell the two apart
  // (REF-107 §0ג). `direction` and the money columns are carried so the routes
  // can read win/loss rather than compare exit to entry (§0ד).
  //
  // A row the trader deleted is not described to the coach either (E12).
  const allTrades = visibleTrades(rawTrades ?? []).map((t) => ({
    strategy: (t.strategy as string | null) ?? null,
    emotional_state: t.emotional_state != null ? Number(t.emotional_state) : null,
    rr_ratio: t.rr_ratio != null ? Number(t.rr_ratio) : null,
    submitted_at: String(t.submitted_at),
    status: String(t.status),
    entry_price: Number(t.entry_price ?? 0),
    exit_price: t.exit_price != null ? Number(t.exit_price) : null,
    stop_loss: t.stop_loss != null ? Number(t.stop_loss) : null,
    take_profit: t.take_profit != null ? Number(t.take_profit) : null,
    direction: (t.direction as 'long' | 'short' | null) ?? null,
    pnl_amount: t.pnl_amount != null ? Number(t.pnl_amount) : null,
    actual_pnl: t.actual_pnl != null ? Number(t.actual_pnl) : null,
    plan_score: t.plan_score != null ? Number(t.plan_score) : null,
  }));

  return (
    <div className="px-4 py-5 flex flex-col gap-5 md:max-w-none">
      <div>
        <h1 className="text-xl font-bold text-tg-text">יועץ המסחר שלי</h1>
        <p className="text-sm text-tg-text-2 mt-0.5">השפעה ריאלית על הארנק שלך — מבוסס על הנתונים שלך</p>
      </div>

      {/* Trading Bot - main feature */}
      <div className="rounded-2xl border border-tg-border overflow-hidden flex flex-col h-[60dvh] md:h-[520px]"
        style={{ background: 'var(--color-tg-surface)' }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-tg-border shrink-0"
          style={{ background: 'var(--color-tg-surface-2)' }}>
          <div className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ background: 'var(--color-tg-primary-muted)' }}>
            <Bot aria-hidden="true" size={18} />
          </div>
          <div>
            <p className="text-sm font-bold text-tg-text">יועץ המסחר שלי</p>
            <p className="text-[10px] text-tg-muted">מכיר את כל ההיסטוריה שלך + ידע מסחרי מקצועי</p>
          </div>
        </div>
        <div className="flex-1 overflow-hidden p-4" style={{ minHeight: 0 }}>
          <TradingBot />
        </div>
      </div>

      {/* AI Insights */}
      {allTrades.length >= 3 && <AICoachCard trades={allTrades} />}
      {allTrades.length >= 5 && <PatternDetection trades={allTrades} />}

      {/* Chart Analysis */}
      <ChartAnalysis />
    </div>
  );
}

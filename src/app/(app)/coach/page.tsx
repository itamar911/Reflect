import { createClient } from '@/lib/supabase/server';
import ChartAnalysis from '@/components/ai/ChartAnalysis';
import AICoachCard from '@/components/ai/AICoachCard';
import PatternDetection from '@/components/ai/PatternDetection';
import TradingBot from '@/components/ai/TradingBot';

export const metadata = { title: 'יועץ מסחר — Reflect' };

export default async function CoachPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: trades } = await supabase
    .from('trade_plans')
    .select('*')
    .eq('user_id', user.id)
    .order('submitted_at', { ascending: false })
    .limit(100);

  const allTrades = (trades ?? []).map((t) => ({
    strategy: String(t.strategy || ''),
    emotional_state: Number(t.emotional_state || 3),
    rr_ratio: Number(t.rr_ratio || 0),
    submitted_at: String(t.submitted_at),
    status: String(t.status),
    entry_price: Number(t.entry_price || 0),
    exit_price: t.exit_price !== null ? Number(t.exit_price) : null,
    stop_loss: Number(t.stop_loss || 0),
  }));

  return (
    <div className="px-4 py-5 flex flex-col gap-5 md:max-w-none">
      <div>
        <h1 className="text-xl font-bold text-tg-text">יועץ המסחר שלי</h1>
        <p className="text-sm text-tg-text-2 mt-0.5">השפעה ריאלית על הארנק שלך — מבוסס על הנתונים שלך</p>
      </div>

      {/* Trading Bot - main feature */}
      <div className="rounded-2xl border border-tg-border overflow-hidden"
        style={{ background: 'var(--color-tg-surface)', height: '520px', display: 'flex', flexDirection: 'column' }}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-tg-border shrink-0"
          style={{ background: 'var(--color-tg-surface-2)' }}>
          <div className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ background: 'var(--color-tg-primary-muted)' }}>
            🤖
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

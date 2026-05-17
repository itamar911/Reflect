import { createClient } from '@/lib/supabase/server';
import AICoachCard from '@/components/ai/AICoachCard';
import PatternDetection from '@/components/ai/PatternDetection';
import ChartAnalysis from '@/components/ai/ChartAnalysis';

export const metadata = { title: 'AI Coach ג€” Reflect' };

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
    <div className="px-4 py-5 flex flex-col gap-4 max-w-2xl mx-auto">
      <div>
        <h1 className="text-xl font-bold text-tg-text">AI Coach</h1>
        <p className="text-sm text-tg-text-2 mt-0.5">׳×׳•׳‘׳ ׳•׳× ׳׳™׳©׳™׳•׳× ׳׳‘׳•׳¡׳¡׳•׳× ׳”׳ ׳×׳•׳ ׳™׳ ׳©׳׳</p>
      </div>

      <AICoachCard trades={allTrades} />
      <PatternDetection trades={allTrades} />
      <ChartAnalysis />
    </div>
  );
}

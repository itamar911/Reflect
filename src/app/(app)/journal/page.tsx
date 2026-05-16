import { createClient } from '@/lib/supabase/server';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import TradeDebrief from '@/components/journal/TradeDebrief';
import JournalExport from '@/components/journal/JournalExport';

export const metadata = { title: 'יומן עסקאות — Reflekt' };

const EMOTIONAL_EMOJIS: Record<number, string> = { 1: '😰', 2: '😟', 3: '😐', 4: '🙂', 5: '😎' };

export default async function JournalPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: trades } = await supabase
    .from('trade_plans')
    .select('*')
    .eq('user_id', user.id)
    .order('submitted_at', { ascending: false })
    .limit(50);

  const allTrades = trades ?? [];

  const exportTrades = allTrades.map((t) => ({
    submitted_at: t.submitted_at as string,
    strategy: t.strategy as string,
    entry_price: t.entry_price as number,
    stop_loss: t.stop_loss as number,
    take_profit: t.take_profit as number,
    rr_ratio: t.rr_ratio as number,
    emotional_state: t.emotional_state as number,
    trade_reason: t.trade_reason as string,
    status: t.status as string,
    debrief_answer: t.debrief_answer as string | null,
  }));

  return (
    <div className="px-4 py-5 flex flex-col gap-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-tg-text">יומן עסקאות</h1>
          {allTrades.length > 0 && (
            <p className="text-xs text-tg-muted mt-0.5">
              {allTrades.filter((t) => t.status === 'open').length} פתוחות ·{' '}
              {allTrades.filter((t) => t.status === 'closed').length} סגורות
            </p>
          )}
        </div>
        <JournalExport trades={exportTrades} />
      </div>

      {allTrades.length === 0 ? (
        <Card className="text-center py-12">
          <div className="text-4xl mb-3">📓</div>
          <h3 className="text-base font-semibold text-tg-text mb-1">היומן ריק עדיין</h3>
          <p className="text-sm text-tg-text-2">לחץ על + כדי להגיש את תוכנית העסקה הראשונה שלך</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {allTrades.map((trade) => (
            <TradeCard key={trade.id as string} trade={trade} />
          ))}
        </div>
      )}
    </div>
  );
}

function TradeCard({ trade }: { trade: Record<string, unknown> }) {
  const submittedAt = new Date(trade.submitted_at as string);
  const dateStr = submittedAt.toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
  const timeStr = submittedAt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const rr = Number(trade.rr_ratio);
  const emotional = trade.emotional_state as number;
  const isClosed = trade.status === 'closed';
  const debriefAnswer = trade.debrief_answer as string | null;

  return (
    <Card padding="none">
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-tg-text">{trade.strategy as string}</span>
              <Badge variant={isClosed ? 'default' : 'primary'}>
                {isClosed ? 'סגור' : 'פתוח'}
              </Badge>
            </div>
            <p className="text-xs text-tg-muted mt-0.5">{dateStr} · {timeStr}</p>
          </div>
          <div className="text-left">
            <span className="text-sm font-bold"
              style={{ color: rr >= 2 ? 'var(--color-tg-success)' : rr >= 1 ? 'var(--color-tg-warning)' : 'var(--color-tg-danger)' }}>
              R:R {rr.toFixed(1)}
            </span>
          </div>
        </div>

        {/* Prices */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <PriceBox label="כניסה" value={Number(trade.entry_price).toFixed(2)} />
          <PriceBox label="Stop Loss" value={Number(trade.stop_loss).toFixed(2)} danger />
          <PriceBox label="Take Profit" value={Number(trade.take_profit).toFixed(2)} success />
        </div>

        {/* Reason + emotional */}
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className="text-xs text-tg-text-2 flex-1 line-clamp-2">{trade.trade_reason as string}</p>
          <span className="text-lg shrink-0" title={`מצב רגשי: ${emotional}/5`}>
            {EMOTIONAL_EMOJIS[emotional] ?? '😐'}
          </span>
        </div>

        {/* Debrief */}
        {isClosed && (
          <div className="pt-3 border-t border-tg-border">
            <TradeDebrief
              tradeId={trade.id as string}
              existingAnswer={debriefAnswer}
            />
          </div>
        )}
      </div>
    </Card>
  );
}

function PriceBox({ label, value, danger, success }: { label: string; value: string; danger?: boolean; success?: boolean }) {
  const color = danger ? 'var(--color-tg-danger)' : success ? 'var(--color-tg-success)' : 'var(--color-tg-text-2)';
  return (
    <div className="rounded-xl px-2 py-2 text-center"
      style={{ background: 'var(--color-tg-surface-2)' }}>
      <p className="text-xs font-medium mb-0.5" style={{ color }}>{label}</p>
      <p className="text-sm font-bold text-tg-text">{value}</p>
    </div>
  );
}

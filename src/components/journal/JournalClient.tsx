'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import TradeDebrief from '@/components/journal/TradeDebrief';
import CloseTrade from '@/components/journal/CloseTrade';

type FilterTab = 'all' | 'open' | 'closed';

const EMOTIONAL_EMOJIS: Record<number, string> = { 1: '😰', 2: '😟', 3: '😐', 4: '🙂', 5: '😎' };

interface Trade {
  id: string;
  strategy: string;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  rr_ratio: number;
  emotional_state: number;
  trade_reason: string;
  status: string;
  exit_price: number | null;
  exit_reason: string | null;
  post_trade_notes: string | null;
  debrief_answer: string | null;
  submitted_at: string;
  closed_at: string | null;
  plan_score: number | null;
}

interface JournalClientProps {
  trades: Trade[];
}

export default function JournalClient({ trades }: JournalClientProps) {
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [strategyFilter, setStrategyFilter] = useState<string>('all');
  const router = useRouter();

  const strategies = useMemo(() => {
    const s = new Set(trades.map((t) => t.strategy));
    return ['all', ...Array.from(s)];
  }, [trades]);

  const filtered = useMemo(() => {
    return trades.filter((t) => {
      if (activeFilter === 'open' && t.status !== 'open') return false;
      if (activeFilter === 'closed' && t.status !== 'closed') return false;
      if (strategyFilter !== 'all' && t.strategy !== strategyFilter) return false;
      return true;
    });
  }, [trades, activeFilter, strategyFilter]);

  const openCount = trades.filter((t) => t.status === 'open').length;
  const closedCount = trades.filter((t) => t.status === 'closed').length;

  return (
    <div className="flex flex-col gap-4">
      {/* Filter tabs */}
      <div className="flex gap-1 p-1 rounded-xl" style={{ background: 'var(--color-tg-surface)' }}>
        {[
          { key: 'all' as FilterTab, label: `הכל (${trades.length})` },
          { key: 'open' as FilterTab, label: `פתוחות (${openCount})` },
          { key: 'closed' as FilterTab, label: `סגורות (${closedCount})` },
        ].map(({ key, label }) => (
          <button key={key} onClick={() => setActiveFilter(key)}
            className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{
              background: activeFilter === key ? 'var(--color-tg-primary)' : 'transparent',
              color: activeFilter === key ? '#000' : 'var(--color-tg-text-2)',
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* Strategy filter */}
      {strategies.length > 2 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
          {strategies.map((s) => (
            <button key={s} onClick={() => setStrategyFilter(s)}
              className="shrink-0 px-3 py-1 rounded-full text-xs border transition-all"
              style={{
                background: strategyFilter === s ? 'var(--color-tg-primary-muted)' : 'var(--color-tg-surface)',
                borderColor: strategyFilter === s ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                color: strategyFilter === s ? 'var(--color-tg-primary)' : 'var(--color-tg-text-2)',
              }}>
              {s === 'all' ? 'כל האסטרטגיות' : s}
            </button>
          ))}
        </div>
      )}

      {/* Trade list */}
      {filtered.length === 0 ? (
        <Card className="text-center py-8">
          <p className="text-sm text-tg-text-2">אין עסקאות בפילטר הנבחר</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((trade) => (
            <TradeCard key={trade.id} trade={trade} onClose={() => router.refresh()} />
          ))}
        </div>
      )}
    </div>
  );
}

function TradeCard({ trade, onClose }: { trade: Trade; onClose: () => void }) {
  const submittedAt = new Date(trade.submitted_at);
  const dateStr = submittedAt.toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
  const timeStr = submittedAt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const rr = Number(trade.rr_ratio);
  const isClosed = trade.status === 'closed';
  const pnlPoints = isClosed && trade.exit_price != null
    ? (trade.exit_price - trade.entry_price).toFixed(2)
    : null;
  const isWin = pnlPoints !== null ? parseFloat(pnlPoints) > 0 : null;

  return (
    <Card padding="none">
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-tg-text">{trade.strategy}</span>
              <Badge variant={isClosed ? (isWin ? 'success' : isWin === false ? 'danger' : 'default') : 'primary'}>
                {isClosed ? (isWin ? 'רווח' : isWin === false ? 'הפסד' : 'סגור') : 'פתוח'}
              </Badge>
            </div>
            <p className="text-xs text-tg-muted mt-0.5">{dateStr} · {timeStr}</p>
          </div>
          <div className="text-left">
            <span className="text-sm font-bold"
              style={{ color: rr >= 2 ? 'var(--color-tg-success)' : rr >= 1 ? 'var(--color-tg-warning)' : 'var(--color-tg-danger)' }}>
              R:R {rr.toFixed(1)}
            </span>
            {pnlPoints !== null && (
              <p className="text-xs font-semibold mt-0.5"
                style={{ color: isWin ? 'var(--color-tg-success)' : 'var(--color-tg-danger)' }}>
                {isWin ? '+' : ''}{pnlPoints} נק׳
              </p>
            )}
          </div>
        </div>

        {/* Prices */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <PriceBox label="כניסה" value={Number(trade.entry_price).toFixed(2)} />
          <PriceBox label="Stop Loss" value={Number(trade.stop_loss).toFixed(2)} danger />
          <PriceBox label="Take Profit" value={Number(trade.take_profit).toFixed(2)} success />
        </div>

        {/* Exit price if closed */}
        {isClosed && trade.exit_price != null && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-xl"
            style={{ background: isWin ? 'var(--color-tg-success-muted)' : 'var(--color-tg-danger-muted)' }}>
            <span className="text-xs text-tg-text-2">יציאה:</span>
            <span className="text-sm font-bold"
              style={{ color: isWin ? 'var(--color-tg-success)' : 'var(--color-tg-danger)' }}>
              {Number(trade.exit_price).toFixed(2)}
            </span>
            {trade.exit_reason && (
              <span className="text-xs text-tg-muted flex-1 text-left">— {trade.exit_reason}</span>
            )}
          </div>
        )}

        {/* Reason + emotional */}
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className="text-xs text-tg-text-2 flex-1 line-clamp-2">{trade.trade_reason}</p>
          <span className="text-lg shrink-0">{EMOTIONAL_EMOJIS[trade.emotional_state] ?? '😐'}</span>
        </div>

        {/* Close button for open trades */}
        {!isClosed && (
          <CloseTrade
            tradeId={trade.id}
            entryPrice={trade.entry_price}
            stopLoss={trade.stop_loss}
            takeProfit={trade.take_profit}
            rrRatio={trade.rr_ratio}
            emotionalState={trade.emotional_state}
            strategy={trade.strategy}
            tradeReason={trade.trade_reason}
            onClosed={onClose}
          />
        )}

        {/* Debrief for closed trades */}
        {isClosed && (
          <div className="pt-3 border-t border-tg-border">
            <TradeDebrief
              trade={{
                id: trade.id,
                strategy: trade.strategy,
                entry_price: trade.entry_price,
                stop_loss: trade.stop_loss,
                take_profit: trade.take_profit,
                rr_ratio: trade.rr_ratio,
                emotional_state: trade.emotional_state,
                trade_reason: trade.trade_reason,
                status: trade.status,
                exit_price: trade.exit_price,
              }}
              existingAnswer={trade.debrief_answer}
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
    <div className="rounded-xl px-2 py-2 text-center" style={{ background: 'var(--color-tg-surface-2)' }}>
      <p className="text-xs font-medium mb-0.5" style={{ color }}>{label}</p>
      <p className="text-sm font-bold text-tg-text">{value}</p>
    </div>
  );
}

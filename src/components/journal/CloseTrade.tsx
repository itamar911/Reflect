'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';
import { Bot } from 'lucide-react';

export interface AIDebriefResult {
  overall?: string;
  entry_quality?: string;
  risk_management?: string;
  execution?: string;
  emotional?: string;
  lessons?: string;
  score?: number;
}

interface TradeForDebrief {
  id: string;
  strategy: string;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  rr_ratio: number;
  emotional_state: number;
  trade_reason: string;
  exit_price: number;
  exit_reason: string;
  post_trade_notes: string;
}

interface CloseTradeProps {
  tradeId: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  rrRatio: number;
  emotionalState: number;
  strategy: string;
  tradeReason: string;
  onClosed: () => void;
  onDebrief?: (result: AIDebriefResult) => void;
}

const EXIT_REASONS = [
  'הגיע Take Profit',
  'הגיע Stop Loss',
  'יציאה ידנית — רווח',
  'יציאה ידנית — הפסד',
  'שינוי בשוק',
  'הזזת Stop לכניסה',
  'ניהול סיכון',
  'סגירה מוקדמת',
];

export default function CloseTrade({
  tradeId, entryPrice, stopLoss, takeProfit, rrRatio,
  emotionalState, strategy, tradeReason, onClosed, onDebrief
}: CloseTradeProps) {
  const [exitPrice, setExitPrice] = useState('');
  const [exitReason, setExitReason] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [debriefResult, setDebriefResult] = useState<AIDebriefResult | null>(null);
  const [debriefLoading, setDebriefLoading] = useState(false);
  const [pnlMode, setPnlMode] = useState<'points' | 'percent'>('points');

  const supabase = createClient();

  const exit = parseFloat(exitPrice);
  const pnlPoints = exitPrice && !isNaN(exit) ? (exit - entryPrice) : null;
  const pnlPercent = pnlPoints !== null ? ((pnlPoints / entryPrice) * 100) : null;
  const isWin = pnlPoints !== null ? pnlPoints > 0 : null;

  async function handleClose() {
    if (!exitPrice || !exitReason) { setError('מלא מחיר יציאה וסיבה'); return; }
    setLoading(true);
    setError('');

    const { error: err } = await supabase.from('trade_plans').update({
      status: 'closed',
      exit_price: exit,
      exit_reason: exitReason,
      post_trade_notes: notes.trim() || null,
      closed_at: new Date().toISOString(),
    }).eq('id', tradeId);

    if (err) {
      setError('שגיאה — נסה שוב');
      setLoading(false);
      return;
    }

    setLoading(false);

    // Auto-trigger AI debrief
    setDebriefLoading(true);
    try {
      const tradeData: TradeForDebrief = {
        id: tradeId, strategy, entry_price: entryPrice,
        stop_loss: stopLoss, take_profit: takeProfit,
        rr_ratio: rrRatio, emotional_state: emotionalState,
        trade_reason: tradeReason,
        exit_price: exit, exit_reason: exitReason,
        post_trade_notes: notes.trim(),
      };
      const fd = new FormData();
      fd.append('trade', JSON.stringify({ ...tradeData, status: 'closed', exit_price: exit }));
      if (notes.trim()) fd.append('description', notes.trim());
      const res = await fetch('/api/ai-debrief', { method: 'POST', body: fd });
      if (res.ok) {
        const data = await res.json();
        setDebriefResult(data);
        onDebrief?.(data);
      }
    } catch {
      // debrief failed silently — trade was still closed
    } finally {
      setDebriefLoading(false);
      // onClosed is called only after user dismisses the debrief
    }
  }

  if (debriefLoading) {
    return (
      <div className="pt-4 flex flex-col items-center gap-3 animate-fade-in">
        <div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin"
          style={{ borderColor: 'var(--color-tg-primary)', borderTopColor: 'transparent' }} />
        <p className="text-sm text-tg-text-2">מנתח את העסקה עם AI...</p>
      </div>
    );
  }

  if (debriefResult) {
    return (
      <div className="flex flex-col gap-3 pt-3 border-t border-tg-border animate-fade-in">
        <AIDebriefView result={debriefResult} />
        <button
          onClick={onClosed}
          className="w-full py-2.5 rounded-xl text-sm font-semibold mt-2"
          style={{
            background: 'var(--color-tg-primary-muted)',
            color: 'var(--color-tg-primary)',
            border: '1px solid rgba(0,210,210,0.3)',
          }}>
          סגור וחזור לרשימה
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 animate-fade-in">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-tg-muted">מחיר יציאה *</label>
        <div className="flex items-center gap-2">
          <input type="number" step="any" placeholder="0.00" value={exitPrice}
            onChange={(e) => setExitPrice(e.target.value)}
            className="flex-1 h-10 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary"
            style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)' }}
          />
          {pnlPoints !== null && (
            <div className="flex items-center gap-1">
              <div className="px-2.5 py-1.5 rounded-xl text-sm font-bold shrink-0"
                style={{
                  background: isWin ? 'var(--color-tg-success-muted)' : 'var(--color-tg-danger-muted)',
                  color: isWin ? 'var(--color-tg-success)' : 'var(--color-tg-danger)',
                }}>
                {isWin ? '+' : ''}{pnlMode === 'points' ? pnlPoints.toFixed(2) + ' נק׳' : pnlPercent!.toFixed(2) + '%'}
              </div>
              <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-tg-border)' }}>
                <button
                  onClick={() => setPnlMode('points')}
                  className="px-2 py-1 text-[10px] font-semibold transition-all"
                  style={{
                    background: pnlMode === 'points' ? 'var(--color-tg-primary-muted)' : 'transparent',
                    color: pnlMode === 'points' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                  }}>
                  נק׳
                </button>
                <button
                  onClick={() => setPnlMode('percent')}
                  className="px-2 py-1 text-[10px] font-semibold transition-all"
                  style={{
                    background: pnlMode === 'percent' ? 'var(--color-tg-primary-muted)' : 'transparent',
                    color: pnlMode === 'percent' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                  }}>
                  %
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-tg-muted">סיבת יציאה *</label>
        <div className="flex flex-wrap gap-1.5">
          {EXIT_REASONS.map((r) => (
            <button key={r} onClick={() => setExitReason(r)}
              className="px-2.5 py-1 rounded-full text-xs border transition-all"
              style={{
                background: exitReason === r ? 'var(--color-tg-primary-muted)' : 'var(--color-tg-surface-2)',
                borderColor: exitReason === r ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                color: exitReason === r ? 'var(--color-tg-primary)' : 'var(--color-tg-text-2)',
              }}>
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-tg-muted">מה קרה? (יופיע בניתוח AI)</label>
        <textarea rows={2}
          placeholder="תאר את ביצוע העסקה — הוזזת Stop? פחד? ביצעת לפי התוכנית?"
          value={notes} onChange={(e) => setNotes(e.target.value)}
          className="w-full px-3 py-2 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary resize-none"
          style={{ background: 'var(--color-tg-surface-2)' }}
        />
      </div>

      {error && <p className="text-xs" style={{ color: 'var(--color-tg-danger)' }}>{error}</p>}

      <Button fullWidth onClick={handleClose} loading={loading}
        variant={isWin === false ? 'danger' : 'primary'}>
        סגור עסקה + קבל ניתוח AI
      </Button>
    </div>
  );
}

export function AIDebriefView({ result }: { result: AIDebriefResult }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-tg-text flex items-center gap-1.5"><Bot size={14} /> משוב AI על העסקה</p>
        {result.score !== undefined && (
          <span className="text-lg font-bold"
            style={{ color: result.score >= 70 ? 'var(--color-tg-success)' : result.score >= 40 ? 'var(--color-tg-warning)' : 'var(--color-tg-danger)' }}>
            {result.score}/100
          </span>
        )}
      </div>

      {([
        ['סיכום', result.overall],
        ['איכות כניסה', result.entry_quality],
        ['ניהול סיכונים', result.risk_management],
        ['ביצוע', result.execution],
        ['מצב רגשי', result.emotional],
        ['לקחים לפעם הבאה', result.lessons],
      ] as [string, string | undefined][]).filter(([, v]) => v).map(([label, value]) => (
        <div key={label} className="rounded-xl p-3"
          style={{ background: 'var(--color-tg-surface-2)' }}>
          <p className="text-[10px] font-bold text-tg-muted mb-1 uppercase tracking-wide">{label}</p>
          <p className="text-xs leading-relaxed text-tg-text">{value}</p>
        </div>
      ))}
    </div>
  );
}

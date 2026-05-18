'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';

interface CloseTradeProps {
  tradeId: string;
  entryPrice: number;
  strategy: string;
  onClosed: () => void;
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

export default function CloseTrade({ tradeId, entryPrice, strategy, onClosed }: CloseTradeProps) {
  const [open, setOpen] = useState(false);
  const [exitPrice, setExitPrice] = useState('');
  const [exitReason, setExitReason] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const supabase = createClient();

  const pnlPoints = exitPrice && entryPrice
    ? (parseFloat(exitPrice) - entryPrice).toFixed(2)
    : null;
  const isWin = pnlPoints !== null ? parseFloat(pnlPoints) > 0 : null;

  async function handleClose() {
    if (!exitPrice || !exitReason) { setError('מלא מחיר יציאה וסיבה'); return; }
    setLoading(true);
    setError('');

    const { error: err } = await supabase.from('trade_plans').update({
      status: 'closed',
      exit_price: parseFloat(exitPrice),
      exit_reason: exitReason,
      post_trade_notes: notes.trim() || null,
      closed_at: new Date().toISOString(),
    }).eq('id', tradeId);

    if (err) {
      setError('שגיאה — נסה שוב');
      setLoading(false);
    } else {
      setOpen(false);
      onClosed();
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full py-2 rounded-xl text-sm font-semibold transition-all active:scale-95"
        style={{ background: 'var(--color-tg-danger-muted)', color: 'var(--color-tg-danger)', border: '1px solid var(--color-tg-danger)30' }}
      >
        סגור עסקה
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 pt-3 border-t border-tg-border animate-fade-in">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-tg-text">סגירת עסקה — {strategy}</p>
        <button onClick={() => setOpen(false)} className="text-tg-muted text-xs">ביטול</button>
      </div>

      {/* Exit price */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-tg-muted">מחיר יציאה *</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            step="any"
            placeholder="0.00"
            value={exitPrice}
            onChange={(e) => setExitPrice(e.target.value)}
            className="flex-1 h-10 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary"
            style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)' }}
          />
          {pnlPoints !== null && (
            <div className="px-3 py-1.5 rounded-xl text-sm font-bold shrink-0"
              style={{
                background: isWin ? 'var(--color-tg-success-muted)' : 'var(--color-tg-danger-muted)',
                color: isWin ? 'var(--color-tg-success)' : 'var(--color-tg-danger)',
              }}>
              {isWin ? '+' : ''}{pnlPoints} נק׳
            </div>
          )}
        </div>
      </div>

      {/* Exit reason */}
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

      {/* Notes */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-tg-muted">מה קרה בעסקה? (אופציונלי)</label>
        <textarea
          rows={2}
          placeholder="תאר את ביצוע העסקה, האם הוזזו Stop/TP, מה חשבת..."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full px-3 py-2 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary resize-none"
          style={{ background: 'var(--color-tg-surface-2)' }}
        />
      </div>

      {error && (
        <p className="text-xs text-tg-danger px-2">{error}</p>
      )}

      <Button fullWidth onClick={handleClose} loading={loading}
        variant={isWin === false ? 'danger' : 'primary'}>
        {isWin === true ? '✓ סגור ברווח' : isWin === false ? 'סגור בהפסד' : 'סגור עסקה'}
      </Button>
    </div>
  );
}

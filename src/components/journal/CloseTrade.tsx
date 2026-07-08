'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import { Bot, Target, BarChart3, ShieldCheck } from 'lucide-react';
import { formatPnlIls, formatPnlPoints } from '@/lib/utils';

export interface ScoreCategory {
  score: number;
  max: number;
  details: string[];
}

export interface ScoreBreakdown {
  planning: ScoreCategory;
  strategyAdherence: ScoreCategory;
  discipline: ScoreCategory;
}

export interface ScoreOutcome {
  points: number;
  amount: number | null;
  currency: string | null;
}

export interface AIDebriefResult {
  summary?: string;
  worked?: string;
  improve?: string;
  lesson?: string;
  score?: number;
  breakdown?: ScoreBreakdown;
  outcome?: ScoreOutcome;
  documented?: boolean;
  correctedFlags?: string[];
  error?: string;
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
  followed_plan: boolean;
  kept_sl: boolean;
  proper_size: boolean;
  moved_sl: boolean;
  exited_early: boolean;
  fomo_entry: boolean;
  revenge_trade: boolean;
  pnl_amount: number | null;
  pnl_currency: string | null;
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
  direction: 'long' | 'short';
  units: number | null;
  pointValue: number | null;
  pnlCurrency: string | null;
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
  emotionalState, strategy, tradeReason, direction, units, pointValue, pnlCurrency, onClosed, onDebrief
}: CloseTradeProps) {
  const [exitPrice, setExitPrice] = useState('');
  const [exitReason, setExitReason] = useState('');
  const [followedPlan, setFollowedPlan] = useState(true);
  const [movedSl, setMovedSl] = useState(false);
  const [exitedEarly, setExitedEarly] = useState(false);
  const [fomoEntry, setFomoEntry] = useState(false);
  const [revengeTrade, setRevengeTrade] = useState(false);
  const [actualPnl, setActualPnl] = useState('');
  const [actualPnlCurrency, setActualPnlCurrency] = useState<'₪' | '$'>((pnlCurrency as '₪' | '$') ?? '₪');
  const [postTradeNotes, setPostTradeNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [debriefResult, setDebriefResult] = useState<AIDebriefResult | null>(null);
  const [debriefLoading, setDebriefLoading] = useState(false);
  const [pnlMode, setPnlMode] = useState<'points' | 'percent'>('points');

  const supabase = createClient();

  const exit = parseFloat(exitPrice);
  const hasExit = exitPrice !== '' && !isNaN(exit);
  const pnlPoints = hasExit
    ? (direction === 'long' ? exit - entryPrice : entryPrice - exit)
    : null;
  const pnlPercent = pnlPoints !== null ? ((pnlPoints / entryPrice) * 100) : null;

  const calculatedAmount = pnlPoints !== null && units != null
    ? Math.round(pnlPoints * units * (pointValue ?? 1) * 100) / 100
    : null;

  const actualPnlNum = parseFloat(actualPnl);
  const hasActualPnl = actualPnl.trim() !== '' && !isNaN(actualPnlNum);

  const finalAmount = hasActualPnl ? actualPnlNum : calculatedAmount;
  const finalCurrency = hasActualPnl ? actualPnlCurrency : pnlCurrency;
  const isWin = finalAmount !== null ? finalAmount > 0 : (pnlPoints !== null ? pnlPoints > 0 : null);

  async function handleClose() {
    if (!exitPrice || !exitReason) { setError('מלא מחיר יציאה וסיבה'); return; }
    setLoading(true);
    setError('');

    const pnlAmount = finalAmount;
    const pnlCurrencyValue = pnlAmount != null ? (finalCurrency ?? '₪') : null;
    const notesValue = postTradeNotes.trim() || null;

    // kept_sl / proper_size are legacy columns retained for the AI-debrief score formula;
    // kept_sl mirrors the "moved SL" toggle. proper_size defaults to true since position
    // sizing is now committed at entry-plan time via the units/risk fields.
    const keptSl = !movedSl;
    const properSize = true;

    const { error: err } = await supabase.from('trade_plans').update({
      status: 'closed',
      exit_price: exit,
      exit_reason: exitReason,
      closed_at: new Date().toISOString(),
      pnl_amount: pnlAmount,
      pnl_currency: pnlCurrencyValue,
      actual_pnl: hasActualPnl ? actualPnlNum : calculatedAmount,
      followed_plan: followedPlan,
      kept_sl: keptSl,
      proper_size: properSize,
      moved_sl: movedSl,
      exited_early: exitedEarly,
      fomo_entry: fomoEntry,
      revenge_trade: revengeTrade,
      post_trade_notes: notesValue,
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
        post_trade_notes: notesValue ?? '',
        followed_plan: followedPlan,
        kept_sl: keptSl,
        proper_size: properSize,
        moved_sl: movedSl,
        exited_early: exitedEarly,
        fomo_entry: fomoEntry,
        revenge_trade: revengeTrade,
        pnl_amount: pnlAmount,
        pnl_currency: pnlCurrencyValue,
      };
      const fd = new FormData();
      fd.append('trade', JSON.stringify({ ...tradeData, status: 'closed', exit_price: exit }));
      const res = await fetch('/api/ai-debrief', { method: 'POST', body: fd });
      if (res.ok) {
        const data = await res.json();
        setDebriefResult(data);
        onDebrief?.(data);
        if (typeof data.score === 'number') {
          await supabase.from('trade_plans').update({ plan_score: data.score }).eq('id', tradeId);
        }
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
        <div className="flex items-center gap-2 flex-wrap">
          <input type="number" step="any" placeholder="0.00" value={exitPrice}
            onChange={(e) => setExitPrice(e.target.value)}
            className="flex-1 min-w-0 h-10 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary"
            style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)' }}
          />
          <div className="flex items-center gap-1">
            {pnlPoints !== null && (
              <div className="px-2.5 py-1.5 rounded-xl text-sm font-bold shrink-0"
                style={{
                  background: isWin ? 'var(--color-tg-success-muted)' : 'var(--color-tg-danger-muted)',
                  color: isWin ? 'var(--color-tg-success)' : 'var(--color-tg-danger)',
                }}>
                {isWin ? '+' : ''}{pnlMode === 'points' ? pnlPoints.toFixed(2) + ' נק׳' : pnlPercent!.toFixed(2) + '%'}
              </div>
            )}
            <div className="flex rounded-lg overflow-hidden shrink-0" style={{ border: '1px solid var(--color-tg-border)' }}>
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

      {calculatedAmount !== null && (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-tg-muted">PnL בפועל (אופציונלי)</label>
          <div className="flex items-center gap-2">
            <input type="number" step="any" placeholder={calculatedAmount.toFixed(2)} value={actualPnl}
              onChange={(e) => setActualPnl(e.target.value)}
              className="flex-1 h-10 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary"
              style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)' }}
            />
            <div className="flex rounded-lg overflow-hidden shrink-0" style={{ border: '1px solid var(--color-tg-border)' }}>
              <button
                onClick={() => setActualPnlCurrency('₪')}
                className="px-2 py-1 text-[10px] font-semibold transition-all"
                style={{
                  background: actualPnlCurrency === '₪' ? 'var(--color-tg-primary-muted)' : 'transparent',
                  color: actualPnlCurrency === '₪' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                }}>
                ₪
              </button>
              <button
                onClick={() => setActualPnlCurrency('$')}
                className="px-2 py-1 text-[10px] font-semibold transition-all"
                style={{
                  background: actualPnlCurrency === '$' ? 'var(--color-tg-primary-muted)' : 'transparent',
                  color: actualPnlCurrency === '$' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                }}>
                $
              </button>
            </div>
          </div>
          <p className="text-[10px] text-tg-muted">אם שונה מהחישוב האוטומטי (עמלות, סליפג&apos;)</p>
        </div>
      )}

      <Card padding="sm" className="flex flex-col gap-0.5">
        <p className="text-xs font-semibold text-tg-text flex items-center gap-1.5 pb-1">
          <ShieldCheck size={14} /> רשימת משמעת
        </p>
        <DisciplineToggle
          label="פעלתי לפי התוכנית"
          value={followedPlan}
          onChange={setFollowedPlan}
        />
        <DisciplineToggle
          label="הזזתי Stop Loss"
          value={movedSl}
          onChange={setMovedSl}
          violation
        />
        <DisciplineToggle
          label="יצאתי מוקדם"
          value={exitedEarly}
          onChange={setExitedEarly}
          violation
        />
        <DisciplineToggle
          label="כניסת FOMO"
          value={fomoEntry}
          onChange={setFomoEntry}
          violation
        />
        <DisciplineToggle
          label="Revenge Trade"
          value={revengeTrade}
          onChange={setRevengeTrade}
          violation
        />
      </Card>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label className="text-xs text-tg-muted">מהלך העסקה / הערות (אופציונלי)</label>
          {postTradeNotes.length > 0 && (
            <span className="text-[10px] text-tg-muted" style={{ fontWeight: 500 }}>
              {postTradeNotes.length}/1500
            </span>
          )}
        </div>
        <textarea
          dir="rtl"
          rows={3}
          maxLength={1500}
          value={postTradeNotes}
          onChange={(e) => setPostTradeNotes(e.target.value)}
          placeholder="לדוגמה: העסקה נסגרה בסטופ אחרי ציוץ שהקריס את השוק..."
          className="w-full px-3 py-2.5 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary resize-none leading-relaxed"
          style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)', fontWeight: 500 }}
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
  const rows = ([
    ['סיכום', result.summary],
    ['מה עבד', result.worked],
    ['מה לשפר', result.improve],
    ['לקח מרכזי', result.lesson],
  ] as [string, string | undefined][]).filter(([, v]) => v);

  const scoreColor = result.score === undefined
    ? 'var(--color-tg-muted)'
    : result.score >= 70 ? 'var(--color-tg-success)'
    : result.score >= 50 ? 'var(--color-tg-warning)'
    : 'var(--color-tg-danger)';

  const outcome = result.outcome;
  const outcomePoints = outcome
    ? `${outcome.points >= 0 ? '+' : '-'}${formatPnlPoints(outcome.points)}`
    : null;
  const outcomeAmount = outcome?.amount != null
    ? formatPnlIls(outcome.amount, outcome.currency ?? '₪')
    : null;

  const breakdownCategories: [string, number, number][] | null = result.breakdown
    ? result.breakdown.strategyAdherence.max > 0
      ? [
          ['תכנון', result.breakdown.planning.score, result.breakdown.planning.max],
          ['נאמנות לאסטרטגיה', result.breakdown.strategyAdherence.score, result.breakdown.strategyAdherence.max],
          ['משמעת', result.breakdown.discipline.score, result.breakdown.discipline.max],
        ]
      : [
          ['תכנון', result.breakdown.planning.score, result.breakdown.planning.max],
          ['משמעת', result.breakdown.discipline.score, result.breakdown.discipline.max],
        ]
    : null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-bold text-tg-text flex items-center gap-1.5"><Bot size={14} /> משוב AI על העסקה</p>

      {result.score !== undefined && (
        <div className="flex items-center justify-between rounded-xl p-3"
          style={{ background: 'var(--color-tg-surface-2)', border: `1px solid ${scoreColor}` }}>
          <span className="text-sm font-semibold flex items-center gap-1.5" style={{ color: scoreColor }}>
            <Target size={14} /> ציון תהליך
            {result.documented && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
                style={{ background: 'var(--color-tg-primary-muted)', color: 'var(--color-tg-primary)' }}>
                ⭐ תועד
              </span>
            )}
          </span>
          <span className="text-2xl font-bold" style={{ color: scoreColor }}>{result.score}/100</span>
        </div>
      )}

      {breakdownCategories && (
        <div className="grid grid-cols-2 gap-1.5">
          {breakdownCategories.map(([label, value, max]) => (
            <div key={label} className="flex items-center justify-between rounded-lg px-2.5 py-1.5"
              style={{ background: 'var(--color-tg-surface-2)' }}>
              <span className="text-[11px] text-tg-text-2">{label}</span>
              <span className="text-xs font-bold text-tg-text">{value}/{max}</span>
            </div>
          ))}
        </div>
      )}

      {outcomePoints && (
        <div className="flex items-center justify-between px-1">
          <span className="text-xs text-tg-muted flex items-center gap-1">
            <BarChart3 size={12} /> תוצאה
          </span>
          <span className="text-xs font-semibold text-tg-text-2">
            {outcomePoints}{outcomeAmount ? ` (${outcomeAmount})` : ''}
          </span>
        </div>
      )}

      {rows.length > 0 ? rows.map(([label, value]) => (
        <div key={label} className="rounded-xl p-3"
          style={{ background: 'var(--color-tg-surface-2)' }}>
          <p className="text-[10px] font-bold text-tg-muted mb-1 uppercase tracking-wide">{label}</p>
          <p className="text-xs leading-relaxed text-tg-text">{value}</p>
        </div>
      )) : (
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-tg-muted)' }}>
          {result.error ?? 'לא התקבל ניתוח מפורט עבור עסקה זו — ייתכן שהשירות היה עמוס. נסה לסגור עסקה נוספת כדי לקבל ניתוח חדש.'}
        </p>
      )}
    </div>
  );
}

function DisciplineToggle({ label, value, onChange, violation = false }: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  violation?: boolean;
}) {
  const trackColor = violation
    ? (value ? 'var(--color-tg-danger)' : 'var(--color-tg-border)')
    : (value ? 'var(--color-tg-success)' : 'var(--color-tg-danger)');
  return (
    <div className="flex items-center justify-between gap-2 py-2">
      <p className="text-sm text-tg-text-2 flex-1">{label}</p>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className="relative w-11 h-6 rounded-full shrink-0 transition-colors"
        style={{ background: trackColor }}
      >
        <span
          className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
          style={{ left: value ? 'calc(100% - 22px)' : '2px' }}
        />
      </button>
    </div>
  );
}

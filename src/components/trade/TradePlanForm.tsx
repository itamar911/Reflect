'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Check, AlertTriangle } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { validateTradePlan, DEFAULT_PRESET_RULES } from '@/lib/validators/RulesetValidator';
import { calcRR } from '@/lib/utils';
import ValidationResultBanner from './ValidationResultBanner';
import EmotionalStateSlider from './EmotionalStateSlider';
import ConfidenceLevelSlider from './ConfidenceLevelSlider';
import Button from '@/components/ui/Button';
import Select from '@/components/ui/Select';
import type { TradePlanInput, PresetRules, RulesetValidationResult, TradeStrategy, PnlCurrency, Timeframe } from '@/lib/types';

const STRATEGIES: TradeStrategy[] = [
  'Breakout', 'Trend Follow', 'Reversal', 'Range', 'Custom',
  'ICT', 'SMC', 'VWAP', 'Supply & Demand', 'Price Action', 'Scalping',
  'Gap & Go', 'Elliott Wave', 'Fibonacci', 'Moving Average', 'RSI Divergence', 'Order Flow',
];

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '4H', 'Daily', 'Weekly'];

const PRE_TRADE_CHECKLIST = [
  'בדקתי R:R',
  'הגדרתי Stop Loss',
  'גודל הפוזיציה תואם לסיכון שהגדרתי',
  'אין לי עסקאות פתוחות סותרות',
];

const REASON_TAGS = [
  'בריקאאוט מתנגדות',
  'תנועת מומנטום',
  'תיקון לתמיכה',
  'דפוס גרף',
  'פריצת נפח',
  'רמת פיבונאצ\'י',
  'כניסה ב-VWAP',
  'Trend Follow בטרנד ברור',
  'היפוך בתמיכה מרכזית',
  'Range — גבול ערוץ',
  'אינדיקטור מאשר כיוון',
];

const EMPTY_FORM: TradePlanInput = {
  strategy: '',
  symbol: '',
  entry_price: '',
  stop_loss: '',
  take_profit: '',
  trade_reason: '',
  emotional_state: 3,
  confidence_level: 3,
  timeframe: '',
  direction: null,
  units: '',
  point_value: '1',
};

type FormState = 'empty' | 'editing' | 'validating' | 'warning' | 'blocked' | 'success' | 'error';

interface TradePlanFormProps {
  userId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /** A "warn"-action personal rule that's currently triggered — shown as a persistent banner, doesn't block submission. */
  initialWarning?: string | null;
}

export default function TradePlanForm({ userId, isOpen, onClose, onSuccess, initialWarning }: TradePlanFormProps) {
  const [form, setForm] = useState<TradePlanInput>(EMPTY_FORM);
  const [formState, setFormState] = useState<FormState>('empty');
  const [validationResult, setValidationResult] = useState<RulesetValidationResult | null>(null);
  const [presetRules, setPresetRules] = useState<PresetRules | null>(null);
  const [todayCount, setTodayCount] = useState(0);
  const [lossCount, setLossCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [todayLossAmount, setTodayLossAmount] = useState(0);
  const [personalStrategies, setPersonalStrategies] = useState<string[]>([]);
  const [pnlMode, setPnlMode] = useState<'points' | 'percent'>('points');
  const [currency, setCurrency] = useState<PnlCurrency>('₪');
  const [pnlFieldsError, setPnlFieldsError] = useState(false);
  const [slInput, setSlInput] = useState('');
  const [tpInput, setTpInput] = useState('');
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set());
  const supabase = createClient();

  function toggleChecklistItem(item: string) {
    setCheckedItems((prev) => {
      const next = new Set(prev);
      if (next.has(item)) {
        next.delete(item);
      } else {
        next.add(item);
      }
      return next;
    });
  }

  // Restore saved TP/SL input unit preference
  useEffect(() => {
    const saved = localStorage.getItem('trade-plan-pnl-mode');
    if (saved === 'points' || saved === 'percent') setPnlMode(saved);
    const savedCurrency = localStorage.getItem('trade-plan-pnl-currency');
    if (savedCurrency === '₪' || savedCurrency === '$') setCurrency(savedCurrency);
  }, []);

  function changePnlMode(mode: 'points' | 'percent') {
    setPnlMode(mode);
    localStorage.setItem('trade-plan-pnl-mode', mode);
  }

  function changeCurrency(c: PnlCurrency) {
    setCurrency(c);
    localStorage.setItem('trade-plan-pnl-currency', c);
  }

  const entryNum = parseFloat(form.entry_price);
  const hasEntry = form.entry_price !== '' && !isNaN(entryNum);

  const unitsNum = parseFloat(form.units);
  const hasUnits = form.units.trim() !== '' && !isNaN(unitsNum) && unitsNum > 0;

  const pointValueParsed = parseFloat(form.point_value);
  const pointValueNum = form.point_value.trim() !== '' && !isNaN(pointValueParsed) && pointValueParsed > 0
    ? pointValueParsed
    : 1;

  // נק׳ mode: the field holds the actual target price directly (no conversion).
  // % mode: the field holds a percentage offset from the entry price —
  // SL = entry × (1 − pct/100), TP = entry × (1 + pct/100).
  function inputToPrice(inputStr: string, kind: 'sl' | 'tp'): number | null {
    if (!hasEntry || inputStr.trim() === '') return null;
    const val = parseFloat(inputStr);
    if (isNaN(val)) return null;
    if (pnlMode === 'points') return val;
    return kind === 'sl' ? entryNum * (1 - val / 100) : entryNum * (1 + val / 100);
  }

  const slPrice = inputToPrice(slInput, 'sl');
  const tpPrice = inputToPrice(tpInput, 'tp');

  function fmtPrice(n: number): string {
    return parseFloat(n.toFixed(6)).toString();
  }

  const loadContext = useCallback(async () => {
    setLoading(true);
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

    const [rulesRes, todayRes, personalRes] = await Promise.all([
      supabase.from('preset_rules').select('*').eq('user_id', userId).single(),
      supabase
        .from('trade_plans')
        .select('id, status, entry_price, exit_price, stop_loss')
        .eq('user_id', userId)
        .gte('submitted_at', todayStart),
      supabase.from('personal_strategies').select('name').eq('user_id', userId).order('created_at'),
    ]);

    if (personalRes.data) setPersonalStrategies(personalRes.data.map((s) => s.name));

    if (rulesRes.data) setPresetRules(rulesRes.data as PresetRules);
    if (todayRes.data) {
      setTodayCount(todayRes.data.length);

      // Approximate daily loss: sum of (entry - exit) for closed losing trades
      let lossSum = 0;
      for (const t of todayRes.data) {
        if (t.status === 'closed' && t.exit_price && t.entry_price && t.exit_price < t.entry_price) {
          lossSum += Math.abs(t.entry_price - t.exit_price);
        }
      }
      setTodayLossAmount(lossSum);
    }

    // Count recent consecutive losses
    const recentRes = await supabase
      .from('trade_plans')
      .select('status, exit_price, stop_loss')
      .eq('user_id', userId)
      .eq('status', 'closed')
      .order('closed_at', { ascending: false })
      .limit(10);

    if (recentRes.data) {
      let losses = 0;
      for (const t of recentRes.data) {
        if (t.exit_price && t.stop_loss && t.exit_price <= t.stop_loss) {
          losses++;
        } else {
          break;
        }
      }
      setLossCount(losses);
    }

    setLoading(false);
  }, [userId]);

  useEffect(() => {
    if (isOpen) loadContext();
  }, [isOpen, loadContext]);


  const rr = hasEntry && slPrice !== null && tpPrice !== null
    ? calcRR(entryNum, slPrice, tpPrice)
    : null;

  const isFormFilled =
    form.symbol.trim() !== '' &&
    form.direction !== null &&
    form.strategy !== '' &&
    hasEntry &&
    slPrice !== null &&
    tpPrice !== null &&
    hasUnits &&
    form.trade_reason.trim() !== '';

  const step1Done = form.symbol.trim() !== '' && form.direction !== null && form.strategy !== '';
  const step2Done = hasEntry && slPrice !== null && tpPrice !== null && hasUnits;

  const activeStep = useMemo(() => {
    if (!step1Done) return 1;
    if (!step2Done) return 2;
    return 4;
  }, [step1Done, step2Done]);

  async function handleValidate() {
    if (!hasUnits) { setPnlFieldsError(true); return; }
    setPnlFieldsError(false);
    if (!isFormFilled || slPrice === null || tpPrice === null) return;
    setFormState('validating');

    await new Promise((r) => setTimeout(r, 800)); // simulate validation delay

    const rules = presetRules ?? ({ ...DEFAULT_PRESET_RULES, id: '', user_id: userId, created_at: '', updated_at: '' } as PresetRules);
    const planForValidation: TradePlanInput = { ...form, stop_loss: fmtPrice(slPrice), take_profit: fmtPrice(tpPrice) };
    const result = validateTradePlan(planForValidation, rules, todayCount, lossCount, todayLossAmount);
    setValidationResult(result);
    setFormState(result.status === 'valid' ? 'editing' : result.status);
  }

  async function handleSubmit() {
    if (!hasUnits) { setPnlFieldsError(true); return; }
    setPnlFieldsError(false);
    if (!isFormFilled || slPrice === null || tpPrice === null) return;

    // Re-validate silently
    const rules = presetRules ?? ({ ...DEFAULT_PRESET_RULES, id: '', user_id: userId, created_at: '', updated_at: '' } as PresetRules);
    const planForValidation: TradePlanInput = { ...form, stop_loss: fmtPrice(slPrice), take_profit: fmtPrice(tpPrice) };
    const result = validateTradePlan(planForValidation, rules, todayCount, lossCount, todayLossAmount);
    if (result.status === 'blocked') {
      setValidationResult(result);
      setFormState('blocked');
      return;
    }

    setSubmitLoading(true);
    const entry = entryNum;
    const sl = slPrice;
    const tp = tpPrice;

    const { error } = await supabase.from('trade_plans').insert({
      user_id: userId,
      strategy: form.strategy,
      symbol: form.symbol.trim() || null,
      direction: form.direction,
      entry_price: entry,
      stop_loss: sl,
      take_profit: tp,
      rr_ratio: calcRR(entry, sl, tp),
      trade_reason: form.trade_reason.trim(),
      emotional_state: form.emotional_state,
      confidence_level: form.confidence_level,
      timeframe: form.timeframe || null,
      status: 'open',
      units: unitsNum,
      point_value: pointValueNum,
      pnl_currency: currency,
    });

    if (error) {
      setFormState('error');
    } else {
      setFormState('success');
      setTimeout(() => {
        setForm(EMPTY_FORM);
        setSlInput('');
        setTpInput('');
        setValidationResult(null);
        setPnlFieldsError(false);
        setCheckedItems(new Set());
        setFormState('empty');
        onSuccess();
        onClose();
      }, 1800);
    }
    setSubmitLoading(false);
  }

  function addTag(tag: string) {
    const current = form.trade_reason;
    const sep = current.trim() ? ', ' : '';
    setForm({ ...form, trade_reason: current + sep + tag });
    setValidationResult(null);
    if (formState !== 'empty') setFormState('editing');
  }

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Bottom Sheet */}
      <div className="fixed bottom-0 left-0 right-0 z-50 animate-slide-up rounded-t-3xl overflow-hidden"
        style={{ background: 'var(--color-tg-surface)', maxHeight: '90vh' }}>

        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full" style={{ background: 'var(--color-tg-border)' }} />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-tg-border">
          <h2 className="text-base font-semibold text-tg-text">תוכנית עסקה</h2>
          <button onClick={onClose} className="text-tg-muted hover:text-tg-text transition-colors p-1">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Success state */}
        {formState === 'success' && (
          <div className="flex flex-col items-center justify-center py-16 px-4 animate-fade-in">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
              style={{ background: 'var(--color-tg-success-muted)' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-tg-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-tg-text mb-1">תוכנית הוגשה!</h3>
            <p className="text-sm text-tg-text-2 text-center">העסקה נוספה לעיתון שלך. סחר לפי התוכנית.</p>
          </div>
        )}

        {/* Form */}
        {formState !== 'success' && (
          <div className="overflow-y-auto px-4 py-4 flex flex-col gap-4"
            style={{ maxHeight: 'calc(90vh - 100px)' }}>

            {loading && (
              <div className="flex items-center gap-2 text-sm text-tg-muted">
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                טוען חוקים...
              </div>
            )}

            {/* Personal-rule warning (action_type = 'warn') — doesn't block submission */}
            {initialWarning && (
              <div className="flex items-start gap-2 px-4 py-3 rounded-xl text-sm"
                style={{ background: 'var(--color-tg-warning-muted)', color: 'var(--color-tg-warning)', border: '1px solid rgba(0,210,210,0.3)' }}>
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                <span>{initialWarning}</span>
              </div>
            )}

            {/* Validation Banner */}
            {validationResult && formState !== 'validating' && (
              <ValidationResultBanner result={validationResult} />
            )}

            {formState === 'error' && (
              <div className="px-4 py-3 rounded-xl text-sm"
                style={{ background: 'var(--color-tg-danger-muted)', color: 'var(--color-tg-danger)' }}>
                שגיאת שרת — נסה שוב
              </div>
            )}

            {/* Step 1 — Asset, direction & strategy */}
            <FormSection step={1} label="נכס ואסטרטגיה" active={activeStep === 1} done={activeStep > 1}>
              <input
                type="text"
                placeholder="סימול נייר (SPY, EURUSD, AAPL...)"
                value={form.symbol}
                onChange={(e) => { setForm({ ...form, symbol: e.target.value.toUpperCase() }); setValidationResult(null); }}
                className="w-full h-10 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary transition-colors"
                style={{ background: 'var(--color-tg-surface-2)' }}
              />
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => { setForm({ ...form, direction: 'long' }); setValidationResult(null); }}
                  className="h-11 rounded-xl text-sm font-bold border-2 transition-all flex items-center justify-center gap-1.5"
                  style={{
                    background: form.direction === 'long' ? 'var(--color-tg-success-muted)' : 'var(--color-tg-surface-2)',
                    borderColor: form.direction === 'long' ? 'var(--color-tg-success)' : 'var(--color-tg-border)',
                    color: form.direction === 'long' ? 'var(--color-tg-success)' : 'var(--color-tg-muted)',
                  }}
                >
                  Long ▲
                </button>
                <button
                  type="button"
                  onClick={() => { setForm({ ...form, direction: 'short' }); setValidationResult(null); }}
                  className="h-11 rounded-xl text-sm font-bold border-2 transition-all flex items-center justify-center gap-1.5"
                  style={{
                    background: form.direction === 'short' ? 'var(--color-tg-danger-muted)' : 'var(--color-tg-surface-2)',
                    borderColor: form.direction === 'short' ? 'var(--color-tg-danger)' : 'var(--color-tg-border)',
                    color: form.direction === 'short' ? 'var(--color-tg-danger)' : 'var(--color-tg-muted)',
                  }}
                >
                  Short ▼
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {STRATEGIES.map((s) => (
                  <StrategyChip
                    key={s}
                    label={s}
                    selected={form.strategy === s}
                    onClick={() => { setForm({ ...form, strategy: s }); setValidationResult(null); }}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 h-px" style={{ background: 'var(--color-tg-border)' }} />
                <span className="text-[10px] text-tg-muted shrink-0">האסטרטגיות שלי</span>
                <div className="flex-1 h-px" style={{ background: 'var(--color-tg-border)' }} />
              </div>
              {personalStrategies.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {personalStrategies.map((s) => (
                    <StrategyChip
                      key={s}
                      label={s}
                      selected={form.strategy === s}
                      personal
                      onClick={() => { setForm({ ...form, strategy: s }); setValidationResult(null); }}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-tg-muted">לא הוספת אסטרטגיות עדיין — ניתן להוסיף בעמוד האסטרטגיות</p>
              )}
              <Select
                label="Timeframe"
                value={form.timeframe}
                onChange={(e) => { setForm({ ...form, timeframe: e.target.value as Timeframe }); setValidationResult(null); }}
                options={TIMEFRAMES.map((tf) => ({ value: tf, label: tf }))}
                placeholder="בחר Timeframe"
              />
            </FormSection>

            {/* Step 2 — Prices & position sizing */}
            <FormSection step={2} label="מחירים וגודל פוזיציה" active={activeStep === 2} done={activeStep > 2}>
              <div className="flex items-center justify-between">
                <span className="text-xs" style={{ color: 'var(--color-tg-muted)' }}>
                  הזן Stop Loss / Take Profit ב:
                </span>
                <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-tg-border)' }}>
                  <button
                    type="button"
                    onClick={() => changePnlMode('points')}
                    className="px-2.5 py-1 text-[10px] font-semibold transition-all"
                    style={{
                      background: pnlMode === 'points' ? 'var(--color-tg-primary-muted)' : 'transparent',
                      color: pnlMode === 'points' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                    }}>
                    נק׳
                  </button>
                  <button
                    type="button"
                    onClick={() => changePnlMode('percent')}
                    className="px-2.5 py-1 text-[10px] font-semibold transition-all"
                    style={{
                      background: pnlMode === 'percent' ? 'var(--color-tg-primary-muted)' : 'transparent',
                      color: pnlMode === 'percent' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                    }}>
                    %
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <PriceInput
                  label="כניסה"
                  value={form.entry_price}
                  onChange={(v) => { setForm({ ...form, entry_price: v }); setValidationResult(null); }}
                />
                <PriceInput
                  label={`Stop Loss (${pnlMode === 'points' ? 'נק׳' : '%'})`}
                  value={slInput}
                  onChange={(v) => { setSlInput(v); setValidationResult(null); }}
                  danger
                  hint={
                    !hasEntry ? 'הזן מחיר כניסה'
                    : slPrice !== null ? `מחיר: ${fmtPrice(slPrice)}`
                    : undefined
                  }
                />
                <PriceInput
                  label={`Take Profit (${pnlMode === 'points' ? 'נק׳' : '%'})`}
                  value={tpInput}
                  onChange={(v) => { setTpInput(v); setValidationResult(null); }}
                  success
                  hint={
                    !hasEntry ? 'הזן מחיר כניסה'
                    : tpPrice !== null ? `מחיר: ${fmtPrice(tpPrice)}`
                    : undefined
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-end">
                  <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-tg-border)' }}>
                    <button
                      type="button"
                      onClick={() => changeCurrency('₪')}
                      className="px-2 py-0.5 text-[10px] font-semibold transition-all"
                      style={{
                        background: currency === '₪' ? 'var(--color-tg-primary-muted)' : 'transparent',
                        color: currency === '₪' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                      }}>
                      ₪
                    </button>
                    <button
                      type="button"
                      onClick={() => changeCurrency('$')}
                      className="px-2 py-0.5 text-[10px] font-semibold transition-all"
                      style={{
                        background: currency === '$' ? 'var(--color-tg-primary-muted)' : 'transparent',
                        color: currency === '$' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                      }}>
                      $
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-tg-muted">יחידות/חוזים</label>
                    <input
                      type="number"
                      step="any"
                      placeholder="0"
                      value={form.units}
                      onChange={(e) => { setForm({ ...form, units: e.target.value }); setPnlFieldsError(false); }}
                      className="w-full h-10 px-2 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary transition-colors text-center"
                      style={{
                        background: 'var(--color-tg-surface-2)',
                        borderColor: pnlFieldsError && !hasUnits ? 'var(--color-tg-danger)' : 'var(--color-tg-border)',
                      }}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-tg-muted">שווי נקודה ($)</label>
                    <input
                      type="number"
                      step="any"
                      placeholder="1"
                      value={form.point_value}
                      onChange={(e) => setForm({ ...form, point_value: e.target.value })}
                      className="w-full h-10 px-2 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary transition-colors text-center"
                      style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)' }}
                    />
                  </div>
                </div>
              </div>
              <p className="text-[10px] text-tg-muted">
                יחידות/חוזים — שדה חובה. שווי נקודה ($) — אופציונלי, ברירת מחדל 1. נדרשים כדי שהמערכת תחשב עבורך רווח/הפסד ({currency}) בסגירת העסקה
              </p>
              {pnlFieldsError && (
                <div className="px-3 py-2 rounded-xl text-xs animate-fade-in"
                  style={{ background: 'var(--color-tg-danger-muted)', color: 'var(--color-tg-danger)' }}>
                  יש למלא יחידות תקינות כדי להגיש את התוכנית
                </div>
              )}
              {rr !== null && rr > 0 && (
                <div className="flex items-center justify-between px-4 py-2.5 rounded-xl animate-fade-in"
                  style={{
                    background: rr >= 2 ? 'var(--color-tg-success-muted)' : rr >= 1 ? 'var(--color-tg-warning-muted)' : 'var(--color-tg-danger-muted)',
                  }}>
                  <span className="text-sm text-tg-text-2">יחס R:R מחושב</span>
                  <span className="text-sm font-bold"
                    style={{ color: rr >= 2 ? 'var(--color-tg-success)' : rr >= 1 ? 'var(--color-tg-warning)' : 'var(--color-tg-danger)' }}>
                    1:{rr}
                  </span>
                </div>
              )}
            </FormSection>

            {/* Step 3 — Emotional State & Confidence */}
            <FormSection step={3} label="מצב רגשי ורמת ביטחון" active={step1Done && step2Done} done={false}>
              <EmotionalStateSlider
                value={form.emotional_state}
                onChange={(v) => { setForm({ ...form, emotional_state: v }); setValidationResult(null); }}
              />
              <ConfidenceLevelSlider
                value={form.confidence_level}
                onChange={(v) => { setForm({ ...form, confidence_level: v }); setValidationResult(null); }}
              />
            </FormSection>

            {/* Step 4 — Reason & plan */}
            <FormSection step={4} label="סיבת הכניסה ותוכנית" active={activeStep === 4} done={false}>
              <div className="flex flex-wrap gap-1.5">
                {REASON_TAGS.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => addTag(tag)}
                    className="px-2.5 py-1 rounded-full text-xs border transition-all duration-150"
                    style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)', color: 'var(--color-tg-muted)' }}
                  >
                    {tag}
                  </button>
                ))}
              </div>
              <textarea
                rows={2}
                placeholder="תאר מה אתה רואה בגרף..."
                value={form.trade_reason}
                onChange={(e) => { setForm({ ...form, trade_reason: e.target.value }); setValidationResult(null); }}
                className="w-full px-3 py-2.5 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary transition-colors resize-none"
                style={{ background: 'var(--color-tg-surface-2)' }}
              />
              <div className="flex flex-col gap-1.5 mt-1">
                {PRE_TRADE_CHECKLIST.map((item) => {
                  const checked = checkedItems.has(item);
                  return (
                    <button
                      key={item}
                      type="button"
                      onClick={() => toggleChecklistItem(item)}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl text-xs border transition-all text-right"
                      style={{
                        background: checked ? 'var(--color-tg-success-muted)' : 'var(--color-tg-surface-2)',
                        borderColor: checked ? 'var(--color-tg-success)' : 'var(--color-tg-border)',
                        color: checked ? 'var(--color-tg-success)' : 'var(--color-tg-text-2)',
                      }}
                    >
                      <span
                        className="w-4 h-4 rounded shrink-0 flex items-center justify-center"
                        style={{
                          background: checked ? 'var(--color-tg-success)' : 'transparent',
                          border: checked ? 'none' : '1px solid var(--color-tg-border)',
                        }}
                      >
                        {checked && <Check size={11} color="white" />}
                      </span>
                      {item}
                    </button>
                  );
                })}
              </div>
            </FormSection>

            {/* Actions */}
            <div className="flex flex-col gap-2 pb-4">
              {formState !== 'validating' && !validationResult && (
                <Button
                  fullWidth
                  variant="secondary"
                  disabled={!isFormFilled}
                  onClick={handleValidate}
                >
                  בדוק מול החוקים שלי
                </Button>
              )}

              {formState === 'validating' && (
                <Button fullWidth loading disabled>
                  בודק מול חוקי המסחר שלך...
                </Button>
              )}

              {validationResult && formState !== 'validating' && (
                <Button
                  fullWidth
                  disabled={formState === 'blocked' || !isFormFilled}
                  loading={submitLoading}
                  onClick={handleSubmit}
                  variant={formState === 'blocked' ? 'danger' : 'primary'}
                  size="lg"
                >
                  {formState === 'blocked' ? 'עסקה חסומה' : 'הגש תוכנית עסקה'}
                </Button>
              )}

              {!validationResult && (
                <div className="text-center text-xs text-tg-muted mt-1">
                  תכנן לפני שתסחר — עצור, חשוב, הגש
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function StrategyChip({
  label, selected, personal, onClick,
}: {
  label: string;
  selected: boolean;
  personal?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 rounded-full text-sm border transition-all duration-150"
      style={{
        background: selected
          ? personal ? 'var(--color-tg-success-muted)' : 'var(--color-tg-primary-muted)'
          : 'var(--color-tg-surface-2)',
        borderColor: selected
          ? personal ? 'var(--color-tg-success)' : 'var(--color-tg-primary)'
          : 'var(--color-tg-border)',
        color: selected
          ? personal ? 'var(--color-tg-success)' : 'var(--color-tg-primary)'
          : 'var(--color-tg-text-2)',
      }}
    >
      {label}
    </button>
  );
}

function FormSection({
  step, label, active, done, children,
}: {
  step: number;
  label: string;
  active: boolean;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-2xl p-3 transition-all duration-200"
      style={{
        background: active ? 'var(--color-tg-surface-2)' : 'transparent',
        border: active ? '1px solid var(--color-tg-primary)' : '1px solid transparent',
        opacity: !active && !done ? 0.6 : 1,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0"
          style={{
            background: done ? 'var(--color-tg-success)' : active ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
            color: done || active ? 'white' : 'var(--color-tg-muted)',
          }}
        >
          {done ? <Check size={9} /> : step}
        </span>
        <span
          className="text-xs font-semibold"
          style={{ color: active ? 'var(--color-tg-text)' : done ? 'var(--color-tg-text-2)' : 'var(--color-tg-muted)' }}
        >
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function PriceInput({
  label, value, onChange, danger, success, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  danger?: boolean;
  success?: boolean;
  hint?: string;
}) {
  const borderColor = danger
    ? 'var(--color-tg-danger)'
    : success
      ? 'var(--color-tg-success)'
      : 'var(--color-tg-border)';

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium" style={{ color: borderColor }}>
        {label}
      </label>
      <input
        type="number"
        step="any"
        placeholder="0.00"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-10 px-2 rounded-xl text-sm text-tg-text border focus:outline-none transition-colors text-center"
        style={{
          background: 'var(--color-tg-surface-2)',
          borderColor,
        }}
      />
      {hint && (
        <span className="text-[10px] text-center truncate" style={{ color: 'var(--color-tg-muted)' }}>
          {hint}
        </span>
      )}
    </div>
  );
}

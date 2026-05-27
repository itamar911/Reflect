'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { validateTradePlan, DEFAULT_PRESET_RULES } from '@/lib/validators/RulesetValidator';
import { calcRR } from '@/lib/utils';
import ValidationResultBanner from './ValidationResultBanner';
import EmotionalStateSlider from './EmotionalStateSlider';
import Button from '@/components/ui/Button';
import type { TradePlanInput, PresetRules, RulesetValidationResult, TradeStrategy } from '@/lib/types';

const STRATEGIES: TradeStrategy[] = ['Breakout', 'Trend Follow', 'Reversal', 'Range', 'Custom'];

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
  direction: null,
};

type FormState = 'empty' | 'editing' | 'validating' | 'warning' | 'blocked' | 'success' | 'error';

interface TradePlanFormProps {
  userId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function TradePlanForm({ userId, isOpen, onClose, onSuccess }: TradePlanFormProps) {
  const [form, setForm] = useState<TradePlanInput>(EMPTY_FORM);
  const [formState, setFormState] = useState<FormState>('empty');
  const [validationResult, setValidationResult] = useState<RulesetValidationResult | null>(null);
  const [presetRules, setPresetRules] = useState<PresetRules | null>(null);
  const [todayCount, setTodayCount] = useState(0);
  const [lossCount, setLossCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [todayLossAmount, setTodayLossAmount] = useState(0);

  const supabase = createClient();

  const loadContext = useCallback(async () => {
    setLoading(true);
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

    const [rulesRes, todayRes] = await Promise.all([
      supabase.from('preset_rules').select('*').eq('user_id', userId).single(),
      supabase
        .from('trade_plans')
        .select('id, status, entry_price, exit_price, stop_loss')
        .eq('user_id', userId)
        .gte('submitted_at', todayStart),
    ]);

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

  const rr = form.entry_price && form.stop_loss && form.take_profit
    ? calcRR(parseFloat(form.entry_price), parseFloat(form.stop_loss), parseFloat(form.take_profit))
    : null;

  const isFormFilled =
    form.strategy !== '' &&
    form.entry_price !== '' &&
    form.stop_loss !== '' &&
    form.take_profit !== '' &&
    form.trade_reason.trim() !== '';

  const activeStep = useMemo(() => {
    if (!form.strategy) return 1;
    if (!form.entry_price || !form.stop_loss || !form.take_profit) return 2;
    if (!form.trade_reason.trim()) return 3;
    return 4;
  }, [form]);

  async function handleValidate() {
    if (!isFormFilled) return;
    setFormState('validating');

    await new Promise((r) => setTimeout(r, 800)); // simulate validation delay

    const rules = presetRules ?? ({ ...DEFAULT_PRESET_RULES, id: '', user_id: userId, created_at: '', updated_at: '' } as PresetRules);
    const result = validateTradePlan(form, rules, todayCount, lossCount, todayLossAmount);
    setValidationResult(result);
    setFormState(result.status === 'valid' ? 'editing' : result.status);
  }

  async function handleSubmit() {
    if (!isFormFilled) return;

    // Re-validate silently
    const rules = presetRules ?? ({ ...DEFAULT_PRESET_RULES, id: '', user_id: userId, created_at: '', updated_at: '' } as PresetRules);
    const result = validateTradePlan(form, rules, todayCount, lossCount, todayLossAmount);
    if (result.status === 'blocked') {
      setValidationResult(result);
      setFormState('blocked');
      return;
    }

    setSubmitLoading(true);
    const entry = parseFloat(form.entry_price);
    const sl = parseFloat(form.stop_loss);
    const tp = parseFloat(form.take_profit);

    const { error } = await supabase.from('trade_plans').insert({
      user_id: userId,
      strategy: form.strategy,
      symbol: form.symbol.trim() || null,
      entry_price: entry,
      stop_loss: sl,
      take_profit: tp,
      rr_ratio: calcRR(entry, sl, tp),
      trade_reason: form.trade_reason.trim(),
      emotional_state: form.emotional_state,
      status: 'open',
    });

    if (error) {
      setFormState('error');
    } else {
      setFormState('success');
      setTimeout(() => {
        setForm(EMPTY_FORM);
        setValidationResult(null);
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

            {/* Step 1 — Strategy */}
            <FormSection step={1} label="אסטרטגיה" active={activeStep === 1} done={activeStep > 1}>
              <div className="flex flex-wrap gap-2">
                {STRATEGIES.map((s) => (
                  <button
                    key={s}
                    onClick={() => { setForm({ ...form, strategy: s }); setValidationResult(null); }}
                    className="px-3 py-1.5 rounded-full text-sm border transition-all duration-150"
                    style={{
                      background: form.strategy === s ? 'var(--color-tg-primary-muted)' : 'var(--color-tg-surface-2)',
                      borderColor: form.strategy === s ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                      color: form.strategy === s ? 'var(--color-tg-primary)' : 'var(--color-tg-text-2)',
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </FormSection>

            {/* Step 2 — Prices */}
            <FormSection step={2} label="סימול ומחירים" active={activeStep === 2} done={activeStep > 2}>
              <input
                type="text"
                placeholder="סימול נייר (SPY, EURUSD, AAPL...)"
                value={form.symbol}
                onChange={(e) => { setForm({ ...form, symbol: e.target.value.toUpperCase() }); setValidationResult(null); }}
                className="w-full h-10 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary transition-colors"
                style={{ background: 'var(--color-tg-surface-2)' }}
              />
              <div className="grid grid-cols-3 gap-2">
                <PriceInput
                  label="כניסה"
                  value={form.entry_price}
                  onChange={(v) => { setForm({ ...form, entry_price: v }); setValidationResult(null); }}
                />
                <PriceInput
                  label="Stop Loss"
                  value={form.stop_loss}
                  onChange={(v) => { setForm({ ...form, stop_loss: v }); setValidationResult(null); }}
                  danger
                />
                <PriceInput
                  label="Take Profit"
                  value={form.take_profit}
                  onChange={(v) => { setForm({ ...form, take_profit: v }); setValidationResult(null); }}
                  success
                />
              </div>
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

            {/* Step 3 — Reason */}
            <FormSection step={3} label="סיבת הכניסה" active={activeStep === 3} done={activeStep > 3}>
              <textarea
                rows={2}
                placeholder="תאר מה אתה רואה בגרף..."
                value={form.trade_reason}
                onChange={(e) => { setForm({ ...form, trade_reason: e.target.value }); setValidationResult(null); }}
                className="w-full px-3 py-2.5 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary transition-colors resize-none"
                style={{ background: 'var(--color-tg-surface-2)' }}
              />
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
            </FormSection>

            {/* Step 4 — Emotional State */}
            <FormSection step={4} label="מצב רגשי" active={activeStep === 4} done={false}>
              <EmotionalStateSlider
                value={form.emotional_state}
                onChange={(v) => { setForm({ ...form, emotional_state: v }); setValidationResult(null); }}
              />
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
          {done ? '✓' : step}
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
  label, value, onChange, danger, success,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  danger?: boolean;
  success?: boolean;
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
    </div>
  );
}

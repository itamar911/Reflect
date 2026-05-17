'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';
import type { TradingType, ExperienceLevel, Market } from '@/lib/types';

interface WizardData {
  trading_types: TradingType[];
  experience_level: ExperienceLevel;
  default_markets: Market[];
  custom_strategy: string;
  min_rr_ratio: number;
  max_daily_trades: number;
}

const STEPS = 5;

export default function OnboardingWizard({ userId }: { userId: string }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<WizardData>({
    trading_types: ['day'],
    experience_level: 'beginner',
    default_markets: ['stocks'],
    custom_strategy: '',
    min_rr_ratio: 2,
    max_daily_trades: 5,
  });

  function next() { setStep((s) => Math.min(s + 1, STEPS)); }
  function back() { setStep((s) => Math.max(s - 1, 1)); }

  function toggleType(type: TradingType) {
    setData((d) => ({
      ...d,
      trading_types: d.trading_types.includes(type)
        ? d.trading_types.filter((t) => t !== type)
        : [...d.trading_types, type],
    }));
  }

  function toggleMarket(market: Market) {
    setData((d) => ({
      ...d,
      default_markets: d.default_markets.includes(market)
        ? d.default_markets.filter((m) => m !== market)
        : [...d.default_markets, market],
    }));
  }

  async function finish() {
    if (data.trading_types.length === 0 || data.default_markets.length === 0) return;
    setLoading(true);
    const supabase = createClient();

    const customStrategies = data.custom_strategy.trim()
      ? [data.custom_strategy.trim()]
      : [];

    await supabase.from('profiles').update({
      trading_type: data.trading_types[0],
      experience_level: data.experience_level,
      default_market: data.default_markets[0],
      onboarding_completed: true,
      updated_at: new Date().toISOString(),
    }).eq('id', userId);

    if (customStrategies.length > 0) {
      await supabase.from('preset_rules').update({
        min_rr_ratio: data.min_rr_ratio,
        max_daily_trades: data.max_daily_trades,
        allowed_strategies: ['Breakout', 'Trend Follow', 'Reversal', 'Range', 'Futures', 'Custom', ...customStrategies],
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId);
    } else {
      await supabase.from('preset_rules').update({
        min_rr_ratio: data.min_rr_ratio,
        max_daily_trades: data.max_daily_trades,
        updated_at: new Date().toISOString(),
      }).eq('user_id', userId);
    }

    router.push('/dashboard');
  }

  const progress = (step / STEPS) * 100;
  const canNext = step === 1 ? data.trading_types.length > 0
    : step === 3 ? data.default_markets.length > 0
    : true;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{ background: 'var(--color-tg-bg)' }}>
      <div className="w-full max-w-md animate-fade-in">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl mb-3"
            style={{ background: 'var(--color-tg-primary)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2.5">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
              <polyline points="16 7 22 7 22 13" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-tg-text">׳”׳’׳“׳¨׳× ׳₪׳¨׳•׳₪׳™׳ ׳׳¡׳—׳¨</h1>
          <p className="text-sm text-tg-text-2 mt-1">׳©׳׳‘ {step} ׳׳×׳•׳ {STEPS}</p>
        </div>

        {/* Progress bar */}
        <div className="h-1 rounded-full mb-8 overflow-hidden" style={{ background: 'var(--color-tg-surface-2)' }}>
          <div className="h-full rounded-full transition-all duration-500"
            style={{ width: `${progress}%`, background: 'var(--color-tg-primary)' }} />
        </div>

        <div className="rounded-2xl border border-tg-border p-6" style={{ background: 'var(--color-tg-surface)' }}>
          {step === 1 && (
            <Step1 values={data.trading_types} onToggle={toggleType} />
          )}
          {step === 2 && (
            <Step2 value={data.experience_level} onChange={(v) => setData({ ...data, experience_level: v })} />
          )}
          {step === 3 && (
            <Step3 values={data.default_markets} onToggle={toggleMarket} />
          )}
          {step === 4 && (
            <Step4
              rrRatio={data.min_rr_ratio}
              maxTrades={data.max_daily_trades}
              customStrategy={data.custom_strategy}
              onRR={(v) => setData({ ...data, min_rr_ratio: v })}
              onTrades={(v) => setData({ ...data, max_daily_trades: v })}
              onCustomStrategy={(v) => setData({ ...data, custom_strategy: v })}
            />
          )}
          {step === 5 && <Step5 data={data} />}
        </div>

        <div className="flex gap-3 mt-4">
          {step > 1 && (
            <Button variant="secondary" onClick={back} className="flex-1">׳—׳–׳¨׳”</Button>
          )}
          {step < STEPS ? (
            <Button onClick={next} className="flex-1" disabled={!canNext}>׳”׳׳©׳</Button>
          ) : (
            <Button onClick={finish} loading={loading} className="flex-1" variant="success">
              ׳‘׳•׳׳• ׳ ׳×׳—׳™׳!
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function MultiOptionButton({
  active, onClick, icon, label, description,
}: {
  active: boolean; onClick: () => void; icon: string; label: string; description: string;
}) {
  return (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 p-4 rounded-xl border transition-all duration-150 text-right"
      style={{
        background: active ? 'var(--color-tg-primary-muted)' : 'var(--color-tg-surface-2)',
        borderColor: active ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
      }}>
      <span className="text-2xl">{icon}</span>
      <div className="flex-1">
        <div className="text-sm font-semibold text-tg-text">{label}</div>
        <div className="text-xs text-tg-text-2 mt-0.5">{description}</div>
      </div>
      <div className="w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0"
        style={{
          borderColor: active ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
          background: active ? 'var(--color-tg-primary)' : 'transparent',
        }}>
        {active && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </div>
    </button>
  );
}

function Step1({ values, onToggle }: { values: TradingType[]; onToggle: (v: TradingType) => void }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-tg-text mb-1">׳׳™׳ ׳׳×׳” ׳¡׳•׳—׳¨?</h2>
      <p className="text-sm text-tg-text-2 mb-4">׳ ׳™׳×׳ ׳׳‘׳—׳•׳¨ ׳™׳•׳×׳¨ ׳׳׳—׳“</p>
      <div className="flex flex-col gap-3">
        <MultiOptionButton active={values.includes('day')} onClick={() => onToggle('day')} icon="ג¡" label="Day Trading" description="׳₪׳×׳™׳—׳” ׳•׳¡׳’׳™׳¨׳” ׳‘׳™׳•׳ ׳׳—׳“" />
        <MultiOptionButton active={values.includes('swing')} onClick={() => onToggle('swing')} icon="נ" label="Swing Trading" description="׳׳¡׳₪׳¨ ׳™׳׳™׳ ׳¢׳“ ׳©׳‘׳•׳¢׳•׳×" />
        <MultiOptionButton active={values.includes('futures')} onClick={() => onToggle('futures')} icon="נ“" label="׳—׳•׳–׳™׳ ׳¢׳×׳™׳“׳™׳™׳" description="׳׳¡׳—׳¨ ׳‘-Futures ׳•׳—׳•׳–׳™׳" />
        <MultiOptionButton active={values.includes('crypto')} onClick={() => onToggle('crypto')} icon="נ×™" label="Crypto Trading" description="׳§׳¨׳™׳₪׳˜׳• ג€” ׳¡׳‘׳™׳‘ ׳”׳©׳¢׳•׳" />
      </div>
    </div>
  );
}

function Step2({ value, onChange }: { value: ExperienceLevel; onChange: (v: ExperienceLevel) => void }) {
  const options: { v: ExperienceLevel; icon: string; label: string; desc: string }[] = [
    { v: 'beginner', icon: 'נ±', label: '׳׳×׳—׳™׳', desc: '׳₪׳—׳•׳× ׳׳©׳ ׳” ׳©׳ ׳׳¡׳—׳¨' },
    { v: 'intermediate', icon: 'נ“ˆ', label: '׳‘׳™׳ ׳•׳ ׳™', desc: '1-3 ׳©׳ ׳•׳× ׳ ׳™׳¡׳™׳•׳' },
    { v: 'advanced', icon: 'נ¯', label: '׳׳×׳§׳“׳', desc: '׳׳¢׳ 3 ׳©׳ ׳•׳× ׳ ׳™׳¡׳™׳•׳' },
  ];
  return (
    <div>
      <h2 className="text-lg font-semibold text-tg-text mb-1">׳׳” ׳¨׳׳× ׳”׳ ׳™׳¡׳™׳•׳ ׳©׳׳?</h2>
      <p className="text-sm text-tg-text-2 mb-4">׳ ׳¢׳–׳•׳¨ ׳׳ ׳‘׳”׳×׳׳</p>
      <div className="flex flex-col gap-3">
        {options.map((o) => (
          <MultiOptionButton key={o.v} active={value === o.v} onClick={() => onChange(o.v)}
            icon={o.icon} label={o.label} description={o.desc} />
        ))}
      </div>
    </div>
  );
}

function Step3({ values, onToggle }: { values: Market[]; onToggle: (v: Market) => void }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-tg-text mb-1">׳‘׳׳™׳–׳” ׳©׳•׳§ ׳׳×׳” ׳₪׳•׳¢׳?</h2>
      <p className="text-sm text-tg-text-2 mb-4">׳ ׳™׳×׳ ׳׳‘׳—׳•׳¨ ׳™׳•׳×׳¨ ׳׳׳—׳“</p>
      <div className="flex flex-col gap-3">
        <MultiOptionButton active={values.includes('stocks')} onClick={() => onToggle('stocks')} icon="נ›ן¸" label="׳׳ ׳™׳•׳×" description='NYSE, NASDAQ, ׳×"׳' />
        <MultiOptionButton active={values.includes('futures')} onClick={() => onToggle('futures')} icon="נ“" label="׳—׳•׳–׳™׳ ׳¢׳×׳™׳“׳™׳™׳" description="ES, NQ, CL ׳•׳¢׳•׳“" />
        <MultiOptionButton active={values.includes('crypto')} onClick={() => onToggle('crypto')} icon="ג‚¿" label="׳§׳¨׳™׳₪׳˜׳•" description="BTC, ETH ׳•׳¢׳•׳“" />
        <MultiOptionButton active={values.includes('forex')} onClick={() => onToggle('forex')} icon="נ’±" label="׳₪׳•׳¨׳§׳¡" description="׳–׳•׳’׳•׳× ׳׳˜׳‘׳¢׳•׳×" />
      </div>
    </div>
  );
}

function Step4({
  rrRatio, maxTrades, customStrategy, onRR, onTrades, onCustomStrategy,
}: {
  rrRatio: number; maxTrades: number; customStrategy: string;
  onRR: (v: number) => void; onTrades: (v: number) => void; onCustomStrategy: (v: string) => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-tg-text mb-1">׳§׳‘׳¢ ׳׳× ׳”׳›׳׳׳™׳ ׳”׳‘׳¡׳™׳¡׳™׳™׳</h2>
      <p className="text-sm text-tg-text-2 mb-5">׳ ׳™׳×׳ ׳׳©׳ ׳•׳× ׳‘׳”׳’׳“׳¨׳•׳× ׳‘׳›׳ ׳¢׳×</p>
      <div className="flex flex-col gap-5">
        <div>
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-medium text-tg-text">R:R ׳׳™׳ ׳™׳׳׳™</span>
            <span className="text-sm font-bold" style={{ color: 'var(--color-tg-primary)' }}>1:{rrRatio}</span>
          </div>
          <input type="range" min={1} max={5} step={0.5} value={rrRatio}
            onChange={(e) => onRR(parseFloat(e.target.value))} className="w-full" />
          <div className="flex justify-between text-xs text-tg-muted mt-1">
            <span>1:1</span><span>1:3</span><span>1:5</span>
          </div>
        </div>
        <div>
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-medium text-tg-text">׳׳§׳¡׳™׳׳•׳ ׳¢׳¡׳§׳׳•׳× ׳‘׳™׳•׳</span>
            <span className="text-sm font-bold" style={{ color: 'var(--color-tg-primary)' }}>{maxTrades}</span>
          </div>
          <input type="range" min={1} max={20} step={1} value={maxTrades}
            onChange={(e) => onTrades(parseInt(e.target.value))} className="w-full" />
          <div className="flex justify-between text-xs text-tg-muted mt-1">
            <span>1</span><span>10</span><span>20</span>
          </div>
        </div>
        <div>
          <label className="text-sm font-medium text-tg-text block mb-2">
            ׳׳¡׳˜׳¨׳˜׳’׳™׳” ׳׳™׳©׳™׳× (׳׳•׳₪׳¦׳™׳•׳ ׳׳™)
          </label>
          <input
            type="text"
            placeholder='׳׳׳©׳: "Asia Strategy", "Opening Range"'
            value={customStrategy}
            onChange={(e) => onCustomStrategy(e.target.value)}
            className="w-full px-3 py-2.5 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary transition-colors"
            style={{ background: 'var(--color-tg-surface-2)' }}
          />
        </div>
      </div>
    </div>
  );
}

function Step5({ data }: { data: WizardData }) {
  const tradingLabels: Record<TradingType, string> = {
    day: 'Day Trading', swing: 'Swing Trading', crypto: 'Crypto', futures: '׳—׳•׳–׳™׳ ׳¢׳×׳™׳“׳™׳™׳',
  };
  const marketLabels: Record<Market, string> = {
    stocks: '׳׳ ׳™׳•׳×', crypto: '׳§׳¨׳™׳₪׳˜׳•', forex: '׳₪׳•׳¨׳§׳¡', futures: '׳—׳•׳–׳™׳ ׳¢׳×׳™׳“׳™׳™׳',
  };
  const levelLabels: Record<ExperienceLevel, string> = {
    beginner: '׳׳×׳—׳™׳', intermediate: '׳‘׳™׳ ׳•׳ ׳™', advanced: '׳׳×׳§׳“׳',
  };

  return (
    <div>
      <div className="text-center mb-5">
        <div className="text-4xl mb-2">נ¯</div>
        <h2 className="text-lg font-semibold text-tg-text">׳׳•׳›׳ ׳׳”׳×׳—׳™׳!</h2>
        <p className="text-sm text-tg-text-2 mt-1">׳”׳¡׳™׳›׳•׳ ׳©׳׳</p>
      </div>
      <div className="flex flex-col gap-2">
        {[
          ['׳¡׳’׳ ׳•׳ ׳׳¡׳—׳¨', data.trading_types.map((t) => tradingLabels[t]).join(', ')],
          ['׳¨׳׳× ׳ ׳™׳¡׳™׳•׳', levelLabels[data.experience_level]],
          ['׳©׳•׳§ ׳¢׳™׳§׳¨׳™', data.default_markets.map((m) => marketLabels[m]).join(', ')],
          ['R:R ׳׳™׳ ׳™׳׳׳™', `1:${data.min_rr_ratio}`],
          ['׳׳§׳¡׳™׳׳•׳ ׳¢׳¡׳§׳׳•׳×/׳™׳•׳', `${data.max_daily_trades}`],
          ...(data.custom_strategy ? [['׳׳¡׳˜׳¨׳˜׳’׳™׳” ׳׳™׳©׳™׳×', data.custom_strategy]] : []),
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between items-center py-2 border-b border-tg-border last:border-0">
            <span className="text-sm text-tg-text-2">{label}</span>
            <span className="text-sm font-medium text-tg-text">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

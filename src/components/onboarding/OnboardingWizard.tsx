'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Zap, Waves, Leaf, TrendingUp, Target, Landmark, RefreshCw, Coins } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';
import type { TradingType, ExperienceLevel, Market } from '@/lib/types';

interface WizardData {
  trading_type: TradingType;
  experience_level: ExperienceLevel;
  default_market: Market;
  min_rr_ratio: number;
  max_daily_trades: number;
}

const STEPS = 5;

export default function OnboardingWizard({ userId }: { userId: string }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<WizardData>({
    trading_type: 'day',
    experience_level: 'beginner',
    default_market: 'stocks',
    min_rr_ratio: 2,
    max_daily_trades: 5,
  });

  function next() { setStep((s) => Math.min(s + 1, STEPS)); }
  function back() { setStep((s) => Math.max(s - 1, 1)); }

  async function finish() {
    setLoading(true);
    const supabase = createClient();

    await supabase.from('profiles').update({
      trading_type: data.trading_type,
      experience_level: data.experience_level,
      default_market: data.default_market,
      onboarding_completed: true,
      updated_at: new Date().toISOString(),
    }).eq('id', userId);

    await supabase.from('preset_rules').update({
      min_rr_ratio: data.min_rr_ratio,
      max_daily_trades: data.max_daily_trades,
      updated_at: new Date().toISOString(),
    }).eq('user_id', userId);

    router.push('/dashboard');
  }

  const progress = (step / STEPS) * 100;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{ background: 'var(--color-tg-bg)' }}>
      <div className="w-full max-w-md animate-fade-in">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl mb-3"
            style={{ background: 'var(--color-tg-primary)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
              <polyline points="16 7 22 7 22 13" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-tg-text">הגדרת פרופיל מסחר</h1>
          <p className="text-sm text-tg-text-2 mt-1">שלב {step} מתוך {STEPS}</p>
        </div>

        {/* Progress bar */}
        <div className="h-1 rounded-full mb-8 overflow-hidden"
          style={{ background: 'var(--color-tg-surface-2)' }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${progress}%`, background: 'var(--color-tg-primary)' }}
          />
        </div>

        {/* Steps */}
        <div className="rounded-2xl border border-tg-border p-6"
          style={{ background: 'var(--color-tg-surface)' }}>

          {step === 1 && (
            <Step1
              value={data.trading_type}
              onChange={(v) => setData({ ...data, trading_type: v })}
            />
          )}
          {step === 2 && (
            <Step2
              value={data.experience_level}
              onChange={(v) => setData({ ...data, experience_level: v })}
            />
          )}
          {step === 3 && (
            <Step3
              value={data.default_market}
              onChange={(v) => setData({ ...data, default_market: v })}
            />
          )}
          {step === 4 && (
            <Step4
              rrRatio={data.min_rr_ratio}
              maxTrades={data.max_daily_trades}
              onRR={(v) => setData({ ...data, min_rr_ratio: v })}
              onTrades={(v) => setData({ ...data, max_daily_trades: v })}
            />
          )}
          {step === 5 && <Step5 data={data} />}
        </div>

        {/* Navigation */}
        <div className="flex gap-3 mt-4">
          {step > 1 && (
            <Button variant="secondary" onClick={back} className="flex-1">
              חזרה
            </Button>
          )}
          {step < STEPS ? (
            <Button onClick={next} className="flex-1">
              המשך
            </Button>
          ) : (
            <Button onClick={finish} loading={loading} className="flex-1" variant="success">
              בואו נתחיל!
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function OptionButton({
  active,
  onClick,
  icon,
  label,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  description: string;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-4 rounded-xl border transition-all duration-150 text-right"
      style={{
        background: active ? 'var(--color-tg-primary-muted)' : 'var(--color-tg-surface-2)',
        borderColor: active ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
      }}
    >
      <span className="text-2xl">{icon}</span>
      <div>
        <div className="text-sm font-semibold text-tg-text">{label}</div>
        <div className="text-xs text-tg-text-2 mt-0.5">{description}</div>
      </div>
    </button>
  );
}

function Step1({ value, onChange }: { value: TradingType; onChange: (v: TradingType) => void }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-tg-text mb-1">איך אתה סוחר?</h2>
      <p className="text-sm text-tg-text-2 mb-4">נתאים את Reflekt לסגנון המסחר שלך</p>
      <div className="flex flex-col gap-3">
        <OptionButton active={value === 'day'} onClick={() => onChange('day')} icon={<Zap size={24} />} label="Day Trading" description="פתיחה וסגירה של עסקאות ביום אחד" />
        <OptionButton active={value === 'swing'} onClick={() => onChange('swing')} icon={<Waves size={24} />} label="Swing Trading" description="החזקת עסקאות מספר ימים עד שבועות" />
        <OptionButton active={value === 'crypto'} onClick={() => onChange('crypto')} icon={<Coins size={24} />} label="Crypto Trading" description="מסחר בקריפטו — סביב השעון" />
      </div>
    </div>
  );
}

function Step2({ value, onChange }: { value: ExperienceLevel; onChange: (v: ExperienceLevel) => void }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-tg-text mb-1">מה רמת הניסיון שלך?</h2>
      <p className="text-sm text-tg-text-2 mb-4">נעזור לך בהתאם</p>
      <div className="flex flex-col gap-3">
        <OptionButton active={value === 'beginner'} onClick={() => onChange('beginner')} icon={<Leaf size={24} />} label="מתחיל" description="פחות משנה של מסחר" />
        <OptionButton active={value === 'intermediate'} onClick={() => onChange('intermediate')} icon={<TrendingUp size={24} />} label="בינוני" description="1-3 שנות ניסיון" />
        <OptionButton active={value === 'advanced'} onClick={() => onChange('advanced')} icon={<Target size={24} />} label="מתקדם" description="מעל 3 שנות ניסיון" />
      </div>
    </div>
  );
}

function Step3({ value, onChange }: { value: Market; onChange: (v: Market) => void }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-tg-text mb-1">באיזה שוק אתה פועל בעיקר?</h2>
      <p className="text-sm text-tg-text-2 mb-4">ניתן לשנות בהגדרות מאוחר יותר</p>
      <div className="flex flex-col gap-3">
        <OptionButton active={value === 'stocks'} onClick={() => onChange('stocks')} icon={<Landmark size={24} />} label="מניות" description="NYSE, NASDAQ, ת&quot;א" />
        <OptionButton active={value === 'crypto'} onClick={() => onChange('crypto')} icon="₿" label="קריפטו" description="BTC, ETH ועוד" />
        <OptionButton active={value === 'forex'} onClick={() => onChange('forex')} icon={<RefreshCw size={24} />} label="פורקס" description="זוגות מטבעות" />
      </div>
    </div>
  );
}

function Step4({
  rrRatio, maxTrades, onRR, onTrades,
}: {
  rrRatio: number;
  maxTrades: number;
  onRR: (v: number) => void;
  onTrades: (v: number) => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-tg-text mb-1">קבע את הכללים הבסיסיים</h2>
      <p className="text-sm text-tg-text-2 mb-5">ניתן לשנות בהגדרות בכל עת</p>

      <div className="flex flex-col gap-6">
        <div>
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-medium text-tg-text">R:R מינימלי</span>
            <span className="text-sm font-bold text-tg-primary">1:{rrRatio}</span>
          </div>
          <input
            type="range" min={1} max={5} step={0.5} value={rrRatio}
            onChange={(e) => onRR(parseFloat(e.target.value))}
            className="w-full accent-tg-primary"
          />
          <div className="flex justify-between text-xs text-tg-muted mt-1">
            <span>1:1</span><span>1:3</span><span>1:5</span>
          </div>
        </div>

        <div>
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-medium text-tg-text">מקסימום עסקאות ביום</span>
            <span className="text-sm font-bold text-tg-primary">{maxTrades}</span>
          </div>
          <input
            type="range" min={1} max={20} step={1} value={maxTrades}
            onChange={(e) => onTrades(parseInt(e.target.value))}
            className="w-full accent-tg-primary"
          />
          <div className="flex justify-between text-xs text-tg-muted mt-1">
            <span>1</span><span>10</span><span>20</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Step5({ data }: { data: WizardData }) {
  const tradingLabels: Record<TradingType, string> = { day: 'Day Trading', swing: 'Swing Trading', crypto: 'Crypto Trading', futures: 'חוזים עתידיים' };
  const marketLabels: Record<Market, string> = { stocks: 'מניות', crypto: 'קריפטו', forex: 'פורקס', futures: 'חוזים עתידיים' };
  const levelLabels: Record<ExperienceLevel, string> = { beginner: 'מתחיל', intermediate: 'בינוני', advanced: 'מתקדם' };

  return (
    <div>
      <div className="text-center mb-5">
        <div className="mb-2"><Target size={40} /></div>
        <h2 className="text-lg font-semibold text-tg-text">מוכן להתחיל!</h2>
        <p className="text-sm text-tg-text-2 mt-1">הנה הסיכום שלך</p>
      </div>
      <div className="flex flex-col gap-2">
        {[
          ['סגנון מסחר', tradingLabels[data.trading_type]],
          ['רמת ניסיון', levelLabels[data.experience_level]],
          ['שוק עיקרי', marketLabels[data.default_market]],
          ['R:R מינימלי', `1:${data.min_rr_ratio}`],
          ['מקסימום עסקאות/יום', `${data.max_daily_trades}`],
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

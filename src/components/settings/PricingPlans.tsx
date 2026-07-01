'use client';

import { useState } from 'react';

type FeatureItem = { text: string; type: 'check' | 'cross' | 'dash' };

const BASIC_FEATURES: FeatureItem[] = [
  { text: 'יומן חודשי עם רווח והפסד אוטומטי', type: 'check' },
  { text: 'גרף TradingView מובנה בתוך כל עסקה', type: 'check' },
  { text: 'סטטיסטיקות ביצועים בסיסיות', type: 'check' },
  { text: 'ניתוח מעמיק אחרי כל עסקה', type: 'check' },
  { text: 'סטטיסטיקות מלאות לפי שעה ויום', type: 'cross' },
  { text: 'חסימה בזמן אמת לפני כניסה רגשית', type: 'cross' },
  { text: 'מאמן אישי שמכיר את דפוסי המסחר שלך', type: 'cross' },
  { text: 'סיכום שבועי עם תובנות מספריות', type: 'cross' },
  { text: 'עד 3 חוקי משמעת עם התראות', type: 'dash' },
  { text: 'עד 3 תנאי חסימה מתוך 8', type: 'dash' },
];

const PRO_FEATURES: FeatureItem[] = [
  { text: 'יומן חודשי עם רווח והפסד אוטומטי', type: 'check' },
  { text: 'גרף TradingView מובנה בתוך כל עסקה', type: 'check' },
  { text: 'סטטיסטיקות ביצועים בסיסיות', type: 'check' },
  { text: 'ניתוח מעמיק אחרי כל עסקה', type: 'check' },
  { text: 'סטטיסטיקות מלאות לפי שעה ויום', type: 'check' },
  { text: 'חסימה בזמן אמת לפני כניסה רגשית', type: 'check' },
  { text: 'מאמן אישי שמכיר את דפוסי המסחר שלך', type: 'check' },
  { text: 'סיכום שבועי עם תובנות מספריות', type: 'check' },
  { text: 'חוקי משמעת ללא הגבלה עם חסימה אוטומטית', type: 'check' },
  { text: 'חסימה על בסיס 8 תנאים — FOMO, הפסד יומי, רצף הפסדים ועוד', type: 'check' },
];

export default function PricingPlans({ plan }: { plan: 'free' | 'basic' | 'pro' }) {
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('monthly');

  const basicPrice = billing === 'monthly' ? '₪59' : '₪55';
  const proPrice   = billing === 'monthly' ? '₪99' : '₪89';

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-bold text-tg-text">מסלולים</h2>

      {/* Billing toggle */}
      <div className="flex justify-center">
        <div className="flex rounded-full p-0.5" style={{ background: 'var(--color-tg-surface-2)' }}>
          {(['monthly', 'yearly'] as const).map((b) => (
            <button
              key={b}
              onClick={() => setBilling(b)}
              className="px-4 py-1.5 rounded-full text-xs font-semibold transition-all duration-200"
              style={{
                background: billing === b ? '#00d2d2' : 'transparent',
                color: billing === b ? '#000' : 'var(--color-tg-muted)',
              }}
            >
              {b === 'monthly' ? 'חודשי' : 'שנתי'}
            </button>
          ))}
        </div>
      </div>

      {/* Plan cards */}
      <div className="flex gap-3">
        {/* Basic */}
        <div
          className="flex-1 rounded-2xl border-2 p-4 flex flex-col"
          style={{
            borderColor: plan === 'basic' ? '#00d2d2' : 'var(--color-tg-border)',
            background: 'var(--color-tg-surface)',
          }}
        >
          <div className="mb-3">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm font-bold text-tg-text">Basic</h3>
              {plan === 'basic' && (
                <span
                  className="px-2 py-0.5 rounded-full text-xs font-semibold"
                  style={{ background: 'rgba(0,210,210,0.12)', color: '#00d2d2' }}
                >
                  המסלול שלך
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-bold text-tg-text">{basicPrice}</span>
              <span className="text-xs text-tg-muted">/חודש</span>
            </div>
            {billing === 'yearly' && (
              <p className="text-xs text-tg-muted mt-0.5">לחיוב שנתי</p>
            )}
          </div>

          <FeatureList features={BASIC_FEATURES} />

          <div className="mt-4">
            {plan !== 'basic' ? (
              <button className="shimmer-btn w-full py-2.5 rounded-xl text-sm font-semibold text-black transition-all duration-150 active:scale-95">
                התחל ניסיון חינם 5 ימים
              </button>
            ) : (
              <div
                className="w-full py-2.5 rounded-xl text-sm font-semibold text-center"
                style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-muted)' }}
              >
                המסלול הנוכחי
              </div>
            )}
          </div>
        </div>

        {/* Pro */}
        <div
          className="flex-1 rounded-2xl border-2 p-4 flex flex-col relative"
          style={{
            borderColor: '#00d2d2',
            background: 'var(--color-tg-surface)',
            boxShadow: '0 0 18px 3px rgba(0,210,210,0.22)',
          }}
        >
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span
              className="px-3 py-0.5 rounded-full text-xs font-bold whitespace-nowrap"
              style={{ background: '#00d2d2', color: '#000' }}
            >
              הכי פופולרי
            </span>
          </div>

          <div className="mb-3">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm font-bold text-tg-text">Pro</h3>
              {plan === 'pro' && (
                <span
                  className="px-2 py-0.5 rounded-full text-xs font-semibold"
                  style={{ background: 'rgba(0,210,210,0.12)', color: '#00d2d2' }}
                >
                  המסלול שלך
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl font-bold text-tg-text">{proPrice}</span>
              <span className="text-xs text-tg-muted">/חודש</span>
            </div>
            {billing === 'yearly' && (
              <p className="text-xs text-tg-muted mt-0.5">לחיוב שנתי</p>
            )}
          </div>

          <FeatureList features={PRO_FEATURES} />

          <div className="mt-4">
            {plan !== 'pro' ? (
              <button className="shimmer-btn w-full py-2.5 rounded-xl text-sm font-semibold text-black transition-all duration-150 active:scale-95">
                התחל ניסיון חינם 5 ימים
              </button>
            ) : (
              <div
                className="w-full py-2.5 rounded-xl text-sm font-semibold text-center"
                style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-muted)' }}
              >
                המסלול הנוכחי
              </div>
            )}
          </div>
        </div>
      </div>

      <p className="text-xs text-tg-muted text-center px-2">
        אינטגרציה עתידית: Binance · Interactive Brokers · eToro
      </p>
    </div>
  );
}

function FeatureList({ features }: { features: FeatureItem[] }) {
  return (
    <ul className="flex flex-col gap-1.5 flex-1">
      {features.map((f) => (
        <li key={f.text} className="flex items-start gap-2">
          {f.type === 'check' && <CheckIcon />}
          {f.type === 'cross' && <CrossIcon />}
          {f.type === 'dash'  && (
            <span className="w-3.5 shrink-0 mt-0.5 text-xs leading-none font-medium" style={{ color: 'var(--color-tg-muted)' }}>—</span>
          )}
          <span className={`text-xs ${f.type === 'dash' ? 'text-tg-muted' : f.type === 'cross' ? 'text-tg-muted' : 'text-tg-text-2'}`}>
            {f.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="var(--color-tg-success)"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      className="shrink-0 mt-0.5"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="var(--color-tg-danger)"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className="shrink-0 mt-0.5"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

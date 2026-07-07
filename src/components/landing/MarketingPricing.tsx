'use client';

import { useState } from 'react';
import Link from 'next/link';

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

export function MarketingPricing() {
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('monthly');

  const basicPrice = billing === 'monthly' ? '₪59' : '₪55';
  const proPrice = billing === 'monthly' ? '₪99' : '₪89';

  return (
    <div className="flex flex-col gap-8">
      <div className="flex justify-center">
        <div className="flex rounded-full p-0.5" style={{ background: 'var(--color-tg-surface-2)' }}>
          {(['monthly', 'yearly'] as const).map((b) => (
            <button
              key={b}
              onClick={() => setBilling(b)}
              className="px-5 py-2 rounded-full text-sm font-semibold transition-all duration-200"
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-[1200px] mx-auto w-full items-start">
        {/* Basic */}
        <div className="glass-card card-hover rounded-2xl p-8 lg:p-10 flex flex-col">
          <div className="mb-6">
            <h3 className="text-2xl lg:text-3xl font-bold text-tg-text mb-2">Basic</h3>
            <div className="flex items-baseline gap-1.5">
              <span className="text-4xl lg:text-5xl font-extrabold text-tg-text">{basicPrice}</span>
              <span className="text-base text-tg-muted">/חודש</span>
            </div>
            {billing === 'yearly' && <p className="text-sm text-tg-muted mt-1">לחיוב שנתי</p>}
          </div>

          <FeatureList features={BASIC_FEATURES} />

          <Link
            href="/signup"
            className="landing-cta mt-8 w-full py-4 rounded-xl text-base font-semibold text-black text-center"
          >
            התחל ניסיון חינם 5 ימים
          </Link>
        </div>

        {/* Pro */}
        <div
          className="pricing-pro-card glass-card rounded-2xl p-8 lg:p-10 flex flex-col relative"
          style={{ borderColor: 'rgba(0,210,210,0.5)', boxShadow: '0 0 0 1px rgba(0,210,210,0.15), 0 20px 50px rgba(0,0,0,0.35), 0 0 40px rgba(0,210,210,0.15)' }}
        >
          <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
            <span
              className="px-4 py-1 rounded-full text-xs font-bold whitespace-nowrap"
              style={{ background: '#00d2d2', color: '#000' }}
            >
              המומלץ
            </span>
          </div>

          <div className="mb-6">
            <h3 className="text-2xl lg:text-3xl font-bold text-tg-text mb-2">Pro</h3>
            <div className="flex items-baseline gap-1.5">
              <span className="text-4xl lg:text-5xl font-extrabold text-tg-text">{proPrice}</span>
              <span className="text-base text-tg-muted">/חודש</span>
            </div>
            {billing === 'yearly' && <p className="text-sm text-tg-muted mt-1">לחיוב שנתי</p>}
          </div>

          <FeatureList features={PRO_FEATURES} />

          <Link
            href="/signup"
            className="landing-cta mt-8 w-full py-4 rounded-xl text-base font-semibold text-black text-center"
          >
            התחל ניסיון חינם 5 ימים
          </Link>
        </div>
      </div>
    </div>
  );
}

function FeatureList({ features }: { features: FeatureItem[] }) {
  return (
    <ul className="flex flex-col gap-3 flex-1">
      {features.map((f) => (
        <li key={f.text} className="flex items-start gap-2.5">
          {f.type === 'check' && <CheckIcon />}
          {f.type === 'cross' && <CrossIcon />}
          {f.type === 'dash' && (
            <span className="w-4 shrink-0 mt-1 text-sm leading-none font-medium" style={{ color: 'var(--color-tg-muted)' }}>
              —
            </span>
          )}
          <span
            className={`text-base leading-relaxed ${f.type === 'dash' ? 'text-tg-muted' : f.type === 'cross' ? 'text-tg-muted' : 'text-tg-text-2'}`}
          >
            {f.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CheckIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="var(--color-tg-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="var(--color-tg-danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

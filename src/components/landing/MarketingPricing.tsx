'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';

/**
 * One plan.
 *
 * This section used to be a Basic/Pro pair, and most of its design effort went
 * into answering "what does the more expensive one give me" — a delta list, a
 * shared-foundation line, a recommended badge, two CTAs of deliberately
 * different loudness. None of that exists any more, because the question does
 * not. We did not have enough features to divide into tiers in a way that made
 * sense, and every division we tried penalised the traders we most want using
 * the product.
 *
 * What is left is a single card with nothing withheld, so a check means "you
 * get this" and there is no second meaning anywhere in the list.
 *
 * ── Prices ──
 *
 * PLAN_PRICE is the only place a figure is typed. The annual list price and the
 * number of free months are both derived from it, so the struck-through figure
 * cannot drift from the monthly one and the saving cannot claim two free months
 * that the arithmetic does not actually give.
 *
 * ── The one claim that has to stay exact ──
 *
 * The rules engine runs when a trade plan is entered in Reflect. It is not
 * connected to any trading platform and cannot stop an order anywhere else, so
 * nothing here may say or imply that it blocks a trade automatically. The
 * qualifier on the first feature is the precise version of that claim and is
 * not decorative — see Terms section 6.2, which says the same thing.
 */

// The single source of truth. Monthly, and the total billed once a year.
const PLAN_PRICE = {
  monthly: 129,
  yearly: 1290,
} as const;

/** What twelve months at the monthly rate would cost — the struck-through figure. */
const YEARLY_LIST = PLAN_PRICE.monthly * 12;

const YEARLY_SAVING = YEARLY_LIST - PLAN_PRICE.yearly;

/**
 * The saving expressed the way we want to sell it — in months, not percent.
 * Derived, so if a price moves and the discount stops being a whole number of
 * months, the chip falls back to the shekel figure instead of quietly lying.
 */
function savingLabel(): string {
  const months = YEARLY_SAVING / PLAN_PRICE.monthly;
  if (!Number.isInteger(months) || months < 1) return `חיסכון של ₪${YEARLY_SAVING}`;
  const word = ['', 'חודש אחד', 'שני חודשים', 'שלושה חודשים'][months] ?? `${months} חודשים`;
  return `${word} חינם`;
}

type Feature = {
  text: string;
  /** Secondary clause. Rendered quieter and smaller, on its own line. */
  note?: string;
};

const FEATURES: Feature[] = [
  {
    text: 'חוקים אישיים שעוצרים אותך לפני הכניסה',
    // Not a softener. This is the whole claim, stated at the only scope where
    // it is true: inside Reflect, at the moment a plan is entered.
    note: 'עוצר אותך ברגע שאתה מזין עסקה שמפרה את הכללים שלך',
  },
  { text: 'ציון משמעת אחרי כל עסקה' },
  { text: 'ביקורת AI על כל עסקה וצילום גרף' },
  { text: 'מאמן AI שמכיר את ההיסטוריה שלך' },
  { text: 'סטטיסטיקות, לוח חודשי ומחברת' },
];

export function MarketingPricing() {
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('monthly');
  const isYearly = billing === 'yearly';

  return (
    <div className="flex flex-col gap-10">
      <div className="flex justify-center">
        <div className="pricing-toggle" role="group" aria-label="מחזור חיוב">
          {(['monthly', 'yearly'] as const).map((b) => (
            <button
              key={b}
              onClick={() => setBilling(b)}
              aria-pressed={billing === b}
              className={`pricing-toggle-btn ${billing === b ? 'is-active' : ''}`}
            >
              {b === 'monthly' ? 'חודשי' : 'שנתי'}
            </button>
          ))}
        </div>
      </div>

      {/* Capped at 560px — the same width the pair used once it stacked. A
          single card allowed to run the full 1120px would put five short
          bullets on a ~1000px measure, which is most of each row left empty. */}
      <div className="max-w-[560px] mx-auto w-full">
        <div className="pricing-card pricing-card-pro glass-card rounded-2xl flex flex-col">
          {/* The card carries no plan name: there is nothing to tell it apart
              from, and "Pro" on the only plan is a tier label for a tier that
              no longer exists. The eyebrow states the choice instead. */}
          <div
            className="pb-4 mb-5"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
          >
            <p className="text-sm font-bold" style={{ color: 'rgba(0,210,210,0.95)' }}>
              מסלול אחד, הכול כלול
            </p>
          </div>

          <div className="mb-7">
            <div className="flex items-baseline gap-2">
              {/* Isolated LTR so the shekel sign stays on the digits' left, the
                  same way DistinctionSection isolates its figures. The row
                  around it stays RTL. */}
              <span dir="ltr" className="pricing-price">
                <span className="pricing-currency">₪</span>
                <span className="pricing-amount">
                  {isYearly ? PLAN_PRICE.yearly.toLocaleString('en-US') : PLAN_PRICE.monthly}
                </span>
              </span>
              <span className="pricing-per">{isYearly ? '/שנה' : '/חודש'}</span>
            </div>

            {isYearly && (
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 mt-3">
                {/* The list price is struck, not merely stated, so the discount
                    is visible without a percentage being quoted anywhere. */}
                <span dir="ltr" className="pricing-list-price">
                  {`₪${YEARLY_LIST.toLocaleString('en-US')}`}
                </span>
                <span className="pricing-save-chip">{savingLabel()}</span>
              </div>
            )}
          </div>

          <ul className="flex flex-col gap-3.5">
            {FEATURES.map((f) => (
              <li key={f.text} className="flex items-start gap-2.5">
                <span className="pricing-check" aria-hidden>
                  <Check aria-hidden="true" size={12} strokeWidth={3.25} />
                </span>
                <span className="text-base leading-snug" style={{ color: 'rgba(255,255,255,0.9)' }}>
                  {f.text}
                  {/* Its own line, not a "· note" appended to the sentence.
                      Inline, it wrapped at 150% zoom and stranded the middot at
                      the start of the next line, where it read as a bullet. */}
                  {f.note && <span className="pricing-note">{f.note}</span>}
                </span>
              </li>
            ))}
          </ul>

          <div className="pricing-panel mt-7">
            <p className="pricing-panel-label">למי זה מתאים</p>
            <p className="pricing-panel-text">
              לסוחר שהידע כבר לא הבעיה, וצריך תיעוד אמיתי של כל עסקה — ומשהו שיעצור אותו ברגע ההחלטה.
            </p>
          </div>

          {/* One plan, so one CTA, and it takes the page's filled gradient.
              `cta-shine` is a hover-only sweep, not a loop: nothing animates at
              rest at the decision moment. */}
          <div className="mt-6 flex flex-col items-center gap-2">
            <Link
              href="/signup"
              className="link-button landing-cta cta-shine w-full py-3.5 rounded-xl text-base font-bold text-center text-black"
            >
              התחל חמישה ימי ניסיון
            </Link>
            {/* Both lines describe what the product actually does. The refund
                is not new — it has been in the Terms all along and has simply
                never been said out loud where anyone deciding could see it. */}
            <span className="text-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>
              חמישה ימי ניסיון, בלי כרטיס אשראי
            </span>
            <span className="text-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>
              החזר מלא תוך 14 יום
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

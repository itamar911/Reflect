'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { PLAN_LIMITS } from '@/lib/plans/config';

/**
 * Two plans, and the only question a visitor is actually asking is "what does
 * the more expensive one give me". The old card pair answered that badly: the
 * first four bullets were identical word for word in both cards, so the answer
 * could only be found by reading two ten-item lists side by side and diffing
 * them by eye.
 *
 * So the lists are no longer parallel. Basic states what Basic is; Pro states
 * only its delta over Basic, under a lead line that says so. The upgrade
 * proposition is now the whole of the Pro list rather than something to be
 * extracted from it.
 *
 * Three consequences worth naming, because each one removed a separate problem:
 *
 *   1. No cross marks. Every "missing" feature in Basic was drawn as a red ✗ —
 *      an error colour, four times, on the entry plan. Under a delta list those
 *      rows simply do not exist in Basic's card; they exist as additions in
 *      Pro's. Nothing needs a "not included" state at all.
 *   2. No third icon state. The two "limited" rows used a bare em dash that
 *      nothing on the page explained. The limit is now part of the sentence
 *      ("עד 3 חוקי משמעת…"), which is both self-explanatory and where a reader
 *      was going to look for it anyway. A legend would have been an admission
 *      that the icons failed.
 *   3. One icon, one meaning, per card: a check means "you get this". Basic's
 *      are green (included), Pro's turquoise (its accent) — never two states
 *      inside one list.
 *
 * The numbers in the copy are read off PLAN_LIMITS rather than typed, so the
 * marketing claim and the limit the app actually enforces cannot drift apart.
 */

// Monthly price vs. per-month price on annual billing — savings are computed, not hardcoded.
const PLAN_PRICES = {
  basic: { monthly: 59, yearly: 55 },
  pro: { monthly: 99, yearly: 89 },
} as const;

type PlanKey = keyof typeof PLAN_PRICES;

function yearlySavings(plan: PlanKey) {
  const { monthly, yearly } = PLAN_PRICES[plan];
  return monthly * 12 - yearly * 12;
}

/**
 * What the annual toggle is worth at best — the reason to click it, shown on
 * the toggle itself rather than only inside a card the visitor reaches after
 * clicking.
 *
 * "עד" is doing real work here and is not hedging: the two discounts are not
 * the same (Basic 59→55 is 7%, Pro 99→89 is 10%), so a single figure stated
 * flatly would be wrong for Basic. The exact saving for the plan in front of
 * you still appears in that plan's own card once annual is selected.
 */
const MAX_YEARLY_SAVING = Math.max(...(Object.keys(PLAN_PRICES) as PlanKey[]).map(yearlySavings));

/**
 * `?? ` only satisfies the type — null means "unlimited" in PlanLimits, which is
 * Pro's case, never Basic's.
 */
const BASIC_RULES = PLAN_LIMITS.basic.maxCustomRules ?? 3;
const BASIC_CONDITIONS = PLAN_LIMITS.basic.maxBlockingConditions ?? 3;

/** Condition types the product ships. Not a per-plan limit, so not in PlanLimits. */
const TOTAL_CONDITIONS = 8;

const BASIC_FEATURES = [
  'יומן חודשי עם רווח והפסד אוטומטי',
  'גרף TradingView מובנה בתוך כל עסקה',
  'סטטיסטיקות ביצועים בסיסיות',
  'ניתוח מעמיק אחרי כל עסקה',
  `עד ${BASIC_RULES} חוקי משמעת עם התראה לפני כניסה`,
  `עד ${BASIC_CONDITIONS} תנאי חסימה מתוך ${TOTAL_CONDITIONS}`,
];

/**
 * Only the delta. The two limit rows are phrased as the lift they are ("במקום
 * 3"), not as new features — a reader who just read Basic's list would
 * otherwise see the same capability listed twice and have to work out which
 * card was lying.
 */
const PRO_ADDITIONS = [
  'חסימה בזמן אמת לפני כניסה רגשית — לא רק התראה',
  'מאמן אישי שמכיר את דפוסי המסחר שלך',
  'סטטיסטיקות מלאות לפי שעה ויום',
  'סיכום שבועי עם תובנות מספריות',
  `חוקי משמעת ללא הגבלה, במקום ${BASIC_RULES}`,
  `כל ${TOTAL_CONDITIONS} תנאי החסימה — FOMO, הפסד יומי, רצף הפסדים ועוד`,
];

export function MarketingPricing() {
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('monthly');

  return (
    <div className="flex flex-col gap-8">
      {/* The toggle and its reason to exist. In RTL the chip lands immediately
          to the left of the "שנתי" button — i.e. touching the control it
          describes — so no connector or arrow is needed to tie them together.
          It wraps below the toggle rather than shrinking when the row runs out
          of width. */}
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-3">
        <div className="flex rounded-full p-0.5" style={{ background: 'var(--color-tg-surface-2)' }}>
          {(['monthly', 'yearly'] as const).map((b) => (
            <button
              key={b}
              onClick={() => setBilling(b)}
              aria-pressed={billing === b}
              className="px-5 py-2 rounded-full text-sm font-semibold transition-all duration-200"
              style={{
                background: billing === b ? '#00d2d2' : 'transparent',
                // --color-tg-muted is #ffffff in this theme, so an inactive tab
                // styled "muted" came out as bright as the active one.
                color: billing === b ? '#000' : 'rgba(255,255,255,0.6)',
              }}
            >
              {b === 'monthly' ? 'חודשי' : 'שנתי'}
            </button>
          ))}
        </div>

        <span className="pricing-save-chip">{`חיסכון של עד ₪${MAX_YEARLY_SAVING} בשנה`}</span>
      </div>

      {/* Basic first in DOM = right-most under RTL, so it is read first. That
          ordering is load-bearing now: Pro's list opens with "כל מה שב-Basic",
          which only parses for someone who has already seen Basic's.

          `items-stretch` plus `h-full` + `flex-1` inside each card is what
          keeps the two exactly as tall as each other — no min-height constant
          to maintain as the copy changes.

          Capped at 560px once the cards stack, the same way HowItWorksSection
          caps its three: at 960px wide — which is what a 1440px window becomes
          at 150% browser zoom — a full-width card puts six short bullets on a
          ~900px measure, leaving most of each row empty. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-7 max-w-[560px] lg:max-w-[1120px] mx-auto w-full items-stretch">
        <PlanCard name="Basic" plan="basic" billing={billing} lead="מה שכלול:" features={BASIC_FEATURES} />
        <PlanCard
          name="Pro"
          plan="pro"
          billing={billing}
          lead="כל מה שב-Basic, ובנוסף:"
          features={PRO_ADDITIONS}
          highlighted
        />
      </div>
    </div>
  );
}

function PlanCard({
  name,
  plan,
  billing,
  lead,
  features,
  highlighted = false,
}: {
  name: string;
  plan: PlanKey;
  billing: 'monthly' | 'yearly';
  lead: string;
  features: string[];
  highlighted?: boolean;
}) {
  const price = PLAN_PRICES[plan][billing];

  return (
    <div
      className={`pricing-card glass-card rounded-2xl flex flex-col h-full ${
        highlighted ? 'pricing-card-pro' : 'card-hover'
      }`}
    >
      {/* Header row. The badge sits *in* this row, at its inline end, above the
          same hairline as the plan name — it is part of the card's composition
          rather than a sticker pinned at -top-3.5 over the card's edge, which
          is the same thing the step numerals in HowItWorksSection were fixed
          out of. */}
      <div
        className="flex items-center gap-3 pb-4 mb-5"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        <h3 className="text-2xl font-bold text-white">{name}</h3>
        {highlighted && (
          <span
            className="ms-auto shrink-0 rounded-full px-3.5 py-1 text-sm font-bold whitespace-nowrap"
            style={{ background: '#00d2d2', color: '#000' }}
          >
            המומלץ
          </span>
        )}
      </div>

      <div className="mb-6">
        <div className="flex items-baseline gap-1.5">
          {/* The numeral is isolated LTR so the shekel sign stays on the digits'
              left, the same way DistinctionSection isolates its figures. The row
              around it stays RTL, so the price sits on the card's start edge and
              "/חודש" follows it leftward. */}
          <span
            dir="ltr"
            className="text-4xl lg:text-[44px] font-extrabold text-white"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {`₪${price}`}
          </span>
          <span className="text-base" style={{ color: 'rgba(255,255,255,0.6)' }}>
            /חודש
          </span>
        </div>
        {billing === 'yearly' && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 mt-2.5">
            <span className="text-sm" style={{ color: 'rgba(255,255,255,0.55)' }}>
              לחיוב שנתי
            </span>
            <span className="pricing-save-chip">{`חיסכון של ₪${yearlySavings(plan)} בשנה`}</span>
          </div>
        )}
      </div>

      <div className="flex-1 flex flex-col">
        <p
          className="text-sm font-bold mb-3.5"
          style={{ color: highlighted ? 'rgba(0,210,210,0.95)' : 'rgba(255,255,255,0.5)' }}
        >
          {lead}
        </p>
        <ul className="flex flex-col gap-3">
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-2.5">
              <Check
                size={18}
                strokeWidth={2.5}
                className="shrink-0"
                style={{ color: highlighted ? '#00d2d2' : 'var(--color-tg-success)', marginTop: 3 }}
                aria-hidden
              />
              <span className="text-base leading-normal" style={{ color: 'rgba(255,255,255,0.88)' }}>
                {feature}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* The recommended plan keeps the page's filled gradient CTA; the other
          takes an outlined one. Two identically-loud buttons made the pair a
          coin toss — an outline still reads as a legitimate choice, which a
          greyed-out button would not. */}
      <div className="mt-auto pt-7 flex flex-col items-center gap-2.5">
        <Link
          href="/signup"
          className={`w-full py-3.5 rounded-xl text-base font-bold text-center ${
            highlighted ? 'landing-cta text-black' : 'pricing-cta-ghost'
          }`}
        >
          התחל ניסיון חינם 5 ימים
        </Link>
        {/* Only what is actually true today. Stripe is not integrated, so there
            is no billing behaviour to promise beyond this. */}
        <span className="text-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>
          בלי כרטיס אשראי
        </span>
      </div>
    </div>
  );
}

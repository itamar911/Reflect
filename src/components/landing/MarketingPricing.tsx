'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Sparkles } from 'lucide-react';
import { PLAN_LIMITS } from '@/lib/plans/config';

/**
 * Two plans, and the only question a visitor is actually asking is "what does
 * the more expensive one give me".
 *
 * ── How this card pair answers it, and the two dead ends before it ──
 *
 * The original pair repeated its first four bullets word for word in both
 * cards. ~40% of each card was duplicated, so the answer could only be found by
 * diffing two ten-item lists by eye.
 *
 * The first fix made Pro's list a pure delta under the lead line "כל מה
 * שב-Basic, ובנוסף:". That killed the duplication but replaced it with an
 * unresolved cross-reference: the sentence made Pro's entire card depend on
 * remembering the other card, and it read as an apology rather than as a
 * feature.
 *
 * What is here now keeps the delta and drops the dependency:
 *
 *   1. Pro's prominent list is *only* what Pro adds, and it comes first, right
 *      under the price — so the upgrade proposition is the first thing read in
 *      that card, not something reached after a preamble.
 *   2. The shared foundation is still stated in Pro, but demoted to a quiet
 *      panel at the foot of the card and written as short chips rather than
 *      full sentences. The cross-reference is resolved *in place* — a reader
 *      never has to hold Basic's list in their head — while nothing is stated
 *      twice at full length.
 *   3. Both cards carry a quiet panel in that same slot, so the two are
 *      structurally identical: price, prominent list, quiet panel, CTA.
 *
 * The chips are derived from BASIC_FEATURES itself (the `short` field), so the
 * foundation Pro claims to include and the list Basic actually shows cannot
 * drift apart. Likewise every limit number is read off PLAN_LIMITS rather than
 * typed, so the marketing copy cannot drift from what the app enforces.
 *
 * One icon, one meaning, per card: a check means "you get this". There is no
 * "not included" state anywhere — Basic is a legitimate starting point, not a
 * list of things withheld.
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
 * `??` only satisfies the type — null means "unlimited" in PlanLimits, which is
 * Pro's case, never Basic's.
 */
const BASIC_RULES = PLAN_LIMITS.basic.maxCustomRules ?? 3;
const BASIC_CONDITIONS = PLAN_LIMITS.basic.maxBlockingConditions ?? 3;

/** Condition types the product ships. Not a per-plan limit, so not in PlanLimits. */
const TOTAL_CONDITIONS = 8;

type Feature = {
  text: string;
  /** Secondary clause. Rendered quieter and smaller, on the same line. */
  note?: string;
  /**
   * Short form, present only on capabilities both plans share. Pro reprints
   * these as chips instead of as sentences — the single source of truth for
   * "what the foundation is".
   */
  short?: string;
};

const BASIC_FEATURES: Feature[] = [
  { text: 'יומן חודשי עם רווח והפסד אוטומטי', short: 'יומן חודשי' },
  { text: 'גרף TradingView מובנה בתוך כל עסקה', short: 'גרף TradingView' },
  { text: 'סטטיסטיקות ביצועים בסיסיות', short: 'סטטיסטיקות' },
  { text: 'ניתוח מעמיק אחרי כל עסקה', short: 'ניתוח לכל עסקה' },
  // No `short`: these two are not shared. Pro has the same capability at a
  // different level, so it appears in Pro's prominent list as a lift.
  { text: `עד ${BASIC_RULES} חוקי משמעת`, note: 'עם התראה לפני כניסה' },
  { text: `עד ${BASIC_CONDITIONS} תנאי חסימה`, note: `מתוך ${TOTAL_CONDITIONS}` },
];

const PRO_ADDITIONS: Feature[] = [
  { text: 'חסימה בזמן אמת לפני כניסה רגשית', note: 'לא רק התראה' },
  { text: 'מאמן אישי שמכיר את דפוסי המסחר שלך' },
  { text: 'סטטיסטיקות מלאות לפי שעה ויום' },
  { text: 'סיכום שבועי עם תובנות מספריות' },
  { text: 'חוקי משמעת ללא הגבלה', note: `במקום ${BASIC_RULES}` },
  { text: `כל ${TOTAL_CONDITIONS} תנאי החסימה`, note: `במקום ${BASIC_CONDITIONS}` },
];

/** The foundation Pro inherits, in short form. Derived — never a second list. */
const SHARED_CHIPS = BASIC_FEATURES.flatMap((f) => (f.short ? [f.short] : []));

export function MarketingPricing() {
  const [billing, setBilling] = useState<'monthly' | 'yearly'>('monthly');

  return (
    <div className="flex flex-col gap-10">
      <div className="flex justify-center">
        {/* The saving used to be restated on a pill beside this toggle. It is
            gone: each card already prints its own exact figure the moment
            annual is selected, and the pill could only quote the better of the
            two ("עד"), which hedged the very number it was trying to sell. */}
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

      {/* Basic first in DOM = right-most under RTL, so it is read first.
          `items-stretch` plus `h-full` + `flex-1` inside each card is what keeps
          the two exactly as tall as each other — no min-height constant to
          maintain as the copy changes.

          Capped at 560px once the cards stack, the same way HowItWorksSection
          caps its three: at 960px wide — what a 1440px window becomes at 150%
          browser zoom — a full-width card puts six short bullets on a ~900px
          measure, leaving most of each row empty. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-7 max-w-[560px] lg:max-w-[1120px] mx-auto w-full items-stretch">
        <PlanCard
          name="Basic"
          plan="basic"
          billing={billing}
          lead="כולל:"
          features={BASIC_FEATURES}
          panelLabel="למי זה מתאים"
          panelText="לסוחר שרוצה קודם כול תיעוד מסודר וניתוח אמיתי של כל עסקה."
        />
        <PlanCard
          name="Pro"
          plan="pro"
          billing={billing}
          lead="מה ש-Pro מוסיף:"
          features={PRO_ADDITIONS}
          panelLabel="כולל גם את כל מה שב-Basic"
          chips={SHARED_CHIPS}
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
  panelLabel,
  panelText,
  chips,
  highlighted = false,
}: {
  name: string;
  plan: PlanKey;
  billing: 'monthly' | 'yearly';
  lead: string;
  features: Feature[];
  panelLabel: string;
  panelText?: string;
  chips?: string[];
  highlighted?: boolean;
}) {
  const price = PLAN_PRICES[plan][billing];

  return (
    <div
      className={`pricing-card glass-card rounded-2xl flex flex-col h-full ${
        highlighted ? 'pricing-card-pro' : 'card-hover'
      }`}
    >
      {/* Header. The badge sits *in* this row at its inline end, above the same
          hairline as the plan name — part of the card's composition rather than
          a sticker pinned over the card's top edge, which is the same thing the
          step numerals in HowItWorksSection were fixed out of. */}
      <div
        className="flex items-center gap-3 pb-4 mb-5"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        <h3 className="text-2xl font-bold text-white">{name}</h3>
        {highlighted && (
          <span className="pricing-badge ms-auto shrink-0">
            <Sparkles size={13} strokeWidth={2.5} aria-hidden />
            המומלץ
          </span>
        )}
      </div>

      <div className="mb-7">
        <div className="flex items-baseline gap-2">
          {/* Isolated LTR so the shekel sign stays on the digits' left, the same
              way DistinctionSection isolates its figures. The row around it
              stays RTL, so the price sits on the card's start edge and "/חודש"
              follows it leftward. */}
          <span dir="ltr" className="pricing-price">
            <span className="pricing-currency">₪</span>
            <span className="pricing-amount">{price}</span>
          </span>
          <span className="pricing-per">/חודש</span>
        </div>
        {billing === 'yearly' && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 mt-3">
            <span className="text-sm" style={{ color: 'rgba(255,255,255,0.55)' }}>
              לחיוב שנתי
            </span>
            <span className="pricing-save-chip">{`חיסכון של ₪${yearlySavings(plan)} בשנה`}</span>
          </div>
        )}
      </div>

      {/* The prominent list takes the card's slack, so whatever height the two
          cards do not share lands as breathing room above the quiet panel
          rather than as a gap in the middle of the copy. */}
      <div className="flex-1 flex flex-col">
        <p
          className="text-sm font-bold mb-4"
          style={{ color: highlighted ? 'rgba(0,210,210,0.95)' : 'rgba(255,255,255,0.5)' }}
        >
          {lead}
        </p>
        <ul className="flex flex-col gap-3.5">
          {features.map((f) => (
            <li key={f.text} className="flex items-start gap-2.5">
              <span className="pricing-check" aria-hidden>
                <Check size={12} strokeWidth={3.25} />
              </span>
              <span className="text-base leading-snug" style={{ color: 'rgba(255,255,255,0.9)' }}>
                {f.text}
                {/* The qualifier is its own line, not a "· note" appended to the
                    sentence. Inline, it wrapped at 150% and stranded the middot
                    at the start of the next line, where it read as a bullet. */}
                {f.note && <span className="pricing-note">{f.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Both cards carry a quiet panel here, which is what makes the pair
          structurally identical. Pro's resolves its own cross-reference with
          chips; Basic's says who the plan is for. */}
      <div className="pricing-panel mt-7">
        <p className="pricing-panel-label">{panelLabel}</p>
        {panelText && <p className="pricing-panel-text">{panelText}</p>}
        {chips && (
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {chips.map((chip) => (
              <span key={chip} className="pricing-chip">
                {chip}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* The recommended plan keeps the page's filled gradient CTA; the other
          takes an outlined one. Two identically-loud buttons made the pair a
          coin toss — an outline still reads as a legitimate choice, which a
          greyed-out button would not. `cta-shine` is a hover-only sweep, not a
          loop: nothing animates at rest at the decision moment. */}
      <div className="mt-6 flex flex-col items-center gap-2.5">
        <Link
          href="/signup"
          className={`w-full py-3.5 rounded-xl text-base font-bold text-center ${
            highlighted ? 'landing-cta cta-shine text-black' : 'pricing-cta-ghost'
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

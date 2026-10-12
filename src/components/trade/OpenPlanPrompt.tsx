'use client';

import { CalendarClock } from 'lucide-react';

/**
 * "What happened to the plan you left open?" — asked at the top of the next
 * trade form (REF-82 §5.2).
 *
 * A plan still open from a previous day is either a trade that was taken and
 * never reported closed, or one that was never entered at all. Nothing else in
 * the app can tell the difference, and the difference is what makes "how many
 * trades today" true or false a week from now. So the next form asks.
 *
 *
 * TWO ANSWERS, AND NEITHER IS THE PREFERRED ONE
 * ---------------------------------------------
 *
 * "סגרתי אותה" hands the plan to the journal's existing close dialog
 * (components/journal/CloseTrade.tsx) rather than asking here — because a close
 * needs an exit price to produce a real P&L, and there is exactly one place in
 * this app that knows how to take one. A second, lighter "I closed it in
 * profit / at a loss" would be a second definition of a closed trade, which is
 * the bug lib/rules/tradeRuleContext.ts exists to have ended.
 *
 * "לא נכנסתי" writes status = 'not_entered' and nothing else. No confirmation
 * step: the user is answering a question the app asked them, the answer costs
 * them nothing, and it is reversible by closing the trade later.
 *
 * Both are `secondary`. Styling one as the primary action would be the app
 * guessing which of the two happened, and the whole reason this card exists is
 * that the app cannot know.
 *
 *
 * IT DOES NOT BLOCK
 * -----------------
 *
 * The card sits above the fields and the fields work regardless. "אחר כך"
 * hides one card for this opening of the sheet only — state in the parent, no
 * localStorage — so a trader who is mid-trade can get past it, and the question
 * is still asked next time rather than being answered by silence.
 *
 *
 * COLOUR AND WORDS
 * ----------------
 *
 * No red, no orange: §7 reserves red for money lost, and an unanswered
 * question is not a warning or a failure. The card is the plain surface used
 * elsewhere in the sheet, and every piece of meaning is in the sentence.
 *
 * Bidi (§9): the symbol is a Latin string and the date is numeric, and both sit
 * inside a Hebrew sentence, so each is isolated in its own `dir="ltr"` span.
 * The "ב־" that introduces the date stays OUTSIDE that span, in the RTL flow —
 * inside, it would be carried to the far end of the ltr run and read as though
 * it came after the date. Same reason RuleEventsCard keeps its separator out.
 */

export interface OpenPlanFromPreviousDay {
  id: string;
  symbol: string | null;
  strategy: string;
  /** Resolved via tradeDirection() in @/lib/pnl, never read off the row raw. */
  direction: 'long' | 'short';
  submitted_at: string;
  // ── Everything CloseTrade needs, carried so "סגרתי אותה" can open it
  //    without a second fetch ────────────────────────────────────────────────
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  rr_ratio: number;
  emotional_state: number;
  trade_reason: string;
  units: number | null;
  point_value: number | null;
  pnl_currency: string | null;
}

/** Matches the journal's row date, so the same plan reads the same in both. */
function fmtPlanDate(iso: string): string {
  return new Date(iso).toLocaleDateString('he-IL', {
    day: '2-digit', month: '2-digit', year: '2-digit',
  });
}

function directionWord(direction: 'long' | 'short'): string {
  return direction === 'long' ? 'לונג' : 'שורט';
}

/** What this plan is, as one phrase — reused in each button's accessible name
 *  so a screen reader can tell three identical "לא נכנסתי" buttons apart. */
function planDescription(plan: OpenPlanFromPreviousDay): string {
  return `${plan.symbol ?? plan.strategy}, ${directionWord(plan.direction)}, ${fmtPlanDate(plan.submitted_at)}`;
}

export default function OpenPlanPrompt({
  plans,
  headingId,
  onReportClosed,
  onMarkNotEntered,
  onDismiss,
  busyPlanId,
  error,
  registerFirstButton,
}: {
  plans: readonly OpenPlanFromPreviousDay[];
  headingId: string;
  /** Opens the journal's close dialog for this plan. */
  onReportClosed: (plan: OpenPlanFromPreviousDay) => void;
  /** Writes status = 'not_entered'. No confirmation. */
  onMarkNotEntered: (plan: OpenPlanFromPreviousDay) => void;
  /** Hides this card until the sheet is opened again. */
  onDismiss: (plan: OpenPlanFromPreviousDay) => void;
  /** The plan whose 'not_entered' write is in flight, if any. */
  busyPlanId: string | null;
  error: string;
  /** Lets the parent land focus on a surviving card after one is removed. */
  registerFirstButton: (planId: string, el: HTMLButtonElement | null) => void;
}) {
  if (plans.length === 0) return null;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border p-3 flex flex-col gap-3"
      style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)' }}
    >
      <div className="flex items-start gap-2">
        <CalendarClock
          aria-hidden="true"
          size={16}
          className="shrink-0 mt-0.5"
          style={{ color: 'var(--color-tg-muted)' }}
        />
        <div className="flex flex-col gap-0.5 min-w-0">
          {/* h3: the sheet's own title is the h2 (id={titleId}), so this is the
              next level down and the hierarchy stays correct (§9). */}
          <h3 id={headingId} className="text-sm font-semibold text-tg-text">
            {plans.length === 1 ? 'תוכנית שנשארה פתוחה' : 'תוכניות שנשארו פתוחות'}
          </h3>
          <p className="text-xs text-tg-text-2 leading-relaxed">
            {plans.length === 1
              ? 'תכננת אותה ביום קודם והיא עוד פתוחה. מה קרה איתה?'
              : 'תכננת אותן ביום קודם והן עוד פתוחות. מה קרה איתן?'}
          </p>
        </div>
      </div>

      <ul className="flex flex-col gap-2">
        {plans.map((plan) => {
          const description = planDescription(plan);
          const busy = busyPlanId === plan.id;
          return (
            <li
              key={plan.id}
              className="rounded-xl border p-3 flex flex-col gap-2.5"
              style={{ background: 'var(--color-tg-surface)', borderColor: 'var(--color-tg-border)' }}
            >
              <p className="text-sm text-tg-text leading-relaxed">
                תכננת {directionWord(plan.direction)} על{' '}
                <span dir="ltr" className="font-semibold whitespace-nowrap">
                  {plan.symbol ?? plan.strategy}
                </span>
                {' ב־'}
                <span dir="ltr" className="whitespace-nowrap">
                  <time dateTime={plan.submitted_at}>{fmtPlanDate(plan.submitted_at)}</time>
                </span>
                .
              </p>

              <div className="flex flex-wrap gap-2">
                {/* Real <button>s, not clickable rows (§9). The visible label is
                    short enough to read at a glance; the aria-label adds which
                    plan it belongs to, because the same three labels repeat on
                    every card and on their own they say nothing about which. */}
                <button
                  type="button"
                  // Block body: a ref callback's return value is meaningful in
                  // React 19, and this one must not hand back anything.
                  ref={(el) => { registerFirstButton(plan.id, el); }}
                  onClick={() => onReportClosed(plan)}
                  disabled={busy}
                  aria-label={`סגרתי אותה — ${description}`}
                  aria-haspopup="dialog"
                  className="h-9 px-3 rounded-xl text-xs font-semibold border transition-all disabled:opacity-40 bg-tg-surface-2 hover:bg-tg-border text-tg-text border-tg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tg-primary"
                >
                  סגרתי אותה
                </button>
                <button
                  type="button"
                  onClick={() => onMarkNotEntered(plan)}
                  disabled={busy}
                  aria-label={`לא נכנסתי — ${description}`}
                  className="h-9 px-3 rounded-xl text-xs font-semibold border transition-all disabled:opacity-40 bg-tg-surface-2 hover:bg-tg-border text-tg-text border-tg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tg-primary"
                >
                  {busy ? 'שומר...' : 'לא נכנסתי'}
                </button>
                <button
                  type="button"
                  onClick={() => onDismiss(plan)}
                  disabled={busy}
                  aria-label={`אחר כך — ${description}`}
                  className="h-9 px-3 rounded-xl text-xs font-semibold transition-all disabled:opacity-40 text-tg-text-2 hover:text-tg-text hover:bg-tg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tg-primary"
                >
                  אחר כך
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {/* role="alert" so a failed write is announced rather than only appearing.
          Muted text, not red: nothing has been lost, and §7 keeps red for money. */}
      {error && (
        <p role="alert" className="text-xs" style={{ color: 'var(--color-tg-text-2)' }}>
          {error}
        </p>
      )}
    </section>
  );
}

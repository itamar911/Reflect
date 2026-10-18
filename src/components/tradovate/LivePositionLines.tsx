'use client';

/**
 * "פוזיציה פתוחה · N חוזים ESZ6" — the one way this product says what a
 * trader is holding (REF-108 Stage 3).
 *
 * THREE CONSUMERS, ONE COMPONENT: the day panel on the trade form, the
 * dashboard greeting row, and every portfolio card on /accounts. They differ
 * in where they sit and in nothing else, and a second copy of the plural
 * rules or of the sentence below would be a second thing to keep in step.
 *
 *
 * IT DESCRIBES, IT DOES NOT INSTRUCT
 * ----------------------------------
 *
 * `TodayContextPanel`'s §8 constraint, and it binds here because this renders
 * inside it: every sentence is a statement of fact about what has already
 * happened. No "כדאי", no "שים לב", no advice shape at all — that is a
 * NinjaTrader vendor compliance requirement rather than a style preference.
 * "You are holding two contracts" passes; anything that reads as a nudge to
 * act on it does not.
 *
 *
 * WHY THERE IS NO NUMBER, AND WHY THE SENTENCE SAYING SO IS NOT OPTIONAL
 * ----------------------------------------------------------------------
 *
 * REF-108 asked for an unrealised P&L in dollars and we cannot produce one:
 * Market Data is Denied in our OAuth registration and the feed needs CME
 * sub-vendor registration. A trader who sees "position open" where they
 * expected a figure will assume the figure is loading, or broken, or that we
 * lost it. {@link NO_PRICE_NOTE} is the answer to that, rendered once under
 * the first line rather than per line, because it is a fact about the
 * product and not about the position.
 *
 * It also says what WILL happen — the P&L arrives when the trade closes —
 * which is true today: the import prices every finished round trip.
 *
 *
 * DIRECTION IS KNOWN AND DELIBERATELY NOT RENDERED
 * -------------------------------------------------
 *
 * `netPos` is signed, so a short is already distinguishable here. The line
 * reads the magnitude only, because that is the copy REF-108 specified. If a
 * trader asks for it, `netPos < 0` is the whole change.
 */

import type { LiveAccountLine } from '@/app/api/tradovate/live/route';

/**
 * Said once per surface, under the first line.
 *
 * Exported because `scripts/tradovate-today-check.ts` pins it: it is the
 * sentence that stops a missing number reading as a broken one, and a reword
 * should be a decision taken again rather than a diff waved through.
 */
export const NO_PRICE_NOTE = 'המחיר החי אינו זמין דרך הברוקר; הרווח/הפסד ייספר עם הסגירה.';

/**
 * How Hebrew counts contracts.
 *
 * One is "חוזה אחד" and two is "שני חוזים" — Hebrew has a dual, and "2
 * חוזים" reads as a translation rather than as a sentence. Three and up take
 * the numeral. The magnitude, never the sign: see the header.
 */
export function contractsLabel(netPos: number): string {
  const n = Math.abs(netPos);
  if (n === 1) return 'חוזה אחד';
  if (n === 2) return 'שני חוזים';
  return `${n} חוזים`;
}

/** One rendered line, for the suite and for the three consumers to share. */
export function positionLines(accounts: readonly LiveAccountLine[]): string[] {
  // The portfolio is named only when there is more than one of them. With a
  // single account it is noise on every line; with several it is the whole
  // point (REF-108, 16.10) — a trader with two evaluations needs to know
  // which one they are in.
  const named = accounts.length > 1;
  return accounts.flatMap((account) =>
    account.positions.map((position) => {
      const what = [contractsLabel(position.netPos), position.contractName]
        .filter((part): part is string => Boolean(part))
        .join(' ');
      return named ? `פוזיציה פתוחה · ${what} · ${account.displayName}` : `פוזיציה פתוחה · ${what}`;
    })
  );
}

/**
 * The lines, or nothing at all.
 *
 * NULL RENDER WHEN EMPTY, which is the behaviour all three consumers need:
 * a trader who is flat should see no trace of this feature, not an empty
 * container with a heading. The one exception is `LivePnlSlot`, whose box
 * stays at its fixed height either way — that is the slot's job, not this
 * component's, and the slot renders this inside the box it already reserved.
 */
export default function LivePositionLines({ accounts, compact = false }: {
  accounts: readonly LiveAccountLine[];
  /** Tighter type for the portfolio card, which has less room than a panel. */
  compact?: boolean;
}) {
  const lines = positionLines(accounts);
  if (lines.length === 0) return null;

  return (
    <div dir="rtl" className="flex flex-col gap-0.5">
      {lines.map((line) => (
        <p
          key={line}
          className={compact ? 'text-[11px] font-semibold truncate' : 'text-xs font-semibold'}
          style={{ color: 'var(--color-tg-text)' }}
        >
          {line}
        </p>
      ))}
      <p
        className={compact ? 'text-[10px] leading-snug' : 'text-[11px] leading-snug'}
        style={{ color: 'var(--color-tg-muted)' }}
      >
        {NO_PRICE_NOTE}
      </p>
    </div>
  );
}

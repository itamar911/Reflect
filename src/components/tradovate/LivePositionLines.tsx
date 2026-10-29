'use client';

/**
 * "פוזיציה פתוחה · שני חוזים ESZ6 · +$120" — the one way this product says
 * what a trader is holding and what it is currently worth (REF-108 Stage 4b).
 *
 * THREE CONSUMERS, ONE COMPONENT: the day panel on the trade form, the
 * dashboard greeting row, and every portfolio card on /accounts. They differ
 * in LAYOUT and in nothing else, and a second copy of the plural rules, the
 * money formatting or the colour decision would be three things to keep in
 * step rather than one.
 *
 *
 * IT DESCRIBES, IT DOES NOT INSTRUCT
 * ----------------------------------
 *
 * `TodayContextPanel`'s §8 constraint, and it binds here because this renders
 * inside it: every sentence is a statement of fact about what has already
 * happened. No "כדאי", no "שים לב", no advice shape at all — that is a
 * NinjaTrader vendor compliance requirement rather than a style preference.
 *
 * **A FIGURE PASSES THAT TEST AND A FRAME AROUND IT MAY NOT.** "+$120" is a
 * fact. An arrow that reads as momentum, a word like "הרווח שלך", anything
 * that turns the number into a prompt to act — does not.
 * `scripts/tradovate-today-check.ts` asserts the absence of an imperative over
 * {@link liveRows}' own output, which is where the copy now lives.
 *
 *
 * THE FIGURE IS PER PORTFOLIO, NOT PER POSITION, AND THE COPY SAYS SO
 * -------------------------------------------------------------------
 *
 * `/cashBalance/getcashbalancesnapshot` takes an `accountId` and answers with
 * an account-level aggregate (REF-108 Stage 4a). So a portfolio holding ES and
 * NQ has ONE figure covering both, and there is no way to ask for either leg.
 *
 * With one contract in the portfolio that is invisible — the figure sits on the
 * line and means exactly what it looks like. With two or more it would be a
 * lie by placement, so the figure moves to its own row carrying
 * {@link PORTFOLIO_TOTAL}: the qualifier does the disambiguating work rather
 * than the reader's assumption about which line a number belongs to. Imri's
 * 20.10 clarification asked for exactly this and it is also the only honest
 * option.
 *
 *
 * WHY THERE IS NO LONGER A SENTENCE EXPLAINING THE MISSING NUMBER
 * ---------------------------------------------------------------
 *
 * Stage 3 rendered `NO_PRICE_NOTE` — "המחיר החי אינו זמין דרך הברוקר; הרווח/הפסד
 * ייספר עם הסגירה." — under the first line, because a trader who saw "position
 * open" where they expected a figure would assume it was loading or broken.
 * That sentence was true while the number could NEVER arrive.
 *
 * It arrives now, so the sentence is gone and **nothing replaced it.** A
 * missing figure renders as silence: no "—", no "לא זמין", no second sentence
 * about a transient failure. Three reasons, in order:
 *
 * 1. "פוזיציה פתוחה · שני חוזים ESZ6" is a COMPLETE AND TRUE sentence on its
 *    own — it is exactly what shipped in Stage 3 and it is the floor this
 *    falls back to.
 * 2. An explanation of a failure that resolves itself on the next fifteen-second
 *    poll is noise that outlives the condition it describes.
 * 3. `LivePnlSlot`'s box is a fixed height either way, so the absence costs no
 *    layout movement.
 *
 * Deleting the constant deleted its two pinning assertions too, which is what
 * pinning copy is for: the reword had to be a decision taken again rather than
 * a diff waved through.
 *
 *
 * AND THAT SILENCE IS NOW THE SHIPPING STATE, NOT THE FALLBACK (29.10)
 * --------------------------------------------------------------------
 *
 * NinjaTrader confirmed that account-level open P&L falls under our Market Data
 * denial and needs a CME ILA, so `TRADOVATE_LIVE_PNL_ENABLED` is unset at
 * launch and `openPnl` arrives `null` for every account
 * (lib/tradovate/live-pnl.ts). **THE GATE IS SERVER-SIDE AND THIS FILE HAS NO
 * FLAG OF ITS OWN** — it needs none, because `null` already renders as the
 * position and nothing else: the line keeps its contract and its quantity, the
 * figure is absent, and {@link PORTFOLIO_TOTAL} is not emitted at all, since
 * `hasTotal` is false and a row carrying only a qualifier would explain an
 * absence.
 *
 * SO THE THREE REASONS ABOVE ARE NOW LOAD-BEARING RATHER THAN TIDY. Do not
 * "improve" the null path into a "—", a "לא זמין", a tooltip or a sentence
 * about a licence: on this surface the absence must read as a feature that
 * reports positions, not as one that is broken or waiting. `scripts/tradovate-today-check.ts`
 * asserts the gated rows carry no money, no qualifier and no new copy.
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
import { formatMoney } from '@/lib/money';
import { moreLinesText } from '@/lib/rules/todayLines';

/**
 * Which shape a surface wants.
 *
 * - `positions` — a line per contract, the figure on the portfolio. The day
 *   panel and the portfolio card, which are about what is open.
 * - `portfolios` — a line per portfolio, named, with its figure. The dashboard
 *   greeting row, which is about which portfolios are live right now (Imri,
 *   20.10).
 */
export type LiveLayout = 'positions' | 'portfolios';

/**
 * The qualifier on a figure that covers more than one line.
 *
 * Exported because the suite pins it: it is the only thing standing between a
 * per-account aggregate and a reader who adds two numbers together.
 */
export const PORTFOLIO_TOTAL = '(סה״כ בתיק)';

/**
 * One compact row's height in px: `text-[11px] leading-tight` is 11 × 1.25.
 *
 * MEASURED, NOT DERIVED FROM TAILWIND'S DEFAULTS — `globals.css` overrides the
 * whole type scale up one step, so reasoning from the class names alone gives
 * the wrong number. 13.75px is what Chromium reports for these rows and it
 * matches the three-row figure the `totalFirst` note below records (41.25px).
 *
 * Exported for one reason: the suite multiplies it by {@link COMPACT_MAX_ROWS}
 * and compares the product against `SLOT_HEIGHT`. See that constant.
 */
export const COMPACT_ROW_PX = 13.75;

/**
 * How many rows the portfolio card's box can hold. Three.
 *
 * ARITHMETIC, AND THE REAL FAILURE HERE WAS THAT NOBODY HAD WRITTEN IT DOWN:
 *
 *     3 × 13.75px = 41.25px  ≤  44px   fits, 2.75px spare
 *     4 × 13.75px = 55.00px  >  44px   overflows by 11px
 *
 * `LivePnlSlot` is `height: 44, overflow: 'hidden'` and its header forbids
 * changing that, with good reason — a slot that grows when it acquires content
 * reflows the card on every fifteen-second poll. So the fourth row is not
 * clipped elegantly, it is clipped SILENTLY: no ellipsis, no scrollbar, nothing
 * on screen saying a row existed. A portfolio holding three instruments showed
 * two of them and the total, and looked complete.
 *
 * The `totalFirst` note below already predicted this ("a portfolio holding four
 * or five contracts — which no tightening can fit — loses a contract line to
 * the clip") and accepted it. That is defensible at four or five and surprising
 * at THREE, which is an ordinary number of instruments to hold.
 *
 * WHAT THE NUMBER IS NOT: it is not a count of contracts. `account.positions`
 * is one entry per distinct CONTRACT, and `contractsLabel` renders the quantity
 * as text inside one row — so a trader holding twelve of one instrument has one
 * line and the most comfortable case there is. Row count is driven by how many
 * different instruments are open, never by how many contracts.
 *
 * NOT ENFORCED HERE BY IMPORTING `SLOT_HEIGHT`, deliberately: LivePnlSlot
 * imports LivePositions which imports this file, so reading the height here
 * would be an import cycle. The cross-check is an assertion in
 * scripts/tradovate-today-check.ts, which can see both.
 */
export const COMPACT_MAX_ROWS = 3;

/** One rendered row. `money` is null when there is no figure to show. */
export interface LiveRow {
  key: string;
  text: string;
  money: number | null;
}

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

/**
 * The rows for a surface, as data — so the suite can assert the copy and the
 * figure placement without a DOM.
 *
 * ALL THE POLICY IS HERE AND NONE OF IT IS IN THE COMPONENT, which is the same
 * split `liveClock.ts` uses for the poll: what is decidable without a browser
 * is decided in a pure function and asserted there.
 */
export function liveRows(
  accounts: readonly LiveAccountLine[],
  layout: LiveLayout,
  options: {
    totalFirst?: boolean;
    /**
     * The most rows one account may render. Unset means no ceiling, which is
     * the two surfaces that have none — the day panel and the dashboard both
     * grow with their content.
     *
     * The portfolio card passes {@link COMPACT_MAX_ROWS}. It is a parameter
     * rather than a flag read off `totalFirst` because the two are different
     * decisions about the same box: one is reading order, this is capacity.
     */
    maxRows?: number;
  } = {}
): LiveRow[] {
  if (layout === 'portfolios') {
    // ONE ROW PER PORTFOLIO, NAMED, WHATEVER THE CONTRACTS ARE. The dashboard
    // asks which portfolios are live, not what is in them — and with two
    // contracts in one portfolio there is no single contract to name anyway.
    //
    // The name comes FIRST, as the 20.10 requirement words it, and the two
    // words after it are what stop a bare label reading as a heading. They are
    // also the Stage 3 floor: when `openPnl` is null this row still says
    // something true.
    return accounts.map((account) => ({
      key: account.accountId,
      text: `${account.displayName} · פוזיציה פתוחה`,
      money: account.openPnl,
    }));
  }

  // The portfolio is named on a position line only when there is more than one
  // of them. With a single account it is noise on every line; with several it
  // is the whole point (REF-108, 16.10) — a trader with two evaluations needs
  // to know which one they are in.
  const named = accounts.length > 1;

  return accounts.flatMap((account) => {
    const lines = account.positions.map((position, index) => {
      const what = [contractsLabel(position.netPos), position.contractName]
        .filter((part): part is string => Boolean(part))
        .join(' ');
      const text = named
        ? `פוזיציה פתוחה · ${what} · ${account.displayName}`
        : `פוזיציה פתוחה · ${what}`;
      return { key: `${account.accountId}:${index}`, text, money: null as number | null };
    });

    if (lines.length === 0) return lines;

    // ONE CONTRACT: the figure IS this line's, so it goes on it.
    if (lines.length === 1) {
      lines[0].money = account.openPnl;
      return lines;
    }

    // TWO OR MORE: the figure covers all of them and belongs to none, so it
    // gets its own row and says so. Omitted entirely when there is no figure —
    // a row carrying only a qualifier would explain an absence.
    const hasTotal = account.openPnl !== null;

    // ── THE CEILING, AND WHAT GOES OVER IT (REF-107 follow-up) ─────────────
    //
    // `maxRows` is the portfolio card's 44px box expressed as a row count; see
    // COMPACT_MAX_ROWS for the arithmetic. Over it, the box CLIPS IN SILENCE —
    // no ellipsis, no scrollbar — so a portfolio holding three instruments
    // showed two and the total and looked complete. The figure was never what
    // got cut (`totalFirst` sees to that); what got cut was a whole instrument.
    //
    // So the count goes where the reader is already looking: the row that
    // exists anyway says how many lines are not on screen. The trader loses the
    // per-contract detail they were already losing, and gains the fact that
    // there is more — with /accounts' own list behind the card for the rest.
    //
    // ONE ROW IS SPENT ON THE FOLD WHETHER OR NOT THERE IS A FIGURE. With a
    // figure the total row is already there and only its text changes; without
    // one, a row has to carry "ועוד N" or the fold is as silent as the clip
    // was. That is why the reservation is `cap - 1` in both branches.
    const cap = options.maxRows ?? Infinity;
    const wanted = lines.length + (hasTotal ? 1 : 0);

    if (wanted > cap) {
      const shown = lines.slice(0, cap - 1);
      const more = lines.length - shown.length;
      // `moreLinesText` and not a local template: "ועוד N" is already this
      // product's idiom for a capped list (lib/rules/todayLines.ts, the day
      // panel's own overflow), and two spellings of it would be two things to
      // keep in step. The count is INSTRUMENTS, not contracts — so it is
      // deliberately not run through `contractsLabel`, which counts quantity
      // and would read as a position size.
      const folded = {
        key: `${account.accountId}:total`,
        text: hasTotal ? `${PORTFOLIO_TOTAL} · ${moreLinesText(more)}` : moreLinesText(more),
        money: account.openPnl,
      };
      return options.totalFirst ? [folded, ...shown] : [...shown, folded];
    }

    if (!hasTotal) return lines;

    const total = {
      key: `${account.accountId}:total`,
      text: PORTFOLIO_TOTAL,
      money: account.openPnl,
    };

    // `totalFirst` IS THE PORTFOLIO CARD, AND IT IS A CLIPPING DECISION
    // MEASURED RATHER THAN GUESSED.
    //
    // `LivePnlSlot` is a fixed 44px with `overflow: hidden` and its header
    // forbids changing that. Measured in the browser: three 11px rows are
    // 53.5px at the default line height, so a portfolio holding two contracts
    // overflowed by 9.5px — and what the box cut off was the THIRD row, which
    // is the one carrying the figure. The worst available failure.
    //
    // Two things fix it together. The compact rows are tightened (see the
    // component below), which brings three rows to 41.25px and inside the box;
    // and the figure moves to the TOP, so that a portfolio with more
    // instruments than the box can hold loses a contract line and never the
    // number.
    //
    // THAT LOSS IS NO LONGER SILENT, which is what the `maxRows` branch below
    // added: the overflow is folded into this very row as "ועוד N" instead of
    // being clipped by the box. `totalFirst` still matters — it is what makes
    // the surviving row the one carrying both the figure and the count.
    //
    // This is not a divergence invented here: `LivePnlSlot`'s own header says
    // the figure sits above the realised ones because "live P&L is the first
    // number a trader looks for... a figure they have to scroll past is in the
    // wrong place". The panel has room for the reading order the copy implies;
    // the card does not, and it already said which way it would resolve that.
    return options.totalFirst ? [total, ...lines] : [...lines, total];
  });
}

/**
 * Which colour a figure is drawn in.
 *
 * GREEN UP, RED DOWN, MUTED AT ZERO. A break-even position is a fact and not a
 * non-answer (Stage 4a's `null` is the non-answer and never reaches here), but
 * it is not a gain either, and colouring it green would read as one.
 *
 * **THE COLOUR IS NOT THE SIGNAL.** `formatMoney`'s `sign: 'auto'` puts a `+`
 * or a `-` in the text, so direction survives for a reader who cannot see
 * colour and for a screen reader. That is not an accessibility extra bolted
 * on — it is what the existing formatter already does, and the reason this
 * function may decide a hue and nothing else.
 */
export function moneyColour(money: number): string {
  if (money > 0) return 'var(--live-pnl-gain)';
  if (money < 0) return 'var(--live-pnl-loss)';
  return 'var(--color-tg-muted)';
}

/**
 * Whether a figure is drawn at all.
 *
 * ONE LINE, EXPORTED, AND IT EARNED THAT. It was `if (!money) return null`
 * inside the component, which is the same thing for every value except the one
 * that matters: **`0` is falsy**, so a break-even position silently lost its
 * "$0" while every assertion still passed. A sabotage check found it — the
 * node suite cannot render React, so a decision taken inside a component is a
 * decision nothing tests.
 *
 * So the rule lives out here with the rest of the policy, where the suite
 * reaches it: `null` is silence, and every finite number including zero is a
 * figure. That is the same `null`-is-not-`0` line Stage 4a drew in
 * `readOpenPnl`, and it has to survive all the way to the glyph to mean
 * anything.
 */
export function rendersMoney(money: number | null): boolean {
  return money !== null;
}

/** The figure, or nothing at all. Never a dash and never an explanation. */
function Money({ money, compact }: { money: number | null; compact: boolean }) {
  if (money === null || !rendersMoney(money)) return null;
  return (
    <span
      // LTR on the amount alone. "+$120" is a left-to-right token inside an
      // RTL sentence, and without this the sign lands on the wrong end of it.
      dir="ltr"
      // `shrink-0`: the figure is the point of the row. A long contract name
      // truncates; the number does not.
      className={compact ? 'text-[11px] font-bold shrink-0' : 'text-xs font-bold shrink-0'}
      style={{ color: moneyColour(money) }}
    >
      {/* Whole dollars: this is read at a glance on an 11px line, and two
          decimals on a figure that moves every fifteen seconds is motion
          without information. `sign: 'auto'` is the default and is what puts
          the + on a gain. */}
      {formatMoney(money, { decimals: 0 })}
    </span>
  );
}

/**
 * The rows, or nothing at all.
 *
 * NULL RENDER WHEN EMPTY, which is the behaviour all three consumers need:
 * a trader who is flat should see no trace of this feature, not an empty
 * container with a heading. The one exception is `LivePnlSlot`, whose box
 * stays at its fixed height either way — that is the slot's job, not this
 * component's, and the slot renders this inside the box it already reserved.
 */
export default function LivePositionLines({
  accounts,
  compact = false,
  layout = 'positions',
}: {
  accounts: readonly LiveAccountLine[];
  /** Tighter type for the portfolio card, which has less room than a panel. */
  compact?: boolean;
  layout?: LiveLayout;
}) {
  // Both options are the card's 44px box, and only the card's. `totalFirst`
  // keeps the figure out of the clip; `maxRows` means there is nothing left to
  // clip — see COMPACT_MAX_ROWS. The panel and the dashboard grow instead.
  const rows = liveRows(accounts, layout, {
    totalFirst: compact,
    maxRows: compact ? COMPACT_MAX_ROWS : undefined,
  });
  if (rows.length === 0) return null;

  return (
    // `live-pnl-colours` carries the two measured hues — see globals.css. On
    // the root so every row inherits them, and so the component works on all
    // three surfaces without the parent having to provide anything.
    //
    // `gap-0` AND `leading-tight` WHEN COMPACT, measured: the card's box is a
    // fixed 44px and three default-leading 11px rows are 53.5px. Tightened they
    // are 41.25px, which is the two-contract case inside the box with room to
    // spare. The panel and the dashboard have no such ceiling and keep the
    // looser rhythm.
    <div dir="rtl" className={`live-pnl-colours flex flex-col ${compact ? 'gap-0' : 'gap-0.5'}`}>
      {rows.map((row) => (
        <p
          key={row.key}
          className={
            compact
              ? 'text-[11px] leading-tight font-semibold flex items-center gap-1.5'
              : 'text-xs font-semibold flex items-center gap-1.5'
          }
          style={{ color: 'var(--color-tg-text)' }}
        >
          {/* `min-w-0` is what lets `truncate` actually bite inside a flex row:
              without it the text span refuses to shrink and the FIGURE is what
              gets pushed out of the card instead. */}
          <span className={compact ? 'truncate min-w-0' : undefined}>{row.text}</span>
          <Money money={row.money} compact={compact} />
        </p>
      ))}
    </div>
  );
}

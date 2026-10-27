/**
 * The R:R the trade ACTUALLY returned, measured against the stop the broker
 * held (REF-123).
 *
 * `rr_ratio` is a planned figure and nothing in the product has ever reported
 * the realised one. The trader is shown what they intended to risk for what
 * they intended to make, and then — two rows down — the price they actually got
 * out at, with the arithmetic between the two left to them.
 *
 * THE DENOMINATOR IS THE BROKER'S STOP AND NOT THE PLANNED ONE, which is the
 * whole reason this is worth a module. `|entry - stop_loss|` would measure the
 * trade against a number the trader typed into a form, and a stop that was
 * never placed, moved before the position opened, or placed at a different
 * price is exactly the case a journal exists to catch. `broker_stop_loss` is
 * the stop the position OPENED UNDER (migration 038, REF-113), so this ratio
 * answers "what did I make for what I was really risking".
 *
 *
 * IT REUSES `brokerStopToShow` RATHER THAN READING THE COLUMN
 * ----------------------------------------------------------
 *
 * Not for brevity — for a property. That function is the single definition of
 * "the broker stop a trader may be shown", and it already withholds the number
 * for the three reasons that matter here (./stopHistory.ts): no document at all,
 * `verdict === 'none'`, and `initialStopSide === 'wrong'` — an order that cannot
 * have been a protective stop, because the other side of the entry fills the
 * instant it reaches the book.
 *
 * So this module cannot produce a ratio from a price the card declines to
 * print. On the trade card the two sit a few rows apart: `סטופ בברוקר` shows
 * the number and this shows what it bought. If the denominator could differ
 * from the printed stop, the trader could check the division by hand and find
 * it wrong — and they would be right.
 *
 * The 'wrong'-side case is the one that would have shipped a real falsehood.
 * On 19.10 a long stored an initial stop 148 ticks ABOVE its entry; dividing by
 * that distance yields a confident, precise, meaningless ratio.
 *
 *
 * ZERO IS NULL HERE AND `0` IN `calcRR`, DELIBERATELY
 * ---------------------------------------------------
 *
 * `lib/utils.ts: calcRR` returns 0 on a zero risk, which is right for a form
 * that wants a number to put in a box while the trader is still typing. A
 * REALISED 0 would be a measurement, and it reads as "this trade returned
 * nothing" — a claim about the trade, made because entry and stop happened to
 * be the same price. There is no ratio to report, so there is no number.
 *
 *
 * MAGNITUDE ONLY, WHICH MEANS A LOSS AND A WIN CAN SHARE A RATIO
 * --------------------------------------------------------------
 *
 * `|exit - entry|` is the same absolute reading `calcRR` takes, so a trade that
 * lost 0.4R and one that made 0.4R both report `0.4`. That is intentional —
 * this field answers "how big, in units of the risk", and the direction of the
 * result is already stated beside it everywhere it is rendered: the trade card
 * carries the money figure in its heading and the facts line opens with
 * `[רווח]` or `[הפסד]`. A signed ratio would also have to decide what sign a
 * scratch is, and nothing needs that answer.
 *
 * DISPLAY-ONLY, AND IT MUST STAY THAT WAY. No column, no migration, and
 * deliberately not an input to `computeTradeScore`: the score is a plan score,
 * and charging or crediting a trader for the ratio the market handed them is a
 * different product decision than this one.
 *
 * BROWSER-SAFE AND PURE, for the reason ./stopHistory.ts states: the trade card
 * runs in the browser, the facts module runs on a server, and the regression
 * suite drives both without either.
 */

import { intentNumber, type RawValue } from '@/lib/intent';
import { brokerStopToShow, type StoredStopHistory } from './stopHistory';

/**
 * The realised reward-to-risk, or null when there is none to state.
 *
 * TAKES THE DOCUMENT AND THE COLUMN IN THAT ORDER, mirroring
 * {@link brokerStopToShow} — both call sites already hold all four values, and
 * the two functions reading the same pair the same way is what keeps the
 * displayed stop and the ratio over it in step.
 *
 * Null for five reasons, and every one of them means SAY NOTHING rather than
 * show a dash beside a figure:
 *
 *   - the broker stop is unavailable or unusable (all three of
 *     {@link brokerStopToShow}'s cases, including `initialStopSide === 'wrong'`)
 *   - `entry_price` is missing or unreadable
 *   - `exit_price` is missing — the trade is still open, and an open trade has
 *     no realised anything
 *   - the denominator is 0 (entry and stop at the same price)
 *
 * Rounded to two decimals like `calcRR`, so a realised ratio and a planned one
 * carry the same precision. The one-decimal display is {@link rrLabel}'s job.
 */
export function realisedRr(
  history: StoredStopHistory | null,
  brokerStopColumn: unknown,
  entryPrice: RawValue,
  exitPrice: RawValue
): number | null {
  const stop = brokerStopToShow(history, brokerStopColumn);
  if (stop === null) return null;

  // Through `intentNumber` and not a `typeof` test: Postgres NUMERIC arrives as
  // a STRING over PostgREST, and these two prices come back through the same
  // client as the stop inside the document does (./stopHistory.ts: `num`).
  const entry = intentNumber(entryPrice);
  const exit = intentNumber(exitPrice);
  if (entry === null || exit === null) return null;

  const risk = Math.abs(entry - stop);
  if (risk === 0) return null;

  return Math.round((Math.abs(exit - entry) / risk) * 100) / 100;
}

/**
 * An R:R as this product writes one: `1:2.1`.
 *
 * ONE DECIMAL, AND A WHOLE RATIO KEEPS NONE. `1:3` is what a trader set as
 * their minimum and `1:3.0` is a precision the figure does not have; the
 * decimal appears when it carries information. `toFixed(1)` alone is the
 * existing convention (lib/identity.ts) and is kept for everything else.
 *
 * Lives here rather than in lib/utils.ts because the paired row this ticket
 * adds — planned beside realised — is the first place in the product that
 * renders two of these in one string, and the first that needed them to agree.
 */
export function rrLabel(value: number): string {
  return `1:${Number(value.toFixed(1))}`;
}

/**
 * The trade card's R:R row, as one string — or null when neither figure exists.
 *
 * WHY THE ROW IS BUILT HERE AND NOT IN THE COMPONENT: the three shapes are a
 * product decision with a reason each, and the component renders a flat
 * `[label, value]` table where that reasoning has nowhere to live.
 *
 *   both       `תוכנן 1:3 · בפועל 1:1.5` — the comparison is the point, and it
 *              is the same ` · ` the stop rows and the facts line use.
 *   realised   `בפועל 1:2.1` — labelled even when it is alone, because an
 *              unlabelled ratio on an imported row would read as the plan the
 *              trader never wrote.
 *   planned    THE RAW NUMBER, UNCHANGED. Every trade in the journal today
 *              renders `3` in this row, and prefixing `1:` to all of them is a
 *              display change to historic rows that this ticket is not.
 */
export function rrRow(planned: number | null, realised: number | null): string | null {
  if (realised === null) return planned === null ? null : String(planned);
  if (planned === null) return `בפועל ${rrLabel(realised)}`;
  return `תוכנן ${rrLabel(planned)} · בפועל ${rrLabel(realised)}`;
}

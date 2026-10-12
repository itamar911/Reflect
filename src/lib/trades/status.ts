import type { TradeStatus } from '@/lib/types';

/**
 * The one place that says what `not_entered` means to the rest of the app.
 *
 * `not_entered` is a plan the user confirmed they never took (REF-82 §5.2,
 * migration 032). It is a record of a decision, not a trade: there is no entry,
 * no exit price and no P&L.
 *
 * So it is NOT COUNTED ANYWHERE a trade is counted — not by the rule engine,
 * not in the statistics, not on the dashboard, not in the discipline score, not
 * in what the AI is told. The journal is the single exception, because the
 * journal's job is to show the user what they recorded, and a plan they decided
 * not to enter is something they recorded.
 *
 * Most readers get this for free: a filter written as `status === 'closed'`
 * already excludes it. The ones that did not were the ones that counted every
 * row — `select(...)` with no status filter at all — and those now exclude it at
 * the query, with `.neq('status', 'not_entered')`, so nothing downstream has to
 * remember. {@link isTradeTaken} is for the one place that deliberately loads
 * every row: the journal's All Trades page, which shows them and therefore has
 * to subtract them from its own total.
 */

/** A plan the user confirmed they never entered. Mirrors migration 032's CHECK. */
export const NOT_ENTERED: TradeStatus = 'not_entered';

/**
 * Was this row an actual trade?
 *
 * Phrased positively and over `status` alone — `open` and `closed` are both
 * trades that were taken, and only `not_entered` is not. Written as a type
 * guard-free predicate over a minimal shape so the dashboard's `DashTrade`, the
 * journal's local `Trade` and `TradePlan` can all be passed in.
 */
export function isTradeTaken(t: { status: string }): boolean {
  return t.status !== NOT_ENTERED;
}

/** What the user sees. Plain Hebrew, no status identifiers on screen (§7). */
export const NOT_ENTERED_LABEL = 'לא נכנסתי';

/**
 * The status as a word, for the journal row, the detail panel and the CSV.
 *
 * `open`/`closed` keep the wording that was already on screen. An unrecognised
 * value falls back to `closed` rather than printing itself, because the column
 * is free text in Postgres and an English identifier must never reach the
 * screen — the same reason RuleEventsCard guards `rule_key`.
 */
export function tradeStatusLabel(status: string): string {
  if (status === NOT_ENTERED) return NOT_ENTERED_LABEL;
  return status === 'open' ? 'פתוח' : 'סגור';
}

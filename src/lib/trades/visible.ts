/**
 * A hidden trade, and the one definition of what that means (REF-107 Stage 2,
 * E12).
 *
 * Browser-safe and PURE — no environment access, no client, no import of
 * anything server-only — because both halves of this product read trades: the
 * RSC pages and two browser components.
 *
 *
 * WHY "DELETE" ON A BROKER ROW IS A FLAG AND NOT A DELETE
 * ------------------------------------------------------
 *
 * Because a DELETE does not stick. The import is idempotent by
 * `broker_trade_key`, which means a row the trader deleted is a key the next
 * sync does not find — so it inserts it again, that evening or the next
 * morning. The partial UNIQUE in migration 034 prevents a DUPLICATE; it has no
 * memory of a deletion. E12's answer is `trade_plans.hidden`, and the import
 * skips a hidden key instead of resurrecting it (lib/tradovate/import.ts).
 *
 * The consequence is that every reader of `trade_plans` owes the trader this
 * filter. A row they deleted that still appears in the dashboard, in the win
 * rate or in the weekly summary is a delete button that does not work.
 *
 *
 * `=== true`, AND THE TWO OTHER VALUES ARE BOTH VISIBLE
 * ----------------------------------------------------
 *
 * `false` is the column's default on every row. `undefined` is what a reader
 * gets from a database where migration 034 has not been run yet, because
 * `select('*')` simply does not return the key. Both mean "show it", so the
 * test is for the one value that means otherwise — never `!row.hidden`, which
 * would be true for both of those and is the same shape of mistake as
 * `null <= 2` being `true` in JavaScript (REF-107 Stage 4 found that one in the
 * calendar).
 */

/** A row that may or may not carry the column. See the header on `undefined`. */
export interface MaybeHidden {
  hidden?: boolean | null;
}

/**
 * Whether the trader has deleted this row. Only `true` hides.
 *
 * Takes `object` and reads the field through a cast, which is deliberate rather
 * than lazy. `MaybeHidden` has nothing but optional members, so TypeScript's
 * weak-type check REFUSES every row type that does not itself declare `hidden`
 * — which is every row type in this codebase, since each page shapes its own.
 * Constraining to `object` lets one filter serve all of them; the alternative is
 * adding `hidden?: boolean` to a dozen local interfaces that never read it.
 */
export function isHiddenTrade(row: object): boolean {
  return (row as MaybeHidden).hidden === true;
}

/**
 * The rows a trader should see. Identity when nothing is hidden.
 *
 * Returns the SAME ARRAY when there is nothing to drop, so applying this to a
 * reader costs one pass and no allocation on the overwhelmingly common path —
 * which matters because it is applied to the stats page's unbounded read.
 */
export function visibleTrades<T extends object>(rows: T[]): T[] {
  return rows.some(isHiddenTrade) ? rows.filter((row) => !isHiddenTrade(row)) : rows;
}

/**
 * Add `hidden` to an explicit column list, but only where the column exists.
 *
 * FOR THE READERS THAT NAME THEIR COLUMNS. A `select('*')` reader gets `hidden`
 * for free the moment migration 034 has run and needs nothing from this — it
 * just calls {@link visibleTrades}. A reader with a column list has to ask for
 * it, and asking before 034 has run is a PostgREST 42703 that takes the whole
 * page down.
 *
 * `hiddenExists` IS NOT A GUESS AND IS NOT READ HERE. On the server it is
 * `isImportEnabled()` from lib/tradovate/import.ts — the flag the owner sets
 * AFTER running 034, which is the same gate everything else in Stage 2 hangs
 * on. In the browser it is a prop, passed down by the RSC page that already
 * evaluated it (see DashboardClient). This function stays pure so that one
 * module can serve both.
 *
 * When false, the returned string is the caller's own constant, unchanged — so
 * a deployment without the flag issues byte-identical queries to the ones that
 * shipped before Stage 2.
 */
export function withHidden(columns: string, hiddenExists: boolean): string {
  return hiddenExists ? `${columns},hidden` : columns;
}

/**
 * Scope a query to one portfolio, or leave it exactly as it was
 * (REF-110 Stage 5).
 *
 * THE SAME PROPERTY {@link withHidden} IS HERE FOR, and the valuable one:
 * when there is no filter — which is almost every page view, because absence
 * means all accounts — the caller gets back **its own query, untouched**, so
 * an unfiltered page issues the statement it issued before REF-110, byte for
 * byte. That is also what makes the feature safe on a deployment where
 * migration 037 has not been run: `resolveAccountParam` answers null there,
 * and null is the identity.
 *
 * IT TAKES THE QUERY AND NOT THE COLUMN LIST, which is the one place this
 * differs from `withHidden`, and the difference is not a preference. REF-110
 * §D.3 pencilled this in as "the column added via a `withAccount()` helper",
 * on the assumption that a reader with a named column list has to SELECT
 * `account_id` in order to filter on it. It does not: PostgREST filters on
 * columns a statement never projects, so the dashboard's `DASH_TRADE_SELECT`
 * needs no new entry and no row needs to carry an id nothing renders. What
 * does need the gate is the FILTER — `.eq('account_id', …)` against a
 * database without 037 is a PostgREST 42703 and a 500 on the page — and that
 * is what this guards.
 *
 * Typed structurally rather than against `PostgrestFilterBuilder`: this
 * module is browser-safe and pure by design (see the header), and importing
 * supabase-js's builder types here to describe one method would be the first
 * dependency in it.
 */
export function withAccount<Q extends { eq(column: string, value: string): Q }>(
  query: Q,
  accountId: string | null,
): Q {
  return accountId === null ? query : query.eq('account_id', accountId);
}

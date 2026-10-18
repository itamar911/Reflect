/**
 * `?account=<uuid>` — the one opt-in view (REF-110 Stage 5).
 *
 * PURE. The parsing half of the filter, with no client and no imports beyond
 * types, so the pages, the browser components and the suite all read the same
 * definition of what the parameter means.
 *
 *
 * ABSENCE MEANS ALL ACCOUNTS, AND THAT IS A PRODUCT DECISION
 * ----------------------------------------------------------
 *
 * Imri, 17.10: *"the trader's identity, stats, journal, rules and debrief are
 * always across all accounts by default. The account filter is an explicit,
 * opt-in view the trader picks… never a default, and never applied to the
 * rule engine. One trader, many portfolios, one discipline record."*
 *
 * So there is no stored preference, no cookie and no "last filter" — the URL
 * is the whole of the state. Two properties follow and both are wanted: the
 * view is shareable and back-button-correct, and a trader cannot end up
 * accidentally filtered a week later with no idea why their numbers are
 * wrong.
 *
 *
 * WHERE IT IS NEVER APPLIED
 * -------------------------
 *
 * The rule engine (`lib/rules/tradeRuleContext.ts`), `ai-chat`, `ai-coach`,
 * `ai-debrief`, `weekly-summary` and `send-alerts`. None of them imports this
 * module, and that is the enforcement: a discipline rule is about the trader,
 * not about one of their accounts — "I have lost $500 today" is true whichever
 * account it happened in, and a per-account view would let someone stay inside
 * every limit while breaking all of them together (REF-90 §3ב, written into
 * `lib/tradovate/accounts.ts` verbatim).
 *
 * Mechanically it is stronger than a decision: `loadTradeRuleContext`'s three
 * queries never select `account_id` at all, so the filter could not reach a
 * rule verdict even by accident.
 */

/** The query-string key. One constant, so the pages and the links agree. */
export const ACCOUNT_PARAM = 'account';

/** What a Next 16 page gets after awaiting `searchParams`. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * Postgres's own UUID shape, and the reason this is validated rather than
 * passed through.
 *
 * `account_id` is a UUID column. A malformed value reaching `.eq()` is not a
 * query that returns nothing — it is Postgres `22P02`, "invalid input syntax
 * for type uuid", which PostgREST returns as a 400 and the page renders as a
 * 500. So a junk parameter has to resolve to "no filter" BEFORE it reaches a
 * statement, and "no filter" is the honest answer anyway: `?account=💥` is
 * not a request to see nothing, it is a broken link.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The portfolio this page is scoped to, or null for all of them.
 *
 * `enabled` is `isImportEnabled()` — migration 037. Shut, this always answers
 * null, so a deployment without the column issues exactly the queries it
 * issued before REF-110 even if somebody follows a `?account=` link into it.
 *
 * A repeated parameter (`?account=a&account=b`) arrives as an array and
 * resolves to null rather than to its first element: two portfolios is not a
 * view this product offers, and quietly picking one of them would show the
 * trader a filtered page they did not ask for.
 */
export function resolveAccountParam(
  raw: string | string[] | undefined,
  enabled: boolean,
): string | null {
  if (!enabled) return null;
  if (typeof raw !== 'string') return null;
  return UUID.test(raw) ? raw : null;
}

/** `?account=<id>` on a path, or the bare path for "all accounts". */
export function accountHref(path: string, accountId: string | null): string {
  return accountId === null ? path : `${path}?${ACCOUNT_PARAM}=${accountId}`;
}

/**
 * The in-memory half — for `/stats`, and ONLY for `/stats`.
 *
 * REF-110 §D.3's sharpest finding, and the reason the filter is applied in
 * two different places rather than one: `/trades` and `/journal` both take
 * `.limit(1000)` BEFORE anything filters. A trader with 1,400 trades across
 * three accounts who filtered to one would be shown whatever subset of it
 * happened to fall inside the newest thousand rows — fewer trades than the
 * account holds, with nothing on the page to say so. Those two put the filter
 * in the WHERE clause.
 *
 * `/stats` reads everything, unbounded, so filtering the array it already has
 * is exact and costs one pass. It is also the only correct choice there: a
 * `.eq()` would be a second code path for the same question with no benefit.
 *
 * Returns the SAME ARRAY when there is no filter, matching `visibleTrades`,
 * so the unfiltered page — which is almost every page view — allocates
 * nothing.
 */
export function tradesInAccount<T extends { account_id?: string | null }>(
  rows: T[],
  accountId: string | null,
): T[] {
  if (accountId === null) return rows;
  return rows.filter((row) => (row.account_id ?? null) === accountId);
}

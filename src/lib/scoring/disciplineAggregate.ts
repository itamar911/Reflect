/**
 * The two discipline figures a trader can be quoted ACROSS trades, in one
 * place (REF-120 §2.4).
 *
 * `computeTradeScore` is the shared per-trade module and has been for a long
 * time. The AGGREGATE had no module at all and six separate definitions, and
 * two of them were visible to the same trader at the same time:
 *
 *   stats/page.tsx          the unweighted mean of four behaviour-flag rates.
 *                           THIS IS WHAT THE TRADER SEES.
 *   ai-chat/route.ts        30 points for `plan_score` being present, 30 for an
 *                           emotional state ≥ 3, 40 for an R:R ≥ 2, capped at
 *                           100. Different inputs entirely, quoted to the coach
 *                           as "ציון משמעת: X/100".
 *
 * So a trader who asked the coach for their discipline score and then opened
 * the statistics page saw two different numbers, and the coach's one appeared
 * nowhere else in the product. The formula below is the STATS PAGE'S, moved
 * here unchanged, and the coach now reads the same function rather than a
 * second opinion.
 *
 * THE OTHER FOUR DEFINITIONS ARE NOT TOUCHED BY THIS and are listed so the next
 * reader knows the set is not closed: `DashboardClient.tsx` builds a six-axis
 * radar, `weekly/stats.ts` means `plan_score` (which is {@link averagePlanScore}
 * by another name), `phone-showcase/page.tsx` is a marketing mock, and
 * `demo/fixtures.ts` means `plan_score` for `/demo/*`. Collapsing those is a
 * ticket of its own; this one stops the coach contradicting the stats page.
 *
 * PURE AND BROWSER-SAFE, because one caller is a server component and the other
 * is a route handler, and the regression suite drives both without either.
 */

/**
 * The four self-reported behaviour flags, as loosely as a caller may hold them.
 *
 * `unknown` RATHER THAN `boolean | null`, so a typed `TradePlan` and the
 * `select('*')` record the AI routes carry are both assignable without a cast
 * at either call site.
 */
export interface BehaviourFlagRow {
  followed_plan?: unknown;
  moved_sl?: unknown;
  fomo_entry?: unknown;
  revenge_trade?: unknown;
  plan_score?: unknown;
}

/**
 * Each component over its own denominator, then the unweighted mean — the stats
 * page's formula, and null when no row answers any of the four.
 *
 * ONE DENOMINATOR PER FLAG IS THE POINT. A trade with no self-report neither
 * earns nor forfeits its share: it is not evidence either way, and dividing by
 * the row count instead would read a broker import as a collapse in discipline.
 * Same rule lib/intent.ts states for the averages.
 *
 * A `typeof` TEST AND NOT `!== null`, which is the one thing that changed on the
 * way here. The inline version tested `!== null`, and on a row where the key is
 * ABSENT — every row from a `select('*')` against a database missing the column,
 * and every broker row read as a loose record — `undefined !== null` held, so
 * the row entered the denominator and then failed the `=== true` test. An
 * absence counted as a violation. Only a real boolean is an answer.
 */
export function behaviourDisciplineScore(rows: readonly BehaviourFlagRow[]): number | null {
  const rate = (pick: (row: BehaviourFlagRow) => unknown, good: boolean): number | null => {
    const answered = rows.filter((row) => typeof pick(row) === 'boolean');
    if (answered.length === 0) return null;
    return answered.filter((row) => pick(row) === good).length / answered.length;
  };

  const components = [
    rate((row) => row.followed_plan, true),
    rate((row) => row.moved_sl, false),
    rate((row) => row.fomo_entry, false),
    rate((row) => row.revenge_trade, false),
  ].filter((value): value is number => value !== null);

  if (components.length === 0) return null;
  return Math.round((components.reduce((sum, v) => sum + v, 0) / components.length) * 100);
}

/**
 * The mean stored `computeTradeScore` total, over the rows that carry one.
 *
 * THE FIGURE THE PER-TRADE MODULE ACTUALLY PRODUCES, which is why the coach is
 * told this one alongside the behaviour score: `plan_score` is written by the
 * debrief from `computeTradeScore`, so every number in it has a breakdown behind
 * it that the trader has already read on the trade itself. Identical formula to
 * `avgProcessScore` in lib/weekly/stats.ts, so the chat coach and the weekly
 * mail cannot drift.
 *
 * Null when no row is scored — never 0. A trader who has not run a debrief has
 * no process score, and a zero would read as a measured failure.
 */
export function averagePlanScore(rows: readonly BehaviourFlagRow[]): number | null {
  const scored = rows
    .map((row) => (row.plan_score == null || row.plan_score === '' ? null : Number(row.plan_score)))
    .filter((value): value is number => value !== null && Number.isFinite(value));

  if (scored.length === 0) return null;
  return Math.round(scored.reduce((sum, v) => sum + v, 0) / scored.length);
}

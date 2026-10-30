/**
 * ONE DAY'S DISCIPLINE, AND ONE DEFINITION OF IT (REF-125 follow-up item 2).
 *
 * PURE AND BROWSER-SAFE. Three callers: the share snapshot builder (server),
 * `SharedDayCard` and `cardImage` through the field it writes, and the
 * dashboard's "משמעת היום" card (browser). No client, no environment, no clock
 * — the rows are the argument.
 *
 *
 * WHY THIS MODULE EXISTS, AND WHAT IT IS NOT
 * ------------------------------------------
 *
 * The complaint was that the share card said 33% on a day the dashboard scored
 * 82. The investigation found that those are not two renderings of one number
 * and never were:
 *
 *   - The card's number is MEASURED. It pools two fractions whose denominator
 *     is "the trades that answered the question", so a trade with no evidence
 *     is counted in neither half.
 *   - The dashboard's radar score is the mean of SIX AXES, over the last 500
 *     closed trades with no date bound at all, and three of those axes resolve
 *     an empty denominator to 100 — "nothing against you on record". On an
 *     imported journal with little self-report it converges on ~83 by
 *     construction.
 *
 * THE PRODUCT DECISION (Imri, 30.10) IS THAT THE CARD KEEPS THE CONSERVATIVE
 * NUMBER. Importing the radar's forgiveness onto the one public surface would
 * mean counting a trade nobody reported on as a clean trade, in front of
 * strangers, about money. So this module is the card's rule, lifted out of the
 * snapshot builder so that the DASHBOARD can show it too — beside the radar,
 * labelled as the day's — and a trader can see the measured number and the
 * all-time one together instead of meeting them one screen apart.
 *
 * IT IS NOT THE RADAR'S FORMULA AND DOES NOT REPLACE IT. The radar still
 * computes its own six axes over its own period; item 2 gave it a period label
 * and left its arithmetic alone. Two numbers that mean different things are
 * fine as long as both say what they are.
 *
 *
 * THE THREE RULES THIS FILE IS THE SINGLE SOURCE OF
 * ------------------------------------------------
 *
 *   1. FRACTIONS ARE UNIFIED, NOT AVERAGED. One pooled `met / answered` over
 *      both questions, because averaging two percentages lets a 1/1 and a 2/10
 *      average to 60% — which is not a thing that happened to anybody.
 *   2. `answered` IS NEVER `rows.length`. A trade that recorded no answer is
 *      in neither the numerator nor the denominator. tradeScore.ts:218-237 is
 *      the hazard: the discipline booleans default to not-violated on a broker
 *      row, so "a trade entered on impulse and managed badly can collect the
 *      whole discipline block for having no evidence against it".
 *   3. NOTHING ANSWERED IS `null`, NEVER `0`. A zero on a public page would be
 *      defamatory of the trader's own day, and on the dashboard it would read
 *      as a measured collapse rather than as an unasked question.
 *
 * Those three were previously stated in `src/lib/share/snapshot.ts` and
 * IMPLEMENTED in three places — the builder, `cardImage.tsx:557-559` and
 * `SharedDayCard.tsx:325-327`, the last two being line-for-line copies of one
 * formula on the two surfaces that must never disagree. The snapshot now
 * carries the score as a field and both renderers read it.
 */

import { readStopHistory, stopWasWidened } from '@/lib/journal/stopHistory';

/**
 * A discipline count and the number of trades that answered the question.
 *
 * `answered` IS NEVER `rows.length` AND IS NEVER ZERO. A fraction with a zero
 * denominator is not a fraction, so {@link disciplineFraction} returns `null`
 * for the whole thing instead. A reader therefore never has to guard against a
 * division by zero, and `met <= answered` always holds.
 */
export interface DisciplineFraction {
  /** Trades on which the trader did the thing. */
  met: number;
  /** Trades that recorded an answer either way. */
  answered: number;
}

/**
 * A row as this module reads it: THREE FIELDS, ALL OPTIONAL, ALL `unknown`.
 *
 * `unknown` rather than `boolean | null` so that a `trade_plans` row from a
 * `select('*')`, a `ShareTradeRow` and a `DashTrade` are all assignable without
 * a cast at any call site — `BehaviourFlagRow` in ./disciplineAggregate.ts is
 * the existing precedent and gives the same reason.
 *
 * OPTIONAL RATHER THAN NULLABLE, which is the distinction lib/types.ts draws at
 * :108-110: a reader on a database where migration 038 has not run gets no
 * `stop_history` KEY at all, not a null one. Everything below is read through a
 * `== null` test or a `=== true`, never through truthiness.
 */
export interface DayDisciplineRow {
  followed_plan?: unknown;
  moved_sl?: unknown;
  stop_history?: unknown;
}

/** `followed_plan`, which is a plain self-report and has no second source. */
export function followedPlanOutcome(row: DayDisciplineRow): boolean | null {
  if (typeof row.followed_plan !== 'boolean') return null;
  return row.followed_plan;
}

/**
 * Whether this trade's stop was held, or `null` for "nothing answered".
 *
 * THE THREE-WAY ANSWER IS THE POINT, and the `null` is rule 2 above doing its
 * work. Read in order:
 *
 *   1. A READABLE `stop_history` DOCUMENT WINS, because it is the broker's
 *      evidence rather than a self-report, and `readStopHistory` has already
 *      refused the documents whose verdict cannot be trusted.
 *
 *        'kept'    → true.  We looked and it never moved.
 *        'moved'   → NOT WIDENED. `stopWasWidened` is the predicate the
 *                    widened-only rule and the trade score already share, so
 *                    "a widening happened" has one definition in the product.
 *                    A TIGHTENING IS THEREFORE HELD, which is Imri's 19.10
 *                    decision (stopHistory.ts:46-57): "a trader who moves a
 *                    stop TOWARD the profit is managing risk, not breaking
 *                    discipline."
 *        'none'    → NULL, AND THIS IS THE IMPORTANT ONE. We looked and there
 *                    was no stop at all. There is nothing to widen, so a
 *                    `true` here would credit a trade taken with NO STOP as
 *                    perfect stop discipline — the single most flattering
 *                    thing this number could say.
 *        'unknown' → NULL. "We looked and could not tell" must not read as
 *                    'kept'; stopHistory.ts:34-37 says so in as many words —
 *                    "a trader would be told their stop stayed put on the
 *                    strength of a read that failed".
 *
 *   2. NO DOCUMENT → the trader's own `moved_sl`. Coarser on purpose: a
 *      self-report cannot distinguish a tighten from a widen, so a `true`
 *      counts against. That is the conservative direction and it is the
 *      trader's own answer about their own trade, not an inference of ours.
 *
 *   3. NEITHER → null. Not counted, in either half.
 *
 * THE DOCUMENT IS WHY THE DASHBOARD HAD TO START SELECTING IT. A caller whose
 * rows carry no `stop_history` falls to step 2 on every row, which is a
 * DIFFERENT DENOMINATOR from the card's on exactly the broker-imported rows
 * where `moved_sl` is null — so the dashboard's day number and the card's would
 * have disagreed about the same trades. See `withBrokerColumns`.
 */
export function stopHeldOutcome(row: DayDisciplineRow): boolean | null {
  const history = readStopHistory(row.stop_history);
  if (history !== null) {
    if (history.verdict === 'kept') return true;
    if (history.verdict === 'moved') return !stopWasWidened(row.stop_history);
    // 'none' and 'unknown' — see the docblock. Fall through to no answer
    // rather than to the self-report: the document is the better evidence and
    // what it says is that this question does not apply to this trade.
    return null;
  }
  if (typeof row.moved_sl !== 'boolean') return null;
  return row.moved_sl !== true;
}

/**
 * Count a three-way predicate into a fraction, or into nothing.
 *
 * Returns null — never `{ met: 0, answered: 0 }` — when no row answered.
 * See {@link DisciplineFraction}.
 */
export function disciplineFraction(
  rows: readonly DayDisciplineRow[],
  outcome: (row: DayDisciplineRow) => boolean | null
): DisciplineFraction | null {
  let met = 0;
  let answered = 0;
  for (const row of rows) {
    const value = outcome(row);
    if (value === null) continue;
    answered++;
    if (value) met++;
  }
  return answered === 0 ? null : { met, answered };
}

/**
 * The pooled score over two fractions, or null.
 *
 * SEPARATE FROM {@link dayDiscipline} BECAUSE OF THE STORED CARDS. A snapshot
 * minted before this change has the two fractions and no `discipline` field, so
 * `readDailyShareSnapshot` derives the score from them with this function —
 * which is the same arithmetic the builder ran, so an old card renders the
 * number it always rendered and a new one carries it.
 *
 * POOLED AND NOT AVERAGED — rule 1. Every answered question counts once.
 */
export function pooledDisciplineScore(
  followedPlan: DisciplineFraction | null,
  stopHeld: DisciplineFraction | null
): number | null {
  const met = (followedPlan?.met ?? 0) + (stopHeld?.met ?? 0);
  const answered = (followedPlan?.answered ?? 0) + (stopHeld?.answered ?? 0);
  return answered === 0 ? null : Math.round((met / answered) * 100);
}

/** One day's discipline: the score, and the evidence it was computed from. */
export interface DayDiscipline {
  /** 0-100, or null when no trade answered either question. NEVER 0 for "unasked". */
  score: number | null;
  /** "עמד בתוכנית 4/5", or null. */
  followedPlan: DisciplineFraction | null;
  /** "הסטופ לא הורחק 3/4", or null. */
  stopHeld: DisciplineFraction | null;
}

/**
 * The day's discipline over a set of trades — THE function this module is for.
 *
 * TAKES THE ROWS IT IS GIVEN AND FILTERS NOTHING. Which trades belong to a day,
 * and whether a row is closed, priced or deleted, is the caller's question and
 * is already answered in two places that disagree about nothing:
 * `countedShareTrades` for the card and `todayTrades` on the dashboard. A
 * filter here would be a third opinion about the day, which is the defect
 * REF-125 Stage 1 existed to end.
 *
 * `{ score: null, followedPlan: null, stopHeld: null }` for an empty set, which
 * is the honest answer for a day with nothing in it and renders as `—`.
 */
export function dayDiscipline(rows: readonly DayDisciplineRow[]): DayDiscipline {
  const followedPlan = disciplineFraction(rows, followedPlanOutcome);
  const stopHeld = disciplineFraction(rows, stopHeldOutcome);
  return { score: pooledDisciplineScore(followedPlan, stopHeld), followedPlan, stopHeld };
}

/**
 * The two fractions as one evidence line — `4/5 · 3/4`.
 *
 * HERE AND NOT IN EITHER RENDERER, because both the PNG and the page print it
 * under the score and a subline that disagreed between them would be the worst
 * possible place for a copy to drift. Empty string when neither fraction was
 * answered, which both callers treat as "no subline".
 *
 * NOT LOCALISED AND DOES NOT NEED TO BE: it is digits and a separator. The
 * callers wrap it in their own bidi isolation — "4/5" in an RTL run is
 * reordered to "5/4" by the browser's own algorithm, which inverts a discipline
 * claim silently.
 *
 * TAKES THE TWO FRACTIONS AND NOT A {@link DayDiscipline}, so that a STORED
 * snapshot — which carries the same two fields beside a `discipline` score
 * rather than a `score` one — is an argument without being reshaped first.
 */
export function disciplineEvidenceLine(discipline: {
  followedPlan: DisciplineFraction | null;
  stopHeld: DisciplineFraction | null;
}): string {
  return [discipline.followedPlan, discipline.stopHeld]
    .filter((f): f is DisciplineFraction => f !== null)
    .map((f) => `${f.met}/${f.answered}`)
    .join(' · ');
}

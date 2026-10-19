/**
 * Which plan, if any, a broker trade belongs to (REF-107 Stage 3b, §B).
 *
 * PURE AND BROWSER-SAFE. No Supabase client, no fetch, no `process.env`, no
 * `Date.now()`, and — deliberately — no import from ./fills.ts, which is
 * server-only. The one import, ../symbols, is pure for the same reason and was
 * split out of here so the two sides of a symbol stop sharing a parser (see its
 * header). Both halves of Stage 3 need this answer: the import computes it
 * on the server to decide whether to write onto a plan or queue a row, and the
 * confirmation screen computes it in the browser to list the candidates for a
 * row that was queued. One rule, one module, two callers, and no way for the
 * screen to offer a candidate the import would have refused.
 *
 * That is why {@link MatchableTrade} is structural rather than `BrokerTrade`:
 * three fields are the whole of the broker's side of this question, and taking
 * the full type would drag the pricing chain into a client bundle.
 *
 *
 * THE RULE, AND THE ONE THING AT ITS CENTRE
 * -----------------------------------------
 *
 * A plan is a candidate when all of these hold (§B, and the Stage 3 decisions
 * comment settled every value in it):
 *
 *   1. `status = 'open'` — a plan already closed by hand is not waiting for an
 *      execution, and one marked `not_entered` is a trade the trader says they
 *      did not take.
 *   2. `source = 'manual'` — the trader submitted it. Never broker-to-broker:
 *      linking an imported row to another imported row would merge two real
 *      trades into one.
 *   3. not hidden — a row the trader deleted (E12) is not a link target.
 *   4. **`submitted_at <= openedAtMs`.** THIS IS THE HEART OF IT. A plan
 *      written after the entry is not a plan, it is a note; the product's whole
 *      claim is that the trader committed to something BEFORE they were in the
 *      market, and a matcher that linked backwards would hand a score for
 *      planning to somebody who planned nothing. Remove this one line and the
 *      feature says the opposite of what it is for.
 *   5. within {@link MATCH_WINDOW_MS} of the entry.
 *   6. the direction agrees, WHEN THE PLAN CARRIES ONE — it is nullable, and an
 *      absent direction is not a disagreement.
 *   7. the symbol root does not contradict — a NEGATIVE FILTER only, never a
 *      requirement. See {@link rootsConflict}.
 *
 * And one more that applies to the AUTOMATIC path only:
 *
 *   8. **no link decision is already recorded on it** — `link_confirmed_at` is
 *      null. This is what makes an unlink stick; without it the unlink button
 *      undoes itself on the next sync. It is applied by
 *      {@link matchBrokerTrade} and NOT by {@link planCandidates}, because the
 *      confirmation screen must still offer a plan the trader unlinked — the
 *      cron may not overrule their decision, they may. See
 *      {@link decidedAlready}.
 *
 * **Unique means exactly one.** Zero or two or five all mean the same thing
 * here: the trader decides, and the row goes to the confirmation queue. There
 * is no tie-break and there must not be one — §F1 names a wrong automatic link
 * as the central risk of this stage, and it is silent: the plan takes another
 * trade's result, the statistics move, and nobody is told.
 *
 *
 * WHY A CLOCK IS A PARAMETER WHEN THE RULE NEVER ASKS THE TIME
 * -----------------------------------------------------------
 *
 * Conditions 4 and 5 are two instants from the data, so the rule itself has no
 * use for "now". `nowMs` is here for one guard, and the guard is real: an
 * `openedAtMs` in the FUTURE makes condition 4 vacuous — every plan the trader
 * has ever written was submitted "before" it — and then the eight-hour window
 * reaches FORWARD, over plans written after the trade. The ordering rule is
 * only meaningful against an anchor that is a past instant, so the anchor is
 * checked against a clock, and the clock is injected rather than read, because
 * a matcher that calls `Date.now()` cannot be tested at a fixed point.
 */

import { brokerInstrument, planInstrument } from '../symbols';

/** Everything this module needs to know about the broker's side. */
export interface MatchableTrade {
  /** The entry instant, ms since epoch. The anchor both time rules measure from. */
  openedAtMs: number;
  /** Which side opened it. Read from the legs, never from the prices (./fills.ts). */
  direction: 'long' | 'short';
  /** The contract's name, e.g. a standard `<ROOT><month><year>`. Nullable. */
  symbol: string | null;
}

/**
 * A row of `trade_plans` as a possible link target.
 *
 * Every field but `id` is optional or nullable, which is not laziness: `source`
 * and `hidden` arrive with migration 034 and are simply ABSENT from a row read
 * on a database without it, and `direction` and `symbol` are nullable columns
 * on a plan the trader left blank. The predicates below read every one of them
 * for the value that disqualifies, never for the value that admits.
 */
export interface CandidatePlan {
  id: string;
  /** 'open', 'closed' or 'not_entered'. Only 'open' is a candidate. */
  status?: string | null;
  /** 'manual' or 'tradovate'. Absent means manual — every row is, before 034. */
  source?: string | null;
  /** The trader deleted it (E12). Only `true` disqualifies. */
  hidden?: boolean | null;
  /** When the plan was submitted, ISO 8601. The database's `now()`, not a browser's. */
  submitted_at?: string | null;
  /**
   * When a link decision was last recorded about this row.
   *
   * On a MANUAL plan this is only ever set by an unlink, and it is what makes
   * the unlink stick — see condition 8.
   */
  link_confirmed_at?: string | null;
  /** Nullable on a plan. Absent is not a disagreement — see condition 6. */
  direction?: 'long' | 'short' | null;
  /** Free text the trader typed, uppercased by the form. See {@link rootsConflict}. */
  symbol?: string | null;
}

export interface MatchInput {
  trade: MatchableTrade;
  /** The user's plans. Already narrowed by the caller's query; re-checked here. */
  plans: readonly CandidatePlan[];
  /** Now, ms since epoch. Injected — see the header on why it exists at all. */
  nowMs: number;
}

/**
 * What the matcher concluded. Three shapes, and the caller branches on `kind`.
 *
 * `ambiguous` carries the ids rather than just a count because the
 * confirmation screen shows exactly that list, in exactly this order.
 */
export type MatchResult =
  | { kind: 'unique'; planId: string }
  | { kind: 'ambiguous'; candidateIds: string[] }
  | { kind: 'none' };

/**
 * How long after a plan is submitted an entry can still belong to it: 8 hours.
 *
 * THERE IS NO CORRECT VALUE AND THIS ONE IS A JUDGEMENT (§B, confirmed in the
 * Stage 3 decisions). It has to cover "I planned it at 07:00 and took it at the
 * open" and must not cover "a plan from yesterday that was never closed". Eight
 * hours spans a trading day without crossing a night.
 *
 * It is exported, and it is the only number here that can be tuned without
 * changing a shape — which is why the regression suite pins both of its edges
 * rather than leaving the value as a comment.
 */
export const MATCH_WINDOW_MS = 8 * 60 * 60 * 1000;

/**
 * Whether the two symbols are confidently about different instruments.
 *
 * A NEGATIVE FILTER, AND IT IS THE ONLY WAY THE SYMBOL MAY PARTICIPATE (§B).
 * `trade_plans.symbol` is free text — the form uppercases it, suggests a few
 * formats and otherwise stores whatever was typed, so a trader may write `NQ`,
 * `NQ1`, `NQ1!`, `/NQ` or `MNQ` for the contract the broker calls `MNQZ6`.
 * Requiring equality would refuse the great majority of real plans. Refusing
 * only a contradiction keeps a typo out of the auto-link path without turning
 * the field into a gate.
 *
 * THE TWO SIDES ARE READ BY DIFFERENT FUNCTIONS, and that is the REF-107 fix:
 * ../symbols resolves a trader's free text and a broker's contract name
 * separately, then reduces both to one canonical root — micros folded into
 * their minis from an explicit table — so `MNQ` and `NQ` are the same
 * instrument and `ES` against `MNQ` is still the wrong link worth refusing.
 *
 * Either side unreadable means no conflict: the symbol has nothing to say.
 */
export function rootsConflict(
  planSymbol: string | null | undefined,
  brokerSymbol: string | null | undefined
): boolean {
  const broker = brokerInstrument(brokerSymbol);
  const plan = planInstrument(planSymbol);
  if (broker === null || plan === null) return false;
  return plan !== broker;
}

/**
 * The plans this trade could belong to, nearest in time first.
 *
 * Sorted by the gap between the plan's submission and the entry, because that
 * is the order the confirmation screen lists them in and the trader reads it
 * top-down: the plan written twenty minutes before the entry is the one they
 * are most likely to mean. Ties fall back to the id, so the order is total and
 * two runs over the same rows cannot disagree.
 *
 * Every condition in the header is applied HERE rather than in the caller's
 * SQL, and the caller applies the cheap ones as well. That duplication is
 * deliberate, and it is the same belt-and-braces the import uses on `user_id`:
 * the query is there so the batch reads a few rows instead of a thousand, and
 * this is where the rule actually lives.
 */
export function planCandidates(input: MatchInput): CandidatePlan[] {
  const { trade, plans, nowMs } = input;
  const openedAtMs = trade.openedAtMs;

  // The anchor, before anything is measured against it. See the header: a
  // non-finite or future entry instant makes the ordering rule vacuous and
  // turns the window around, so nothing is a candidate rather than everything.
  if (!Number.isFinite(openedAtMs) || openedAtMs > nowMs) return [];

  const kept: { plan: CandidatePlan; distance: number }[] = [];

  for (const plan of plans) {
    if (plan.status !== 'open') continue;
    // Absent means manual: `select('*')` on a database without migration 034
    // returns no key, and every row in such a database is a hand-written plan.
    if ((plan.source ?? 'manual') !== 'manual') continue;
    if (plan.hidden === true) continue;

    const submittedAtMs = Date.parse(String(plan.submitted_at ?? ''));
    if (!Number.isFinite(submittedAtMs)) continue;

    // Condition 4. The line the sabotage check removes.
    if (submittedAtMs > openedAtMs) continue;

    const distance = openedAtMs - submittedAtMs;
    if (distance > MATCH_WINDOW_MS) continue;

    if (plan.direction != null && plan.direction !== trade.direction) continue;
    if (rootsConflict(plan.symbol, trade.symbol)) continue;

    kept.push({ plan, distance });
  }

  kept.sort((a, b) => a.distance - b.distance || a.plan.id.localeCompare(b.plan.id));
  return kept.map((entry) => entry.plan);
}

/**
 * Whether the automatic matcher may decide about this plan at all.
 *
 * CONDITION 8, AND IT APPLIES TO THE AUTOMATIC PATH ONLY — which is the whole
 * reason it lives here rather than in {@link planCandidates}.
 *
 * On a manual plan, `link_confirmed_at` is set by exactly one thing: an
 * unlink. And an unlinked plan is a PERFECT candidate for the trade it was
 * just released from — it kept the broker's `submitted_at`, `direction` and
 * `symbol`, because the link overwrote them and nothing kept the originals —
 * so equal instants pass the ordering rule, the window is zero, and both the
 * direction and the symbol agree by construction. A matcher that did not read
 * this would re-link on the next sync and the unlink button would be a no-op.
 *
 * BUT THE CONFIRMATION SCREEN MUST STILL OFFER IT, and that asymmetry is the
 * point. The trader who unlinked is usually reassigning the trade to a
 * different plan — but they may have unlinked to fix something and want the
 * same plan back, and a candidate list that silently omitted the plan they
 * just unlinked from would be a list that disagrees with what they can see.
 *
 * So: the cron and the import may not overrule a decision the trader made;
 * the trader may. That is the only sense in which "decided" is binding.
 */
function decidedAlready(plan: CandidatePlan): boolean {
  return plan.link_confirmed_at != null && plan.link_confirmed_at !== '';
}

/**
 * The decision: one plan, several, or none.
 *
 * The import writes onto the plan only for `unique`. Both other shapes mean the
 * same thing to it — insert a broker row and let the trader decide — and they
 * are kept apart because the screen says different things: "we found two plans
 * this could be" is a different sentence from "we found none".
 *
 * THIS IS THE AUTOMATIC PATH, so it is narrower than the candidate list the
 * screen shows: a plan that already carries a link decision is dropped here
 * and nowhere else. See {@link decidedAlready}.
 */
export function matchBrokerTrade(input: MatchInput): MatchResult {
  const candidates = planCandidates(input).filter((plan) => !decidedAlready(plan));
  if (candidates.length === 1) return { kind: 'unique', planId: candidates[0].id };
  if (candidates.length > 1) {
    return { kind: 'ambiguous', candidateIds: candidates.map((plan) => plan.id) };
  }
  return { kind: 'none' };
}

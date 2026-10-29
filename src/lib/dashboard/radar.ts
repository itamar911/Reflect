/**
 * The discipline radar's two pure decisions (REF-130 part א, follow-up item 1).
 *
 * WHY THESE LEFT THE COMPONENT. `סבלנות` on the dashboard radar read
 * `exited_early` and nothing else — the self-report column no broker row ever
 * answers — so on an imported journal the axis resolved to its empty-denominator
 * default and stated a number with no measurement under it. That is the same
 * defect lib/journal/patience.ts was written about and that /stats was fixed
 * for; the radar was simply a fourth reader nobody moved.
 *
 * Fixing it in place would have left the fix unreachable. `computeAll` is a
 * closure inside a `'use client'` component, 200 lines long and fed by a
 * Supabase read, so neither the mapping below nor the axis-dropping rule could
 * be driven by a regression script — and the axis-dropping rule is where this
 * change can go wrong silently (see {@link measuredAxes}). A plain module, for
 * lib/journal/patience.ts' own reason: browser-safe, pure, and drivable without
 * a build.
 *
 * NOT MERGED INTO ./trades.ts, which owns the WIRE — the select string, the
 * `NUMERIC`-as-string row and the mapping into `DashTrade`. This owns what the
 * radar then computes from it. The two are one import apart and stay separate
 * because the next reader of a `DashTrade` is not going to want the radar.
 */

import { patienceRate, patienceTally, type PatienceInput } from '@/lib/journal/patience';
import type { DashTrade } from './trades';

/**
 * One row as lib/journal/patience.ts needs it.
 *
 * THE BROKER COLUMNS ARE THE WHOLE POINT. `take_profit` and `stop_loss` were
 * always on `DashTrade`; `broker_take_profit` and `broker_stop_loss` are what
 * ./trades.ts had to start selecting, and they are what makes an imported row
 * answerable at all — the plan's numbers are null on every one of them. The
 * module's own precedence (the plan's target wins, the broker's is the
 * fallback) means a manual row is mapped and read exactly as it was before any
 * of this existed.
 *
 * NO `Number()` HERE: `mapDashTrade` has already run both prices through it,
 * and `intentNumber` inside the module validates every field regardless — the
 * belt the `RawValue` type is declared for.
 */
export function patienceInputOf(t: DashTrade): PatienceInput {
  return {
    direction:    t.direction,
    entryPrice:   t.entry_price,
    exitPrice:    t.exit_price,
    planTarget:   t.take_profit,
    brokerTarget: t.broker_take_profit,
    planStop:     t.stop_loss,
    brokerStop:   t.broker_stop_loss,
    exitedEarly:  t.exited_early,
  };
}

/**
 * The `סבלנות` axis over a set of CLOSED trades, or null for "not measured".
 *
 * TWO CALLERS AND ONE FORMULA, which is the reason this is a function and not
 * two lines in each: the axis and the 30-day discipline TREND are both scored
 * on patience, and a trend computed by a different formula from the axis beside
 * it reports a movement that was only ever the two disagreeing. That is how the
 * defect this fixes survived — the trend's `boolPct(t => t.exited_early)` and
 * the axis' own count were written apart and stayed apart.
 *
 * **NULL IS NOT ZERO AND IS NOT 100.** The four self-reported behaviour axes
 * beside this one resolve an empty denominator to 100 — "nothing against you on
 * record" — and that reading is right for a question the trader has not
 * answered. This one is derived from prices present on every row, so an empty
 * denominator means nothing on any row COULD be measured. Both callers drop the
 * axis instead of scoring it; see {@link measuredAxes}.
 */
export function disciplinePatience(closed: readonly DashTrade[]): number | null {
  return patienceRate(patienceTally(closed.map(patienceInputOf)));
}

/**
 * Which axes were measured, as indices into the label arrays.
 *
 * **THE RADAR IS FOUR INDEX-ALIGNED ARRAYS AND A POLYGON, AND A POLYGON CANNOT
 * DRAW A DASH.** An unmeasured axis therefore leaves the chart entirely, and
 * every array has to lose the same position — labels, English labels,
 * descriptions, tips, scores. That used to be done by hand, per array, against
 * the one axis that could be absent:
 *
 *     stats.hasStrategyConditions ? D_LABELS : [D_LABELS[0], ...D_LABELS.slice(2)]
 *
 * written out four times with the index 1 spelled into each. `סבלנות` is now a
 * second optional axis, at index 3, and that expression cannot say "drop 1 and
 * 3" — a fifth copy with a second hardcoded index is how an axis ends up
 * labelled as its neighbour. So the scores keep their nulls up to this point and
 * the drop happens once, here.
 *
 * RETURNS INDICES RATHER THAN THE FILTERED SCORES, because the caller has five
 * arrays to filter and the mini-cards need the mapping in the OTHER direction —
 * every axis keeps a card whether it was measured or not, and a measured card
 * has to hover the right position in these shortened arrays. One list answers
 * both: `kept[j]` is the original index of displayed axis `j`, and
 * `kept.indexOf(i)` is where original axis `i` now sits.
 */
export function measuredAxes(scores: readonly (number | null)[]): number[] {
  return scores
    .map((score, i) => (score === null ? null : i))
    .filter((i): i is number => i !== null);
}

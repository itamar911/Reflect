/**
 * Deterministic trade scoring.
 *
 *
 * J1 — WHY A TRADE THE TRADER NEVER PLANNED IS NOT SCORED ON PLANNING
 * --------------------------------------------------------------------
 *
 * A broker row the trader has confirmed was not planned (REF-107 Stage 3b,
 * `linkState === 'declined'`) carries no stop, no target and no R:R, because
 * there was no plan to carry them. The planning block scored those three
 * nulls at zero out of sixty and the row came out at ~40/100 — which reads as
 * a bad trade and is in fact a HONEST ANSWER PENALISED. The trader told us
 * they did not plan it; the score then told them off for it.
 *
 * So for those rows the planning block is skipped entirely — not zeroed,
 * skipped, with `max: 0` — and what remains is normalised back to 0-100.
 * `breakdown.scoredOutOf` records the raw points that were actually
 * available, so the number is auditable rather than merely different, and
 * `executionOnly` is what the two consumers branch on to call it
 * "ציון ביצוע" rather than "ציון".
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH:
 *
 *   - a MANUAL row, planned or not. The trader filled in a form; an empty
 *     field there is a choice and the planning block is the right place to
 *     say so.
 *   - a LINKED broker row. The merge put the trader's own plan onto it, so
 *     it has one and is measured against it.
 *   - a QUEUED row (`link_confirmed_at` NULL). It is not scored at all —
 *     the debrief route does not reach scoring for one — and nothing here
 *     changes that.
 *
 * The regression suite asserts every pre-existing fixture's total is
 * byte-identical, because this must be a new branch and not a new formula.
 */
export interface TradeScoreInput {
  stop_loss: number | null;
  take_profit: number | null;
  rr_ratio: number | null;
  required_min_rr: number | null; // strategy min_rr if set, else preset_rules min_rr, else null
  strategy_conditions_checked: { condition: string; checked: boolean }[] | null;
  moved_sl: boolean;
  exited_early: boolean;
  fomo_entry: boolean;
  revenge_trade: boolean;
  exit_price: number | null;
  entry_price: number | null;
  direction: 'long' | 'short' | null;
  /**
   * The trader has confirmed this execution was not planned (J1).
   *
   * `linkState(row) === 'declined'` — a `tradovate` row with `unplanned`
   * true and a `link_confirmed_at`. OPTIONAL and defaulting to false, so
   * every existing caller and fixture means exactly what it meant.
   */
  unplanned?: boolean;
}

export interface TradeScoreResult {
  total: number; // 0-100
  breakdown: {
    planning: { score: number; max: number; details: string[] };
    strategyAdherence: { score: number; max: number; details: string[] };
    discipline: { score: number; max: number; details: string[] };
    /**
     * The raw points this trade could have earned, before normalisation.
     *
     * 100 for every ordinary row, which is why `total` is unchanged for them.
     * Lower when a block was skipped — see `executionOnly` — and the number
     * is here so the figure can be explained rather than just differing.
     */
    scoredOutOf: number;
  };
  correctedFlags: string[]; // contradictions fixed
  /**
   * The planning block was skipped and `total` is an execution score (J1).
   *
   * What the debrief and the journal badge read to say "ציון ביצוע" instead
   * of "ציון". A score out of a different denominator under the same word
   * would be the worst of both.
   */
  executionOnly: boolean;
}

const TOLERANCE_PCT = 0.001; // 0.1%

function withinTolerance(a: number, b: number): boolean {
  const ref = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / ref <= TOLERANCE_PCT;
}

/**
 * Deterministic trade score, computed entirely from verified data.
 * The AI debrief flow may only generate feedback text about this result —
 * it never determines or overrides the score itself.
 */
export function computeTradeScore(input: TradeScoreInput): TradeScoreResult {
  const correctedFlags: string[] = [];
  let { exited_early } = input;
  const { moved_sl, stop_loss, take_profit, rr_ratio, required_min_rr, strategy_conditions_checked, fomo_entry, revenge_trade, exit_price } = input;
  const executionOnly = input.unplanned === true;

  // ── Contradiction correction ────────────────────────────────────────────
  if (exit_price !== null && take_profit !== null && withinTolerance(exit_price, take_profit)) {
    if (exited_early) {
      exited_early = false;
      correctedFlags.push('exited_early auto-corrected: trade closed at full TP');
    }
    // moved_sl is intentionally left as-is here — moving the Stop Loss is
    // still possible (e.g. to lock in profit) even when TP was hit exactly.
  }

  const hasStrategyConditions = !!strategy_conditions_checked && strategy_conditions_checked.length > 0;

  // ── Planning ─────────────────────────────────────────────────────────────
  //
  // SKIPPED ENTIRELY for a trade the trader told us they did not plan (J1).
  // Not scored as zero — `max` is 0 too, so the points simply are not on the
  // table and the normalisation below hands back a score out of what was.
  const slMax = executionOnly ? 0 : hasStrategyConditions ? 10 : 20;
  const tpMax = executionOnly ? 0 : hasStrategyConditions ? 5 : 10;
  const rrMax = executionOnly ? 0 : hasStrategyConditions ? 15 : 30;

  const planningDetails: string[] = [];
  let planningScore = 0;

  if (executionOnly) {
    // ONE LINE FOR THE WHOLE BLOCK, and it says why rather than reading as a
    // zero. "לא הוגדר Stop Loss (0/20)" three times over is the sentence this
    // replaces, and it was being shown to a trader for having answered a
    // question honestly.
    planningDetails.push('לא נמדד תכנון: סימנת שהעסקה לא תוכננה מראש');
  } else {
    if (stop_loss !== null) {
      planningScore += slMax;
      planningDetails.push(`הוגדר Stop Loss (+${slMax})`);
    } else {
      planningDetails.push(`לא הוגדר Stop Loss (0/${slMax})`);
    }

    if (take_profit !== null) {
      planningScore += tpMax;
      planningDetails.push(`הוגדר Take Profit (+${tpMax})`);
    } else {
      planningDetails.push(`לא הוגדר Take Profit (0/${tpMax})`);
    }

    const rrPassed = required_min_rr !== null
      ? rr_ratio !== null && rr_ratio >= required_min_rr
      : rr_ratio !== null;

    if (rrPassed) {
      planningScore += rrMax;
      planningDetails.push(
        required_min_rr !== null
          ? `יחס R:R ${rr_ratio} עומד במינימום הנדרש ${required_min_rr} (+${rrMax})`
          : `יחס R:R ${rr_ratio} תועד (+${rrMax})`
      );
    } else {
      planningDetails.push(
        required_min_rr !== null
          ? `יחס R:R ${rr_ratio ?? '—'} מתחת למינימום הנדרש ${required_min_rr} (0/${rrMax})`
          : `לא תועד יחס R:R (0/${rrMax})`
      );
    }
  }

  // ── Strategy adherence ───────────────────────────────────────────────────
  const strategyDetails: string[] = [];
  let strategyScore = 0;
  const strategyMax = hasStrategyConditions ? 30 : 0;

  if (hasStrategyConditions && strategy_conditions_checked) {
    const total = strategy_conditions_checked.length;
    const checkedCount = strategy_conditions_checked.filter((c) => c.checked).length;
    strategyScore = Math.round((checkedCount / total) * 30);
    strategyDetails.push(`${checkedCount} מתוך ${total} תנאי כניסה סומנו כמתקיימים (+${strategyScore})`);
    for (const c of strategy_conditions_checked) {
      if (!c.checked) strategyDetails.push(`לא סומן: ${c.condition}`);
    }
  }

  // ── Discipline ───────────────────────────────────────────────────────────
  const disciplineDetails: string[] = [];
  let disciplineScore = 0;

  if (!moved_sl) {
    disciplineScore += 12;
    disciplineDetails.push('לא הוזז Stop Loss (+12)');
  } else {
    disciplineDetails.push('הוזז Stop Loss (0/12)');
  }

  if (!exited_early) {
    disciplineScore += 12;
    disciplineDetails.push('לא נסגרה העסקה מוקדם מהמתוכנן (+12)');
  } else {
    disciplineDetails.push('העסקה נסגרה מוקדם מהמתוכנן (0/12)');
  }

  if (!fomo_entry) {
    disciplineScore += 8;
    disciplineDetails.push('לא זוהה FOMO בכניסה (+8)');
  } else {
    disciplineDetails.push('זוהה FOMO בכניסה (0/8)');
  }

  if (!revenge_trade) {
    disciplineScore += 8;
    disciplineDetails.push('לא זוהתה עסקת נקמנות (+8)');
  } else {
    disciplineDetails.push('זוהתה עסקת נקמנות (0/8)');
  }

  const earned = planningScore + strategyScore + disciplineScore;
  const scoredOutOf = slMax + tpMax + rrMax + strategyMax + 40;

  // NORMALISED, so the number is always out of 100 and the two consumers do
  // not each have to divide. For an ordinary row `scoredOutOf` is 100 and
  // this is the identity — which is what keeps every existing total
  // byte-identical. The guard is for a shape that cannot occur today
  // (discipline is always 40) and costs one comparison to make impossible.
  const total = scoredOutOf > 0 ? Math.round((earned / scoredOutOf) * 100) : 0;

  return {
    total,
    breakdown: {
      planning: { score: planningScore, max: slMax + tpMax + rrMax, details: planningDetails },
      strategyAdherence: { score: strategyScore, max: strategyMax, details: strategyDetails },
      discipline: { score: disciplineScore, max: 40, details: disciplineDetails },
      scoredOutOf,
    },
    correctedFlags,
    executionOnly,
  };
}

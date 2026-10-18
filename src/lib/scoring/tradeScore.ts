/**
 * Deterministic trade scoring.
 *
 *
 * J1 — A TRADE WITH NO PLAN SCORES ZERO ON PLANNING, AND THAT IS THE POINT
 * -------------------------------------------------------------------------
 *
 * A broker row the trader has confirmed was not planned (REF-107 Stage 3b,
 * `linkState === 'declined'`) carries no stop, no target and no R:R. It is
 * scored on the full 100-point scale like any other trade, so the planning
 * block is 0/60 and the total lands around 40.
 *
 * THIS WAS BRIEFLY THE OTHER WAY and was reversed on 18.10. The first version
 * skipped the planning block, normalised over what remained, and called the
 * result "ציון ביצוע" — on the reasoning that a trader who answers honestly
 * should not be penalised for the answer. The decision went the other way,
 * and the reasoning is the product's:
 *
 *   **Entering without a plan IS the discipline failure this product
 *   measures.** A score that normalises it away says a trade taken on
 *   impulse and executed tidily is a 100, which is the opposite of what
 *   Reflect exists to tell a trader. Honesty about not planning is worth
 *   something — it is what makes the row scoreable at all — but it does not
 *   make the missing plan cost nothing.
 *
 * What survives from that version is the one part that was right: the trader
 * is TOLD WHY. `unplanned` replaces the three itemised zeros with a single
 * line naming the reason, so the breakdown reads "תכנון 0/60 — לא הוגשה
 * תוכנית" instead of three separate complaints about fields that were never
 * going to be filled. It changes no number.
 *
 * A QUEUED row (`link_confirmed_at` NULL) is still not scored at all — the
 * debrief route never reaches scoring for one — and nothing here changes
 * that.
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
   *
   * IT CHANGES NO NUMBER. The planning block still scores what it scores,
   * which for a row carrying no stop, target or R:R is zero. This only
   * decides whether the trader is told the reason in one line or shown three
   * itemised zeros for fields that were never going to be filled.
   */
  unplanned?: boolean;
}

export interface TradeScoreResult {
  total: number; // 0-100
  breakdown: {
    planning: { score: number; max: number; details: string[] };
    strategyAdherence: { score: number; max: number; details: string[] };
    discipline: { score: number; max: number; details: string[] };
  };
  correctedFlags: string[]; // contradictions fixed
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
  const unplanned = input.unplanned === true;

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
  // SCORED FOR EVERY ROW, including one the trader says was not planned. See
  // the header: entering without a plan is the failure this block measures,
  // and a scale that excused it would be measuring nothing.
  const slMax = hasStrategyConditions ? 10 : 20;
  const tpMax = hasStrategyConditions ? 5 : 10;
  const rrMax = hasStrategyConditions ? 15 : 30;

  const planningDetails: string[] = [];
  let planningScore = 0;

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


  // WHY, IN ONE LINE, INSTEAD OF THREE ITEMISED ZEROS (J1).
  //
  // The score above is unchanged — a row with no stop, target or R:R scores
  // zero whether or not it says so. What changes is what the trader reads:
  // "לא הוגדר Stop Loss (0/20)" three times over is three complaints about
  // fields that were never going to be filled, where one sentence naming the
  // reason is the same fact said once.
  //
  // Interpolated rather than hardcoded as "0/60": the maxima move when a
  // strategy carries entry conditions, and a label that could disagree with
  // the number beside it is worse than no label.
  if (unplanned) {
    planningDetails.length = 0;
    planningDetails.push(`תכנון ${planningScore}/${slMax + tpMax + rrMax} — לא הוגשה תוכנית`);
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
  //
  // THE FOUR "NOT VIOLATED" DEFAULTS ARE PROVISIONAL, and on an imported row
  // they are the reason an unplanned trade still scores around 40 rather
  // than near zero.
  //
  // `moved_sl`, `exited_early`, `fomo_entry` and `revenge_trade` are all
  // SELF-REPORTED, set in CloseTrade.tsx by a trader answering four
  // questions. A broker row has none of them, so each reads `=== true` as
  // false and the block awards its full 40 — not because the trade was
  // disciplined, but because nothing contradicted it. A trade entered on
  // impulse and managed badly can therefore collect the whole discipline
  // block for having no evidence against it.
  //
  // REF-113 is what changes that: it reads the orders behind a trade's
  // fills, so `moved_sl` in particular stops being a question the trader
  // answers and becomes something the broker can be asked. When it lands,
  // revisit whether an absent self-report should still default to
  // "not violated" or to "unknown" — an unknown that awards no points is a
  // different and arguably more honest block, and it is a product decision
  // rather than this function's to make unilaterally.
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

  const total = planningScore + strategyScore + disciplineScore;

  return {
    total,
    breakdown: {
      planning: { score: planningScore, max: slMax + tpMax + rrMax, details: planningDetails },
      strategyAdherence: { score: strategyScore, max: strategyMax, details: strategyDetails },
      discipline: { score: disciplineScore, max: 40, details: disciplineDetails },
    },
    correctedFlags,
  };
}

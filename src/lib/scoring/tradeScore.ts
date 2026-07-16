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

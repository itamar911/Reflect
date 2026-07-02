import type { TradePlanInput, PresetRules, CustomRule, ConditionType, ActionType, RulesetValidationResult } from '@/lib/types';
import { calcRR } from '@/lib/utils';

export function validateTradePlan(
  input: TradePlanInput,
  presetRules: PresetRules,
  todayTradeCount: number,
  recentLossCount: number,
  todayLossAmount: number = 0,
  personalStrategyNames: string[] = []
): RulesetValidationResult {
  const blocked: string[] = [];
  const warnings: string[] = [];

  const entry = parseFloat(input.entry_price);
  const sl = parseFloat(input.stop_loss);
  const tp = parseFloat(input.take_profit);

  // Emotional state check
  if (input.emotional_state < presetRules.min_emotional_state) {
    if (input.emotional_state <= presetRules.min_emotional_state - 2) {
      blocked.push(
        `מצב רגשי ${input.emotional_state}/5 — מתחת למינימום הנדרש (${presetRules.min_emotional_state}/5). לא מומלץ לסחור כרגע.`
      );
    } else {
      warnings.push(
        `מצב רגשי ${input.emotional_state}/5 נמוך מהמינימום (${presetRules.min_emotional_state}/5) — שקול לחכות`
      );
    }
  }

  // R:R check
  if (!isNaN(entry) && !isNaN(sl) && !isNaN(tp) && entry > 0 && sl > 0 && tp > 0) {
    const rr = calcRR(entry, sl, tp);
    if (rr < presetRules.min_rr_ratio * 0.5) {
      blocked.push(
        `יחס R:R ${rr.toFixed(2)}:1 נמוך מדי — המינימום שלך הוא ${presetRules.min_rr_ratio}:1`
      );
    } else if (rr < presetRules.min_rr_ratio) {
      warnings.push(
        `יחס R:R ${rr.toFixed(2)}:1 מתחת למינימום המומלץ שלך (${presetRules.min_rr_ratio}:1)`
      );
    }
  }

  // Daily trade limit
  if (todayTradeCount >= presetRules.max_daily_trades) {
    blocked.push(
      `הגעת למקסימום ${presetRules.max_daily_trades} עסקאות ליום — Cooldown נדרש`
    );
  } else if (todayTradeCount >= presetRules.max_daily_trades - 1) {
    warnings.push(
      `זוהי העסקה האחרונה שמותרת לך היום (${todayTradeCount + 1}/${presetRules.max_daily_trades})`
    );
  }

  // Cooldown after consecutive losses
  if (recentLossCount >= presetRules.cooldown_after_losses) {
    blocked.push(
      `${recentLossCount} הפסדים רצופים — נדרש Cooldown לפני עסקה נוספת`
    );
  } else if (recentLossCount >= presetRules.cooldown_after_losses - 1 && recentLossCount > 0) {
    warnings.push(
      `${recentLossCount} הפסדים רצופים — עוד הפסד אחד ויופעל Cooldown`
    );
  }

  // Max daily loss
  if (presetRules.max_daily_loss !== null && presetRules.max_daily_loss > 0) {
    if (todayLossAmount >= presetRules.max_daily_loss) {
      blocked.push(
        `הפסד יומי של $${todayLossAmount.toFixed(0)} עבר את המגבלה שלך ($${presetRules.max_daily_loss})`
      );
    } else if (todayLossAmount >= presetRules.max_daily_loss * 0.8) {
      warnings.push(
        `הפסד יומי של $${todayLossAmount.toFixed(0)} — קרוב למגבלה ($${presetRules.max_daily_loss})`
      );
    }
  }

  // Strategy whitelist — personal strategies (from personal_strategies) are always approved;
  // this list only whitelists the fixed preset strategy names.
  if (
    input.strategy &&
    presetRules.allowed_strategies.length > 0 &&
    !personalStrategyNames.includes(input.strategy) &&
    !presetRules.allowed_strategies.includes(input.strategy as import('@/lib/types').TradeStrategy)
  ) {
    warnings.push(
      `אסטרטגיה "${input.strategy}" אינה ברשימת האסטרטגיות המאושרות שלך`
    );
  }

  const status =
    blocked.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'valid';

  return { status, blockedReasons: blocked, warningReasons: warnings };
}

export const DEFAULT_PRESET_RULES: Omit<PresetRules, 'id' | 'user_id' | 'created_at' | 'updated_at'> = {
  min_rr_ratio: 2,
  max_daily_trades: 5,
  cooldown_after_losses: 3,
  cooldown_minutes: null,
  max_daily_loss: null,
  min_emotional_state: 2,
  allowed_strategies: ['Breakout', 'Trend Follow', 'Reversal', 'Range', 'Custom'],
};

export const COOLDOWN_MINUTE_OPTIONS: { label: string; minutes: number }[] = [
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '2h', minutes: 120 },
  { label: '4h', minutes: 240 },
  { label: '6h', minutes: 360 },
  { label: '12h', minutes: 720 },
  { label: '1d', minutes: 1440 },
];

export function formatCooldownMinutes(minutes: number): string {
  return COOLDOWN_MINUTE_OPTIONS.find((o) => o.minutes === minutes)?.label ?? `${minutes} דקות`;
}

export interface ActiveRuleContext {
  todayTradeCount: number;
  recentLossCount: number;
  todayLossAmount: number;
  /** Minutes elapsed since the most recent closed trade in the loss streak, or null if not applicable. */
  minutesSinceLastClose: number | null;
}

/**
 * Lightweight, input-independent check used to gate opening the trade form —
 * unlike validateTradePlan, this doesn't require a filled-in trade (no R:R,
 * emotional state, or strategy fields), only the rules + recent trade history.
 */
export function checkActiveViolation(
  presetRules: PresetRules,
  ctx: ActiveRuleContext
): string | null {
  if (ctx.todayTradeCount >= presetRules.max_daily_trades) {
    return `הגעת למקסימום ${presetRules.max_daily_trades} עסקאות ליום`;
  }

  if (ctx.recentLossCount >= presetRules.cooldown_after_losses) {
    if (presetRules.cooldown_minutes && ctx.minutesSinceLastClose !== null) {
      const remaining = presetRules.cooldown_minutes - ctx.minutesSinceLastClose;
      if (remaining > 0) {
        return `${ctx.recentLossCount} הפסדים רצופים — נדרש Cooldown של ${formatCooldownMinutes(presetRules.cooldown_minutes)} (נותרו ${Math.ceil(remaining)} דקות)`;
      }
    } else {
      return `${ctx.recentLossCount} הפסדים רצופים — נדרש Cooldown לפני עסקה נוספת`;
    }
  }

  if (presetRules.max_daily_loss !== null && presetRules.max_daily_loss > 0 && ctx.todayLossAmount >= presetRules.max_daily_loss) {
    return `הפסד יומי עבר $${presetRules.max_daily_loss}`;
  }

  return null;
}

// ── Structured custom rules ──────────────────────────────────────────────────

export const CONDITION_LABELS: Record<ConditionType, string> = {
  daily_loss_dollar: 'הפסד יומי עבר סכום קבוע ($)',
  daily_loss_percent: 'הפסד יומי עבר אחוז מהתיק (%)',
  daily_trades_count: 'מספר עסקאות היום עבר',
  loss_streak: 'רצף הפסדים רצוף הגיע ל',
  hour_after: 'השעה עברה (24h)',
  fomo_last_trade: 'הרגשתי FOMO בעסקה האחרונה',
  exited_early_last_trade: 'יצאתי מוקדם מהעסקה האחרונה',
  moved_sl_last_trade: 'הזזתי Stop Loss בעסקה האחרונה',
};

export const ACTION_LABELS: Record<ActionType, string> = {
  block_day: 'חסום כניסה לעסקה חדשה ליום שלם',
  block_timer: 'חסום עם טיימר',
  warn: 'הצג אזהרה בלבד',
};

const CONDITIONS_WITHOUT_THRESHOLD: ConditionType[] = [
  'fomo_last_trade',
  'exited_early_last_trade',
  'moved_sl_last_trade',
];

export function conditionNeedsThreshold(conditionType: ConditionType): boolean {
  return !CONDITIONS_WITHOUT_THRESHOLD.includes(conditionType);
}

/** Human-readable Hebrew description of a rule's condition, e.g. "הפסד יומי עבר $200". */
export function describeCustomRule(rule: Pick<CustomRule, 'condition_type' | 'threshold_value'>): string {
  const t = rule.threshold_value ?? 0;
  switch (rule.condition_type) {
    case 'daily_loss_dollar': return `הפסד יומי עבר $${t}`;
    case 'daily_loss_percent': return `הפסד יומי עבר ${t}% מהתיק`;
    case 'daily_trades_count': return `מספר עסקאות היום עבר ${t}`;
    case 'loss_streak': return `רצף הפסדים רצוף הגיע ל-${t}`;
    case 'hour_after': return `השעה עברה ${t} (פורמט 24h)`;
    case 'fomo_last_trade': return 'הרגשתי FOMO בעסקה האחרונה';
    case 'exited_early_last_trade': return 'יצאתי מוקדם מהעסקה האחרונה';
    case 'moved_sl_last_trade': return 'הזזתי Stop Loss בעסקה האחרונה';
    default: return '';
  }
}

export interface CustomRuleCheckContext {
  /** Dollar amount lost today (positive number), from realized (closed) trades. */
  todayLossAmount: number;
  /** Today's loss as % of portfolio, or null if portfolio size is unknown (condition is skipped). */
  todayLossPercent: number | null;
  /** Number of trades taken (submitted) today. */
  todayTradeCount: number;
  /** Consecutive losses counting back from the most recently closed trade. */
  lossStreak: number;
  /** Current hour, 0-23, local time. */
  currentHour: number;
  lastTradeFomo: boolean;
  lastTradeExitedEarly: boolean;
  lastTradeMovedSl: boolean;
}

export function evaluateCustomRuleCondition(rule: CustomRule, ctx: CustomRuleCheckContext): boolean {
  switch (rule.condition_type) {
    case 'daily_loss_dollar':
      return rule.threshold_value !== null && ctx.todayLossAmount > rule.threshold_value;
    case 'daily_loss_percent':
      return rule.threshold_value !== null && ctx.todayLossPercent !== null && ctx.todayLossPercent > rule.threshold_value;
    case 'daily_trades_count':
      return rule.threshold_value !== null && ctx.todayTradeCount > rule.threshold_value;
    case 'loss_streak':
      return rule.threshold_value !== null && ctx.lossStreak >= rule.threshold_value;
    case 'hour_after':
      return rule.threshold_value !== null && ctx.currentHour >= rule.threshold_value;
    case 'fomo_last_trade':
      return ctx.lastTradeFomo;
    case 'exited_early_last_trade':
      return ctx.lastTradeExitedEarly;
    case 'moved_sl_last_trade':
      return ctx.lastTradeMovedSl;
    default:
      return false;
  }
}

export interface CustomRuleViolation {
  rule: CustomRule;
  description: string;
}

/** Returns the first active custom rule whose condition currently holds, or null. */
export function checkCustomRules(customRules: CustomRule[], ctx: CustomRuleCheckContext): CustomRuleViolation | null {
  for (const rule of customRules) {
    if (!rule.is_active) continue;
    if (evaluateCustomRuleCondition(rule, ctx)) {
      return { rule, description: describeCustomRule(rule) };
    }
  }
  return null;
}

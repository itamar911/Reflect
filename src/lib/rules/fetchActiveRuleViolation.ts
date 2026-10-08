import { createClient } from '@/lib/supabase/client';
import { loadTradeRuleContext } from './tradeRuleContext';
import {
  checkActiveViolation,
  checkCustomRules,
  DEFAULT_PRESET_RULES,
} from '@/lib/validators/RulesetValidator';
import type { ActionType, CustomRule, PresetRules, PresetRuleKey } from '@/lib/types';

export interface RuleViolationResult {
  ruleName: string;
  description: string;
  actionType: ActionType;
  cooldownMinutes: number | null;
  /** Present only when this violation came from a custom_rules row — used for rule-violation logging (id, condition_type). */
  customRule?: CustomRule;
  /** Present only when this violation came from the preset (non-custom) branch — used for rule-violation logging. */
  presetRuleKey?: PresetRuleKey;
}

/**
 * Checks whether the user's active rules — personal (custom_rules, checked
 * first) AND preset — are currently violated. Used to gate opening the trade
 * form before any trade input exists.
 *
 * When realTimeBlocking is false (non-pro plans), a matching rule can never
 * block trade submission — it's downgraded to a warning instead.
 */
export async function fetchActiveRuleViolation(userId: string, realTimeBlocking: boolean = true): Promise<RuleViolationResult | null> {
  const supabase = createClient();

  // Trade history comes from ./tradeRuleContext.ts, which the trade form
  // calls too. It used to be worked out here and, differently, there — see
  // that module's header for what the two definitions disagreed about.
  const [rulesRes, customRulesRes, history] = await Promise.all([
    supabase.from('preset_rules').select('*').eq('user_id', userId).single(),
    supabase.from('custom_rules').select('*').eq('user_id', userId).eq('is_active', true).order('created_at'),
    loadTradeRuleContext(userId, supabase),
  ]);

  const presetRules: PresetRules =
    (rulesRes.data as PresetRules) ?? { ...DEFAULT_PRESET_RULES, id: '', user_id: userId, created_at: '', updated_at: '' };
  const customRules: CustomRule[] = (customRulesRes.data as CustomRule[]) ?? [];

  // NOT IN THIS PASS: daily_loss_percent is offered in the rules UI and can
  // never fire. profiles has no portfolio-size field, so this stays null and
  // evaluateCustomRuleCondition() skips the condition rather than erroring —
  // one of the eight creatable conditions is inert.
  const todayLossPercent: number | null = null;

  const customViolation = checkCustomRules(customRules, {
    todayLossAmount: history.todayLossAmount,
    todayLossPercent,
    todayTradeCount: history.todayTradeCount,
    lossStreak: history.lossStreak,
    currentHour: new Date().getHours(),
    lastTradeFomo: history.lastTradeFomo,
    lastTradeExitedEarly: history.lastTradeExitedEarly,
    lastTradeMovedSl: history.lastTradeMovedSl,
  });

  if (customViolation) {
    // NOT IN THIS PASS: the 'warn' fallback is unreachable. Every plan tier
    // resolves to realTimeBlocking: true (lib/plans/config.ts), so the
    // downgrade never happens here or in applyRealTimeBlockingPolicy().
    const actionType = realTimeBlocking ? customViolation.rule.action_type : 'warn';
    return {
      ruleName: customViolation.rule.name,
      description: customViolation.description,
      actionType,
      // NOT IN THIS PASS: for a custom rule this number is only printed, never
      // enforced — nothing compares it against elapsed time, so a custom
      // block_timer behaves exactly like block_day with a duration on the label.
      // Only preset_rules.cooldown_after_losses actually uses minutesSinceLastClose.
      cooldownMinutes: actionType === 'warn' ? null : customViolation.rule.cooldown_minutes,
      customRule: customViolation.rule,
    };
  }

  const presetViolation = checkActiveViolation(presetRules, {
    todayTradeCount: history.todayTradeCount,
    recentLossCount: history.lossStreak,
    todayLossAmount: history.todayLossAmount,
    minutesSinceLastClose: history.minutesSinceLastClose,
  });

  if (presetViolation) {
    return {
      ruleName: presetViolation.ruleName,
      description: presetViolation.description,
      actionType: realTimeBlocking ? 'block_day' : 'warn',
      cooldownMinutes: null,
      presetRuleKey: presetViolation.ruleKey,
    };
  }

  return null;
}

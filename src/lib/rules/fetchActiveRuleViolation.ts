import { createClient } from '@/lib/supabase/client';
import {
  checkActiveViolation,
  checkCustomRules,
  DEFAULT_PRESET_RULES,
} from '@/lib/validators/RulesetValidator';
import type { ActionType, CustomRule, PresetRules } from '@/lib/types';

export interface RuleViolationResult {
  ruleName: string;
  description: string;
  actionType: ActionType;
  cooldownMinutes: number | null;
  /** Present only when this violation came from a custom_rules row — used for rule-violation logging (id, condition_type). */
  customRule?: CustomRule;
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
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

  const [rulesRes, customRulesRes, todayCountRes, todayClosedRes, recentRes] = await Promise.all([
    supabase.from('preset_rules').select('*').eq('user_id', userId).single(),
    supabase.from('custom_rules').select('*').eq('user_id', userId).eq('is_active', true).order('created_at'),
    // Trades TAKEN today (for the daily trade-count condition) — by submitted_at.
    supabase.from('trade_plans').select('id').eq('user_id', userId).gte('submitted_at', todayStart),
    // Trades CLOSED today (for the daily realized-loss condition) — by closed_at,
    // using the stored dollar pnl (actual_pnl override, falling back to pnl_amount).
    supabase
      .from('trade_plans')
      .select('pnl_amount, actual_pnl')
      .eq('user_id', userId)
      .eq('status', 'closed')
      .gte('closed_at', todayStart),
    // Most recent closed trades — used for the loss streak AND the
    // fomo/exited-early/moved-sl "last trade" conditions (the first row).
    supabase
      .from('trade_plans')
      .select('pnl_amount, actual_pnl, closed_at, fomo_entry, exited_early, moved_sl')
      .eq('user_id', userId)
      .eq('status', 'closed')
      .order('closed_at', { ascending: false })
      .limit(10),
  ]);

  const presetRules: PresetRules =
    (rulesRes.data as PresetRules) ?? { ...DEFAULT_PRESET_RULES, id: '', user_id: userId, created_at: '', updated_at: '' };
  const customRules: CustomRule[] = (customRulesRes.data as CustomRule[]) ?? [];

  const todayTradeCount = todayCountRes.data?.length ?? 0;

  let todayLossAmount = 0;
  if (todayClosedRes.data) {
    for (const t of todayClosedRes.data) {
      const pnl = t.actual_pnl ?? t.pnl_amount;
      if (typeof pnl === 'number' && pnl < 0) {
        todayLossAmount += Math.abs(pnl);
      }
    }
  }

  const recent = recentRes.data ?? [];
  const lastTrade = recent[0];

  let lossStreak = 0;
  let minutesSinceLastClose: number | null = null;
  for (const t of recent) {
    const pnl = t.actual_pnl ?? t.pnl_amount;
    if (typeof pnl === 'number' && pnl < 0) {
      if (minutesSinceLastClose === null && t.closed_at) {
        minutesSinceLastClose = (Date.now() - new Date(t.closed_at).getTime()) / 60000;
      }
      lossStreak++;
    } else {
      break;
    }
  }

  // No portfolio-size field exists on profiles yet, so daily_loss_percent
  // rules can't be evaluated — they're skipped (never match) rather than erroring.
  const todayLossPercent: number | null = null;

  const customViolation = checkCustomRules(customRules, {
    todayLossAmount,
    todayLossPercent,
    todayTradeCount,
    lossStreak,
    currentHour: new Date().getHours(),
    lastTradeFomo: !!lastTrade?.fomo_entry,
    lastTradeExitedEarly: !!lastTrade?.exited_early,
    lastTradeMovedSl: !!lastTrade?.moved_sl,
  });

  if (customViolation) {
    const actionType = realTimeBlocking ? customViolation.rule.action_type : 'warn';
    return {
      ruleName: customViolation.rule.name,
      description: customViolation.description,
      actionType,
      cooldownMinutes: actionType === 'warn' ? null : customViolation.rule.cooldown_minutes,
      customRule: customViolation.rule,
    };
  }

  const presetMessage = checkActiveViolation(presetRules, {
    todayTradeCount,
    recentLossCount: lossStreak,
    todayLossAmount,
    minutesSinceLastClose,
  });

  if (presetMessage) {
    return {
      ruleName: 'חוק מובנה',
      description: presetMessage,
      actionType: realTimeBlocking ? 'block_day' : 'warn',
      cooldownMinutes: null,
    };
  }

  return null;
}

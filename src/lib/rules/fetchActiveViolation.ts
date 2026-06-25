import { createClient } from '@/lib/supabase/client';
import {
  checkActiveViolation,
  checkCustomRuleViolations,
  DEFAULT_PRESET_RULES,
} from '@/lib/validators/RulesetValidator';
import type { CustomRule, PresetRules } from '@/lib/types';

/**
 * Checks whether the user's active rules — preset AND personal (custom_rules)
 * — are currently violated (daily trade limit, loss-streak cooldown, daily
 * loss limit). Used to gate opening the trade form before any trade input
 * exists.
 */
export async function fetchActiveRuleViolation(userId: string): Promise<string | null> {
  const supabase = createClient();
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

  const [rulesRes, customRulesRes, todayCountRes, todayClosedRes, recentRes] = await Promise.all([
    supabase.from('preset_rules').select('*').eq('user_id', userId).single(),
    supabase.from('custom_rules').select('*').eq('user_id', userId).eq('is_active', true),
    // Trades TAKEN today (for the daily trade-count limit) — by submitted_at.
    supabase.from('trade_plans').select('id').eq('user_id', userId).gte('submitted_at', todayStart),
    // Trades CLOSED today (for the daily realized-loss limit) — by closed_at,
    // using the stored dollar pnl (actual_pnl override, falling back to pnl_amount).
    supabase
      .from('trade_plans')
      .select('pnl_amount, actual_pnl')
      .eq('user_id', userId)
      .eq('status', 'closed')
      .gte('closed_at', todayStart),
    supabase
      .from('trade_plans')
      .select('status, exit_price, stop_loss, closed_at')
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

  let recentLossCount = 0;
  let minutesSinceLastClose: number | null = null;
  if (recentRes.data) {
    for (const t of recentRes.data) {
      if (t.exit_price && t.stop_loss && t.exit_price <= t.stop_loss) {
        if (minutesSinceLastClose === null && t.closed_at) {
          minutesSinceLastClose = (Date.now() - new Date(t.closed_at).getTime()) / 60000;
        }
        recentLossCount++;
      } else {
        break;
      }
    }
  }

  // Personal (custom_rules) checks take priority — they're more specific to the user.
  const customViolation = checkCustomRuleViolations(customRules, todayLossAmount);
  if (customViolation) return customViolation;

  return checkActiveViolation(presetRules, {
    todayTradeCount,
    recentLossCount,
    todayLossAmount,
    minutesSinceLastClose,
  });
}

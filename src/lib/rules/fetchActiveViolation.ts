import { createClient } from '@/lib/supabase/client';
import { checkActiveViolation, DEFAULT_PRESET_RULES } from '@/lib/validators/RulesetValidator';
import type { PresetRules } from '@/lib/types';

/**
 * Checks whether the user's active preset rules are currently violated
 * (daily trade limit, loss-streak cooldown, daily loss limit) — used to gate
 * opening the trade form before any trade input exists.
 */
export async function fetchActiveRuleViolation(userId: string): Promise<string | null> {
  const supabase = createClient();
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

  const [rulesRes, todayRes, recentRes] = await Promise.all([
    supabase.from('preset_rules').select('*').eq('user_id', userId).single(),
    supabase
      .from('trade_plans')
      .select('id, status, entry_price, exit_price')
      .eq('user_id', userId)
      .gte('submitted_at', todayStart),
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

  let todayTradeCount = 0;
  let todayLossAmount = 0;
  if (todayRes.data) {
    todayTradeCount = todayRes.data.length;
    for (const t of todayRes.data) {
      if (t.status === 'closed' && t.exit_price && t.entry_price && t.exit_price < t.entry_price) {
        todayLossAmount += Math.abs(t.entry_price - t.exit_price);
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

  return checkActiveViolation(presetRules, {
    todayTradeCount,
    recentLossCount,
    todayLossAmount,
    minutesSinceLastClose,
  });
}

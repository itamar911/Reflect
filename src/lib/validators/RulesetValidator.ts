import type { TradePlanInput, PresetRules, RulesetValidationResult } from '@/lib/types';
import { calcRR } from '@/lib/utils';

export function validateTradePlan(
  input: TradePlanInput,
  presetRules: PresetRules,
  todayTradeCount: number,
  recentLossCount: number,
  todayLossAmount: number = 0
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
        `׳׳¦׳‘ ׳¨׳’׳©׳™ ${input.emotional_state}/5 ג€” ׳׳×׳—׳× ׳׳׳™׳ ׳™׳׳•׳ ׳”׳ ׳“׳¨׳© (${presetRules.min_emotional_state}/5). ׳׳ ׳׳•׳׳׳¥ ׳׳¡׳—׳•׳¨ ׳›׳¨׳’׳¢.`
      );
    } else {
      warnings.push(
        `׳׳¦׳‘ ׳¨׳’׳©׳™ ${input.emotional_state}/5 ׳ ׳׳•׳ ׳׳”׳׳™׳ ׳™׳׳•׳ (${presetRules.min_emotional_state}/5) ג€” ׳©׳§׳•׳ ׳׳—׳›׳•׳×`
      );
    }
  }

  // R:R check
  if (!isNaN(entry) && !isNaN(sl) && !isNaN(tp) && entry > 0 && sl > 0 && tp > 0) {
    const rr = calcRR(entry, sl, tp);
    if (rr < presetRules.min_rr_ratio * 0.5) {
      blocked.push(
        `׳™׳—׳¡ R:R ${rr.toFixed(2)}:1 ׳ ׳׳•׳ ׳׳“׳™ ג€” ׳”׳׳™׳ ׳™׳׳•׳ ׳©׳׳ ׳”׳•׳ ${presetRules.min_rr_ratio}:1`
      );
    } else if (rr < presetRules.min_rr_ratio) {
      warnings.push(
        `׳™׳—׳¡ R:R ${rr.toFixed(2)}:1 ׳׳×׳—׳× ׳׳׳™׳ ׳™׳׳•׳ ׳”׳׳•׳׳׳¥ ׳©׳׳ (${presetRules.min_rr_ratio}:1)`
      );
    }
  }

  // Daily trade limit
  if (todayTradeCount >= presetRules.max_daily_trades) {
    blocked.push(
      `׳”׳’׳¢׳× ׳׳׳§׳¡׳™׳׳•׳ ${presetRules.max_daily_trades} ׳¢׳¡׳§׳׳•׳× ׳׳™׳•׳ ג€” Cooldown ׳ ׳“׳¨׳©`
    );
  } else if (todayTradeCount >= presetRules.max_daily_trades - 1) {
    warnings.push(
      `׳–׳•׳”׳™ ׳”׳¢׳¡׳§׳” ׳”׳׳—׳¨׳•׳ ׳” ׳©׳׳•׳×׳¨׳× ׳׳ ׳”׳™׳•׳ (${todayTradeCount + 1}/${presetRules.max_daily_trades})`
    );
  }

  // Cooldown after consecutive losses
  if (recentLossCount >= presetRules.cooldown_after_losses) {
    blocked.push(
      `${recentLossCount} ׳”׳₪׳¡׳“׳™׳ ׳¨׳¦׳•׳₪׳™׳ ג€” ׳ ׳“׳¨׳© Cooldown ׳׳₪׳ ׳™ ׳¢׳¡׳§׳” ׳ ׳•׳¡׳₪׳×`
    );
  } else if (recentLossCount >= presetRules.cooldown_after_losses - 1 && recentLossCount > 0) {
    warnings.push(
      `${recentLossCount} ׳”׳₪׳¡׳“׳™׳ ׳¨׳¦׳•׳₪׳™׳ ג€” ׳¢׳•׳“ ׳”׳₪׳¡׳“ ׳׳—׳“ ׳•׳™׳•׳₪׳¢׳ Cooldown`
    );
  }

  // Max daily loss
  if (presetRules.max_daily_loss !== null && presetRules.max_daily_loss > 0) {
    if (todayLossAmount >= presetRules.max_daily_loss) {
      blocked.push(
        `׳”׳₪׳¡׳“ ׳™׳•׳׳™ ׳©׳ $${todayLossAmount.toFixed(0)} ׳¢׳‘׳¨ ׳׳× ׳”׳׳’׳‘׳׳” ׳©׳׳ ($${presetRules.max_daily_loss})`
      );
    } else if (todayLossAmount >= presetRules.max_daily_loss * 0.8) {
      warnings.push(
        `׳”׳₪׳¡׳“ ׳™׳•׳׳™ ׳©׳ $${todayLossAmount.toFixed(0)} ג€” ׳§׳¨׳•׳‘ ׳׳׳’׳‘׳׳” ($${presetRules.max_daily_loss})`
      );
    }
  }

  // Strategy whitelist
  if (
    input.strategy &&
    presetRules.allowed_strategies.length > 0 &&
    !presetRules.allowed_strategies.includes(input.strategy as import('@/lib/types').TradeStrategy)
  ) {
    warnings.push(
      `׳׳¡׳˜׳¨׳˜׳’׳™׳” "${input.strategy}" ׳׳™׳ ׳” ׳‘׳¨׳©׳™׳׳× ׳”׳׳¡׳˜׳¨׳˜׳’׳™׳•׳× ׳”׳׳׳•׳©׳¨׳•׳× ׳©׳׳`
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
  max_daily_loss: null,
  min_emotional_state: 2,
  allowed_strategies: ['Breakout', 'Trend Follow', 'Reversal', 'Range', 'Custom'],
};

import type { SupabaseClient } from '@supabase/supabase-js';
import { getPlanLimits, type PlanTier, type PlanLimits } from './config';

export interface UserPlan {
  tier: PlanTier;
  limits: PlanLimits;
}

export async function getUserPlan(supabase: SupabaseClient, userId: string): Promise<UserPlan> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single();

    if (error || !data) {
      return { tier: 'free', limits: getPlanLimits('free') };
    }

    const tier = (data.subscription_tier ?? 'free') as PlanTier;
    return { tier, limits: getPlanLimits(tier) };
  } catch {
    return { tier: 'free', limits: getPlanLimits('free') };
  }
}

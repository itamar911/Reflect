// Must match the DB CHECK constraint on profiles.subscription_tier
// (supabase/migrations/002_v3_features.sql)
export type PlanTier = 'free' | 'basic' | 'pro';

export interface PlanLimits {
  maxTradesPerWeek: number | null;
  maxCustomRules: number | null;
  maxBlockingConditions: number | null;
  maxStrategies: number | null;
  realTimeBlocking: boolean;
  aiCoach: boolean;
  weeklySummary: boolean;
  excelExport: boolean;
}

const BASIC_LIMITS: PlanLimits = {
  maxTradesPerWeek: 5,
  maxCustomRules: 3,
  maxBlockingConditions: 3,
  maxStrategies: 3,
  realTimeBlocking: false,
  aiCoach: false,
  weeklySummary: false,
  excelExport: false,
};

const PRO_LIMITS: PlanLimits = {
  maxTradesPerWeek: null,
  maxCustomRules: null,
  maxBlockingConditions: null,
  maxStrategies: null,
  realTimeBlocking: true,
  aiCoach: true,
  weeklySummary: true,
  excelExport: true,
};

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  // free is a legacy default tier — users who haven't chosen a plan yet get basic-level limits
  free: BASIC_LIMITS,
  basic: BASIC_LIMITS,
  pro: PRO_LIMITS,
};

export function getPlanLimits(tier: string | null | undefined): PlanLimits {
  if (tier === 'pro') return PLAN_LIMITS.pro;
  if (tier === 'basic') return PLAN_LIMITS.basic;
  return PLAN_LIMITS.free;
}

export function isPro(tier: string | null | undefined): boolean {
  return tier === 'pro';
}

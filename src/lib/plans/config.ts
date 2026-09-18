// Must match the DB CHECK constraint on profiles.subscription_tier
// (supabase/migrations/002_v3_features.sql)
//
// ── One plan ──
//
// Reflect sells a single plan. There is no Basic/Pro split any more: we did not
// have enough features to divide into tiers in a way that made sense, and every
// division we tried penalised the traders we most want using the product.
//
// The tier column and this union stay. Nothing in the DB changed, so no
// migration was needed for this, and re-introducing a tier later is a change to
// PLAN_LIMITS rather than a schema migration plus a backfill. What changed is
// that all three tiers now resolve to the same limits, so every limit check in
// the app — and there are many, in RulesEditor, StrategiesClient,
// StrategyBuilder, TradePlanForm, AppShell, DashboardClient and the ai-chat and
// weekly-summary routes — is now a no-op that always passes. Those call sites
// were deliberately left in place: they are correct as written, they cost
// nothing while every limit is unlimited, and they are what a future tier would
// need anyway.
export type PlanTier = 'free' | 'basic' | 'pro';

export interface PlanLimits {
  /** null means unlimited. */
  maxTradesPerWeek: number | null;
  maxCustomRules: number | null;
  maxBlockingConditions: number | null;
  maxStrategies: number | null;
  /**
   * Whether a violated rule can block submitting a trade plan, rather than only
   * warn about it. In-app only: Reflect has no connection to a trading platform
   * and cannot stop an order anywhere but here. See Terms section 6.2.
   */
  realTimeBlocking: boolean;
  aiCoach: boolean;
  weeklySummary: boolean;
}

// The one plan. Everything on, nothing capped.
const FULL_LIMITS: PlanLimits = {
  maxTradesPerWeek: null,
  maxCustomRules: null,
  maxBlockingConditions: null,
  maxStrategies: null,
  realTimeBlocking: true,
  aiCoach: true,
  weeklySummary: true,
};

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: FULL_LIMITS,
  basic: FULL_LIMITS,
  pro: FULL_LIMITS,
};

/**
 * Still a real lookup rather than `return FULL_LIMITS`. Every tier maps to the
 * same object today, so the result is the same either way — but written this
 * way, re-introducing a tier is one edit to PLAN_LIMITS and nothing here.
 */
export function getPlanLimits(tier: string | null | undefined): PlanLimits {
  return PLAN_LIMITS[tier === 'pro' || tier === 'basic' ? tier : 'free'];
}

/**
 * Retained so the call sites that ask keep compiling and keep reading sensibly.
 * Derived rather than hardcoded to `true`: with one plan every user is on the
 * full plan, and if tiers ever diverge again this answers correctly with no
 * edit here.
 */
export function isPro(tier: string | null | undefined): boolean {
  return getPlanLimits(tier) === PLAN_LIMITS.pro;
}

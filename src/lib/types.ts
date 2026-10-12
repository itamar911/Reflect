import type { PlanTier } from '@/lib/plans/config';

export type TradingType = 'scalping' | 'day' | 'swing' | 'position' | 'crypto' | 'futures';
export type ExperienceLevel = 'beginner' | 'intermediate' | 'advanced';
export type Market = 'stocks' | 'crypto' | 'forex' | 'options' | 'futures' | 'etf' | 'commodities';
export type SubscriptionTier = PlanTier;
export type TradeStrategy =
  | 'Breakout' | 'Trend Follow' | 'Reversal' | 'Range' | 'Futures' | 'Custom'
  | 'ICT' | 'SMC' | 'VWAP' | 'Supply & Demand' | 'Price Action' | 'Scalping'
  | 'Gap & Go' | 'Elliott Wave' | 'Fibonacci' | 'Moving Average' | 'RSI Divergence' | 'Order Flow';
export type ConditionType =
  | 'daily_loss_dollar'
  | 'daily_loss_percent'
  | 'daily_trades_count'
  | 'loss_streak'
  | 'hour_after'
  | 'fomo_last_trade'
  | 'exited_early_last_trade'
  | 'moved_sl_last_trade';
export type ActionType = 'block_day' | 'block_timer' | 'warn';
export type ValidationStatus = 'valid' | 'warning' | 'blocked';
export type EmotionalPattern = 'FOMO' | 'REVENGE' | 'FEAR' | 'OVERCONFIDENCE' | 'NONE';
// 'not_entered' is a plan the user confirmed they never took — asked about in
// the next form when a plan is still open from a previous day (REF-82 §5.2).
// It is not 'closed': there is no exit price and no P&L. Allowed by the status
// CHECK from migration 032.
//
// Readers that filter on status have to decide about it explicitly; a
// 'not_entered' plan is not a trade taken. lib/rules/tradeRuleContext.ts
// counts today's trades with no status filter and so would currently count
// one — that is step 2's work, not this change's.
export type TradeStatus = 'open' | 'closed' | 'not_entered';
export type TraderIdentity = 'Disciplined Sniper' | 'Emotional Trader' | 'Risk Taker' | 'Aggressive Scalper' | 'Developing Trader';
export type StreakType = 'discipline' | 'no_revenge' | 'stop_loss' | 'full_discipline';
export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1H' | '4H' | 'Daily' | 'Weekly';
export type RiskType = 'dollar' | 'percent';

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  trading_type: TradingType[];
  experience_level: ExperienceLevel;
  default_market: Market[];
  custom_strategies: string[] | null;
  trader_identity: TraderIdentity | null;
  trader_type: string | null;
  onboarding_completed: boolean;
  subscription_tier: SubscriptionTier;
  created_at: string;
  updated_at: string;
}

export interface PresetRules {
  id: string;
  user_id: string;
  min_rr_ratio: number;
  max_daily_trades: number;
  cooldown_after_losses: number;
  cooldown_minutes: number | null;
  max_daily_loss: number | null;
  min_emotional_state: number;
  allowed_strategies: TradeStrategy[];
  created_at: string;
  updated_at: string;
}

export interface CustomRule {
  id: string;
  user_id: string;
  name: string;
  is_active: boolean;
  condition_type: ConditionType;
  threshold_value: number | null;
  action_type: ActionType;
  cooldown_minutes: number | null;
  created_at: string;
}

export interface TradePlan {
  id: string;
  user_id: string;
  strategy: TradeStrategy | string;
  symbol: string | null;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  rr_ratio: number;
  trade_reason: string;
  emotional_state: number;
  confidence_level: number | null;
  timeframe: Timeframe | string | null;
  status: TradeStatus;
  exit_price: number | null;
  exit_reason: string | null;
  post_trade_notes: string | null;
  plan_score: number | null;
  debrief_answer: string | null;
  debrief_submitted_at: string | null;
  submitted_at: string;
  closed_at: string | null;
  quantity: number | null;
  pnl_amount: number | null;
  pnl_currency: PnlCurrency | null;
  followed_plan: boolean | null;
  kept_sl: boolean | null;
  proper_size: boolean | null;
  moved_sl: boolean | null;
  exited_early: boolean | null;
  fomo_entry: boolean | null;
  revenge_trade: boolean | null;
  direction: 'long' | 'short' | null;
  units: number | null;
  point_value: number | null;
  risk_amount: number | null;
  risk_type: RiskType | null;
  actual_pnl: number | null;
  strategy_conditions_checked: { condition: string; checked: boolean }[] | null;

  // ── Added by migration 032, which is not applied yet ──────────────────────
  //
  // OPTIONAL ON PURPOSE, and not because the columns are nullable — 032
  // declares both NOT NULL with a DEFAULT, so once it has run every row
  // carries a value. They are optional because the migration is run by hand
  // and production has to keep working in the window before that happens:
  // until then `select *` returns rows without these keys, and a required
  // `boolean` here would have TypeScript promise a value that is `undefined`
  // at runtime. Optional makes callers handle the absence, which is the true
  // state of the data.
  //
  // Tighten both to required once 032 is applied and the window is closed.
  // Nothing reads or writes them yet.

  /** A trade that reached the journal with no plan behind it (REF-82 §5.4).
   *  Marked, and still counted toward the rules. Written by REF-90, which is
   *  not built — so this is false on every row today. */
  unplanned?: boolean;

  /** What the rule check had to judge this plan against when it was saved
   *  (REF-82 §6), so a plan saved while broker data was missing can later be
   *  shown as "saved without verification" rather than read as verified.
   *  REF-82 only ever writes 'reflect_only'; the broker values come from
   *  REF-90. */
  rule_context_source?: RuleContextSource;
}

/**
 * Where the rule check's view of the user's day came from.
 *
 * A four-value enum rather than the single "saved without verification"
 * boolean the brief proposes, because REF-82 §6 distinguishes two failure
 * kinds that need different things from the user — an expired connection they
 * fix in one click, and a Tradovate outage nobody can fix — and a boolean
 * cannot carry that difference. Decided on REF-82 (12.10).
 *
 * Mirrors trade_plans_rule_context_source_check in migration 032; the two must
 * change together.
 */
export type RuleContextSource =
  /** No broker data consulted. The default, and all REF-82 writes. */
  | 'reflect_only'
  /** Broker data was fetched and judged against. */
  | 'broker_verified'
  /** The connection had lapsed; the user must reconnect. */
  | 'broker_expired'
  /** The fetch failed upstream. */
  | 'broker_unavailable';

export type PnlCurrency = '₪' | '$';

export interface TradePlanInput {
  strategy: TradeStrategy | string;
  symbol: string;
  entry_price: string;
  stop_loss: string;
  take_profit: string;
  trade_reason: string;
  emotional_state: number;
  confidence_level: number;
  timeframe: Timeframe | '';
  direction: 'long' | 'short' | null;
  units: string;
  point_value: string;
}

// The 5 preset checks that validateTradePlan evaluates against numeric PresetRules
// thresholds — kept as a closed key union so rule-violation logging always has a
// stable identifier to attach to (the strategy-whitelist check is deliberately
// excluded: it has no numeric threshold and isn't logged as a structured violation).
export type PresetRuleKey =
  | 'min_emotional_state'
  | 'min_rr_ratio'
  | 'max_daily_trades'
  | 'cooldown_after_losses'
  | 'max_daily_loss';

export interface PresetRuleViolation {
  ruleKey: PresetRuleKey;
  ruleName: string;
  severity: 'block' | 'warn';
  message: string;
}

export interface RulesetValidationResult {
  status: ValidationStatus;
  blockedReasons: string[];
  warningReasons: string[];
  violations: PresetRuleViolation[];
}

export interface Streak {
  id: string;
  user_id: string;
  streak_type: StreakType;
  current_count: number;
  best_count: number;
  last_updated: string;
}

export interface AIInsight {
  id: string;
  user_id: string;
  type: 'time' | 'emotional' | 'revenge' | 'performance' | 'pattern' | 'discipline';
  content: string;
  generated_at: string;
}

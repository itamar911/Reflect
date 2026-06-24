export type TradingType = 'scalping' | 'day' | 'swing' | 'position' | 'crypto' | 'futures';
export type ExperienceLevel = 'beginner' | 'intermediate' | 'advanced';
export type Market = 'stocks' | 'crypto' | 'forex' | 'options' | 'futures' | 'etf' | 'commodities';
export type SubscriptionTier = 'free' | 'basic' | 'pro';
export type TradeStrategy = 'Breakout' | 'Trend Follow' | 'Reversal' | 'Range' | 'Futures' | 'Custom';
export type Enforcement = 'reminder' | 'warning' | 'block';
export type ValidationStatus = 'valid' | 'warning' | 'blocked';
export type EmotionalPattern = 'FOMO' | 'REVENGE' | 'FEAR' | 'OVERCONFIDENCE' | 'NONE';
export type TradeStatus = 'open' | 'closed';
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
  max_daily_loss: number | null;
  min_emotional_state: number;
  allowed_strategies: TradeStrategy[];
  created_at: string;
  updated_at: string;
}

export interface CustomRule {
  id: string;
  user_id: string;
  rule_name: string;
  trigger_condition: string;
  action_required: string;
  is_active: boolean;
  enforcement: Enforcement;
  created_at: string;
  updated_at: string;
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
  risk_amount: number | null;
  risk_type: RiskType | null;
  actual_pnl: number | null;
}

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
  risk_amount: string;
  risk_type: RiskType;
}

export interface RulesetValidationResult {
  status: ValidationStatus;
  blockedReasons: string[];
  warningReasons: string[];
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

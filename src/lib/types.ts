export type TradingType = 'day' | 'swing' | 'crypto';
export type ExperienceLevel = 'beginner' | 'intermediate' | 'advanced';
export type Market = 'stocks' | 'crypto' | 'forex';
export type TradeStrategy = 'Breakout' | 'Trend Follow' | 'Reversal' | 'Range' | 'Custom';
export type Enforcement = 'reminder' | 'warning' | 'block';
export type ValidationStatus = 'valid' | 'warning' | 'blocked';
export type EmotionalPattern = 'FOMO' | 'REVENGE' | 'FEAR' | 'OVERCONFIDENCE' | 'NONE';
export type TradeStatus = 'open' | 'closed';

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  trading_type: TradingType;
  experience_level: ExperienceLevel;
  default_market: Market;
  onboarding_completed: boolean;
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
  strategy: TradeStrategy;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  rr_ratio: number;
  trade_reason: string;
  emotional_state: number;
  status: TradeStatus;
  exit_price: number | null;
  exit_reason: string | null;
  post_trade_notes: string | null;
  plan_score: number | null;
  debrief_answer: string | null;
  debrief_submitted_at: string | null;
  submitted_at: string;
  closed_at: string | null;
}

export interface TradePlanInput {
  strategy: TradeStrategy | '';
  entry_price: string;
  stop_loss: string;
  take_profit: string;
  trade_reason: string;
  emotional_state: number;
}

export interface RulesetValidationResult {
  status: ValidationStatus;
  blockedReasons: string[];
  warningReasons: string[];
}

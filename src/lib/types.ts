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
  | 'moved_sl_last_trade'
  // REF-113 Stage 5. "I moved my stop AWAY from the entry on the last trade" —
  // the half of `moved_sl_last_trade` that is a discipline failure, since a
  // tightening is risk management (Imri, 19.10). The broad condition above
  // STAYS, AND STAYS THE DEFAULT: a trader who created it asked for every move,
  // and changing what their existing rule means would be a silent behaviour
  // change on a rule that can block their day.
  //
  // THE SET IS PINNED BY A `CHECK` CONSTRAINT (supabase/schema.sql, migration
  // 015), so this line is half a change: migration 039 step 1 extends that
  // constraint, and until the owner runs it a rule saved with this condition is
  // refused with a 23514. The editor offers it either way — its dropdown is
  // `Object.keys(CONDITION_LABELS)` — which is the loud failure rather than the
  // quiet one.
  | 'moved_sl_widened_last_trade';
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
  // ── The six intent columns. NULLABLE from migration 034 (REF-107 §E4) ──────
  //
  // They were NOT NULL, and typed as present, for as long as the trade form was
  // the only way a row got here. A trade that arrives from a broker has no
  // intent behind it: the broker knows price, quantity, direction, time and
  // money, and nothing about why the trader entered, what they planned, or how
  // they felt. E4 chose null over a placeholder because a placeholder is a
  // number that LOOKS like data — §0ג — and REF-107 Stage 4 is the change that
  // taught every reader to average over what survived a filter rather than over
  // `trades.length`.
  //
  // `| null` rather than optional, and the difference is real: once 034 has run
  // the KEY is always present and the VALUE may be null. `unplanned` below is
  // the other kind — a column that might not exist at all.
  strategy: TradeStrategy | string | null;
  symbol: string | null;
  entry_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  rr_ratio: number | null;
  trade_reason: string | null;
  emotional_state: number | null;
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

  // ── Added by migration 032, WHICH IS APPLIED ──────────────────────────────
  //
  // Confirmed applied and verified in production by Itamar on 13.10 (REF-107,
  // E1). Both columns are NOT NULL with a DEFAULT, so every row carries a
  // value and these could be tightened to required.
  //
  // THEY STAY OPTIONAL, for a reason that is no longer about 032: the same
  // `select('*')` readers also receive rows from a database that may not yet
  // have had migration 034 run against it, and the group below is optional for
  // that window. Two kinds of optional in one interface, distinguished only by
  // a comment, is worse than one — so these two keep the shape their
  // neighbours need. Nothing is lost: a caller that handles `undefined`
  // handles the real data.

  /** A trade that reached the journal with no plan behind it (REF-82 §5.4).
   *  Marked, and still counted toward the rules. Written by the broker import
   *  (REF-107 Stage 2, lib/tradovate/import.ts) and by nothing else. */
  unplanned?: boolean;

  /** What the rule check had to judge this plan against when it was saved
   *  (REF-82 §6), so a plan saved while broker data was missing can later be
   *  shown as "saved without verification" rather than read as verified.
   *  REF-82 writes 'reflect_only'; the import writes 'broker_verified', which
   *  on an imported row is a statement about the trade itself — it came from
   *  the broker. */
  rule_context_source?: RuleContextSource;

  // ── Added by migration 034, which is run by hand (REF-107 Stage 2) ─────────
  //
  // OPTIONAL FOR THE WINDOW BEFORE THAT HAPPENS, exactly as the 032 pair was:
  // `select('*')` returns rows without these keys until the owner has run the
  // file, and a required field here would have TypeScript promise a value that
  // is `undefined` at runtime.
  //
  // Nothing READS or WRITES them unless TRADOVATE_IMPORT_ENABLED is '1' — see
  // isImportEnabled in lib/tradovate/import.ts. That flag, not this typing, is
  // what makes the deploy order free; the typing is what stops a reader from
  // trusting a value that is not there yet.
  //
  // Tighten `source` and `hidden` to required once 034 is applied everywhere.

  /** Where this trade came from. 'manual' is the default and the truth about
   *  every row written by the trade form. One table, one shape — no feature
   *  may require a broker (Imri, 13.10). */
  source?: TradeSource;

  /** The broker's natural key for the trade: `<host>:<lowest fill id in the
   *  group>`. Null on a manual row. The partial UNIQUE on
   *  (user_id, broker_trade_key) is what makes a re-sync idempotent. */
  broker_trade_key?: string | null;

  /** The broker account the trade was executed on (E15, REF-110). Rules stay
   *  aggregated across a trader's accounts; a journal that mixes a prop
   *  evaluation account with a personal one is a journal nobody can read. */
  broker_account_id?: number | null;

  /** Which Tradovate host reported it. Host-local ids are why this is stored
   *  beside the account id and why it is part of the key. */
  broker_host?: TradovateHost | null;

  /** Hidden from the journal. E12: deleting a broker row cannot be a DELETE,
   *  because the next sync would bring it straight back — the UNIQUE prevents
   *  a duplicate, it does not remember a deletion. So delete sets this, and
   *  the import skips a hidden key instead of resurrecting it. */
  hidden?: boolean;

  // ── Added by migration 037, also run by hand (REF-110 Stages 1-2) ─────────

  /** The portfolio this trade belongs to — a row in `accounts`.
   *
   *  NULL MEANS UNASSIGNED, NOT MANUAL, and the distinction is the whole of
   *  Stage 3: every row written before REF-110 is in this state, and reading
   *  it as "manual" would claim a trader's entire history for a portfolio
   *  they never created. The screen shows those in an explicit "ללא תיק"
   *  bucket they assign from (Imri, 17.10).
   *
   *  Written by the broker import from `broker_account_id` + `broker_host`,
   *  and by the backfill pass in lib/tradovate/account-sync.ts. Nothing reads
   *  it yet — the screen and the filter are Stages 4 and 5. */
  account_id?: string | null;
}

/**
 * Where a trade came from.
 *
 * Mirrors trade_plans_source_check in migration 034; the two must change
 * together. Stage 6 of REF-107 adds a second broker here, which is an added
 * value rather than a change of shape — the reason `source` is CHECKed rather
 * than free text.
 */
export type TradeSource = 'manual' | 'tradovate';

/**
 * Which Tradovate environment reported a trade.
 *
 * The same two values as `TradovateEnvironment` in lib/tradovate/hosts.ts, and
 * deliberately not an import of it: that module is server-only by construction
 * and this type travels to the browser on every journal row. Mirrors
 * trade_plans_broker_host_check in migration 034.
 */
export type TradovateHost = 'live' | 'demo';

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

/**
 * The currency a trading amount is in. One member, deliberately (REF-99).
 *
 * `trade_plans.pnl_currency` is still a column and still read, because rows
 * written before migration 033 carry '₪' as a LABEL on a number the user
 * already entered in dollars. Nothing converts; the migration relabels. Typing
 * this as a single-member union makes any attempt to write a shekel back a
 * compile error rather than a row that disagrees with the rest of the table.
 *
 * Our own subscription pricing is in shekels and is NOT a trading amount — it
 * never touches this type. See lib/money.ts.
 */
export type PnlCurrency = '$';

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
  /**
   * OPTIONAL SINCE REF-123, and the trade form no longer produces it at all:
   * the "יחידות/חוזים" field was removed and the insert does not name the
   * column, so a form-created row has `units IS NULL`. Kept on the type rather
   * than deleted because nothing in `validateTradePlan` ever read it, so its
   * absence breaks no caller — and `trade_plans.units` itself is untouched.
   */
  units?: string;
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

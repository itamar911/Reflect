-- Reflekt Database Schema
-- Run this in Supabase SQL editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────
-- PROFILES
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  trading_type TEXT NOT NULL DEFAULT 'day'
    CHECK (trading_type IN ('day', 'swing', 'crypto')),
  experience_level TEXT NOT NULL DEFAULT 'beginner'
    CHECK (experience_level IN ('beginner', 'intermediate', 'advanced')),
  default_market TEXT NOT NULL DEFAULT 'stocks'
    CHECK (default_market IN ('stocks', 'crypto', 'forex')),
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ─────────────────────────────────────────
-- PRESET RULES
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS preset_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL UNIQUE,
  min_rr_ratio DECIMAL NOT NULL DEFAULT 2.0,
  max_daily_trades INTEGER NOT NULL DEFAULT 5,
  cooldown_after_losses INTEGER NOT NULL DEFAULT 3,
  cooldown_minutes INTEGER,
  max_daily_loss DECIMAL,
  min_emotional_state INTEGER NOT NULL DEFAULT 2
    CHECK (min_emotional_state BETWEEN 1 AND 5),
  allowed_strategies TEXT[] NOT NULL DEFAULT ARRAY['Breakout','Trend Follow','Reversal','Range','Custom'],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE preset_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own preset rules"
  ON preset_rules FOR ALL USING (auth.uid() = user_id);

-- Auto-create default preset rules when profile is created
CREATE OR REPLACE FUNCTION handle_new_profile()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO preset_rules (user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_profile_created
  AFTER INSERT ON profiles
  FOR EACH ROW EXECUTE FUNCTION handle_new_profile();

-- ─────────────────────────────────────────
-- CUSTOM RULES
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  rule_name TEXT NOT NULL,
  trigger_condition TEXT NOT NULL,
  action_required TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  enforcement TEXT NOT NULL DEFAULT 'warning'
    CHECK (enforcement IN ('reminder', 'warning', 'block')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE custom_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own custom rules"
  ON custom_rules FOR ALL USING (auth.uid() = user_id);

-- ─────────────────────────────────────────
-- TRADE PLANS
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trade_plans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  strategy TEXT NOT NULL,
  entry_price DECIMAL NOT NULL,
  stop_loss DECIMAL NOT NULL,
  take_profit DECIMAL NOT NULL,
  rr_ratio DECIMAL NOT NULL,
  trade_reason TEXT NOT NULL,
  emotional_state INTEGER NOT NULL CHECK (emotional_state BETWEEN 1 AND 5),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed')),
  exit_price DECIMAL,
  exit_reason TEXT,
  post_trade_notes TEXT,
  plan_score INTEGER CHECK (plan_score BETWEEN 0 AND 100),
  debrief_answer TEXT,
  debrief_submitted_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

ALTER TABLE trade_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own trade plans"
  ON trade_plans FOR ALL USING (auth.uid() = user_id);

-- Index for fast daily count queries
CREATE INDEX IF NOT EXISTS idx_trade_plans_user_date
  ON trade_plans (user_id, submitted_at DESC);

-- ─────────────────────────────────────────
-- UPDATED_AT TRIGGER
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER preset_rules_updated_at
  BEFORE UPDATE ON preset_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER custom_rules_updated_at
  BEFORE UPDATE ON custom_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────
-- MIGRATIONS — run on existing databases
-- ─────────────────────────────────────────

-- v2: Add debrief fields to trade_plans (Reflekt rebranding)
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS debrief_answer TEXT,
  ADD COLUMN IF NOT EXISTS debrief_submitted_at TIMESTAMPTZ;

-- Index for debrief queries (find un-debriefed closed trades)
CREATE INDEX IF NOT EXISTS idx_trade_plans_debrief
  ON trade_plans (user_id, status, debrief_submitted_at)
  WHERE status = 'closed';

-- v3: Add multiplier for futures contracts P&L calculation
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS multiplier NUMERIC DEFAULT 1;

-- v4: Enable Realtime so the dashboard can subscribe to trade_plans changes
ALTER PUBLICATION supabase_realtime ADD TABLE trade_plans;

-- v5: Process-quality checklist, answered when closing a trade
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS followed_plan BOOLEAN,
  ADD COLUMN IF NOT EXISTS kept_sl BOOLEAN,
  ADD COLUMN IF NOT EXISTS proper_size BOOLEAN;

-- v6: Weekly AI summaries shown on the dashboard
CREATE TABLE IF NOT EXISTS weekly_summaries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  summary_text TEXT,
  stats JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE weekly_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own weekly summaries"
  ON weekly_summaries FOR ALL USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_weekly_summaries_user_week
  ON weekly_summaries (user_id, week_start DESC);

-- v7: Confidence level + timeframe on trade entry, expanded discipline checklist on exit
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS confidence_level INTEGER CHECK (confidence_level BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS timeframe TEXT,
  ADD COLUMN IF NOT EXISTS moved_sl BOOLEAN,
  ADD COLUMN IF NOT EXISTS exited_early BOOLEAN,
  ADD COLUMN IF NOT EXISTS fomo_entry BOOLEAN,
  ADD COLUMN IF NOT EXISTS revenge_trade BOOLEAN;

-- v8: Direction + position sizing committed at entry time, and an actual-PnL override at exit
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS direction TEXT CHECK (direction IN ('long', 'short')),
  ADD COLUMN IF NOT EXISTS units NUMERIC,
  ADD COLUMN IF NOT EXISTS risk_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS risk_type TEXT CHECK (risk_type IN ('dollar', 'percent')),
  ADD COLUMN IF NOT EXISTS actual_pnl NUMERIC;

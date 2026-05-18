-- Migration: v3 features — personal strategies, alert settings, subscription tier
-- Run in Supabase SQL Editor

-- Add subscription_tier to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS subscription_tier TEXT NOT NULL DEFAULT 'free'
    CHECK (subscription_tier IN ('free', 'basic', 'pro'));

-- Personal strategies table
CREATE TABLE IF NOT EXISTS personal_strategies (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT 'both' CHECK (direction IN ('long', 'short', 'both')),
  stop_loss_points DECIMAL,
  take_profit_points DECIMAL,
  risk_rules TEXT NOT NULL DEFAULT '',
  preferred_hours TEXT NOT NULL DEFAULT '',
  markets TEXT[] NOT NULL DEFAULT '{}',
  is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE personal_strategies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own strategies"
  ON personal_strategies FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_personal_strategies_user
  ON personal_strategies (user_id, created_at DESC);

CREATE TRIGGER personal_strategies_updated_at
  BEFORE UPDATE ON personal_strategies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Alert settings table
CREATE TABLE IF NOT EXISTS alert_settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL UNIQUE,
  pre_market_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  pre_market_time TEXT NOT NULL DEFAULT '08:30',
  end_of_day_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  end_of_day_time TEXT NOT NULL DEFAULT '21:00',
  discipline_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  weekly_summary_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  weekly_summary_time TEXT NOT NULL DEFAULT '09:00',
  realtime_pattern_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE alert_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own alert settings"
  ON alert_settings FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER alert_settings_updated_at
  BEFORE UPDATE ON alert_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Add direction column to trade_plans
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS direction TEXT CHECK (direction IN ('long', 'short'));

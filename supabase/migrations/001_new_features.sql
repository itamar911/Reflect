-- Migration: New features for Reflect v2
-- Run this in Supabase SQL Editor

-- Add new columns to profiles (safe — no data loss)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS custom_strategies TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS trader_identity TEXT DEFAULT NULL;

-- Add 'futures' to allowed trading types (existing TEXT column stays as-is)
-- trading_type TEXT column already exists, no change needed for single-value storage

-- Update allowed_strategies default in preset_rules to include Futures
UPDATE preset_rules
SET allowed_strategies = ARRAY['Breakout', 'Trend Follow', 'Reversal', 'Range', 'Futures', 'Custom']
WHERE allowed_strategies = ARRAY['Breakout', 'Trend Follow', 'Reversal', 'Range', 'Custom']
  OR allowed_strategies IS NULL;

-- Create streaks table
CREATE TABLE IF NOT EXISTS streaks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  streak_type TEXT NOT NULL CHECK (streak_type IN ('discipline', 'no_revenge', 'stop_loss', 'full_discipline')),
  current_count INTEGER NOT NULL DEFAULT 0,
  best_count INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, streak_type)
);

ALTER TABLE streaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own streaks"
  ON streaks FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Create ai_insights table
CREATE TABLE IF NOT EXISTS ai_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('time', 'emotional', 'revenge', 'performance', 'pattern', 'discipline')),
  content TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ai_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own insights"
  ON ai_insights FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_ai_insights_user ON ai_insights(user_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_streaks_user ON streaks(user_id);

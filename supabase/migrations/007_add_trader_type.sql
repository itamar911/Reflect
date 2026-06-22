-- Migration: store the AI-generated onboarding trader-identity result
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS trader_type TEXT DEFAULT NULL;

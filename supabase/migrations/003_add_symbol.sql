-- Migration: add symbol column to trade_plans
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS symbol TEXT;

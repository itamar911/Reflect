-- Migration: add quantity / value-per-unit / P&L (₪) columns to trade_plans
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS quantity NUMERIC,
  ADD COLUMN IF NOT EXISTS value_per_unit NUMERIC,
  ADD COLUMN IF NOT EXISTS pnl_amount NUMERIC;

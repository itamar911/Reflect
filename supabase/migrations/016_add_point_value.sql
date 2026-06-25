-- Point/contract value multiplier for PnL calculation: (exit - entry) * units * point_value.
-- Defaults to 1 so existing trades' PnL math is unaffected.
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS point_value NUMERIC DEFAULT 1;

-- v7: Confidence level + timeframe on trade entry, expanded discipline checklist on exit
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS confidence_level INTEGER CHECK (confidence_level BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS timeframe TEXT,
  ADD COLUMN IF NOT EXISTS moved_sl BOOLEAN,
  ADD COLUMN IF NOT EXISTS exited_early BOOLEAN,
  ADD COLUMN IF NOT EXISTS fomo_entry BOOLEAN,
  ADD COLUMN IF NOT EXISTS revenge_trade BOOLEAN;

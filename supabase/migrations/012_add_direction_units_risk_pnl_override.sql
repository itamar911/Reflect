-- Direction + position sizing committed at entry time, and an actual-PnL override at exit.
ALTER TABLE trade_plans
  ADD COLUMN IF NOT EXISTS direction TEXT CHECK (direction IN ('long', 'short')),
  ADD COLUMN IF NOT EXISTS units NUMERIC,
  ADD COLUMN IF NOT EXISTS risk_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS risk_type TEXT CHECK (risk_type IN ('dollar', 'percent')),
  ADD COLUMN IF NOT EXISTS actual_pnl NUMERIC;

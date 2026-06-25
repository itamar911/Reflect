-- Rebuild custom_rules as a structured rule system (condition_type + threshold_value
-- + action_type + cooldown_minutes), replacing the old free-text
-- trigger_condition / action_required / enforcement model. Free-text rules
-- couldn't be evaluated programmatically, so personal rules were never
-- actually enforced — this makes them checkable in code.
DROP TABLE IF EXISTS custom_rules CASCADE;

CREATE TABLE custom_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  condition_type TEXT NOT NULL CHECK (condition_type IN (
    'daily_loss_dollar',
    'daily_loss_percent',
    'daily_trades_count',
    'loss_streak',
    'hour_after',
    'fomo_last_trade',
    'exited_early_last_trade',
    'moved_sl_last_trade'
  )),
  threshold_value NUMERIC,
  action_type TEXT NOT NULL DEFAULT 'warn'
    CHECK (action_type IN ('block_day', 'block_timer', 'warn')),
  cooldown_minutes INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE custom_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own custom rules"
  ON custom_rules FOR ALL USING (auth.uid() = user_id);

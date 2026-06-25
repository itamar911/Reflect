-- Time-based cooldown duration (in minutes), separate from cooldown_after_losses
-- (which is a loss-streak count). NULL means no time-based cooldown configured.
ALTER TABLE preset_rules
  ADD COLUMN IF NOT EXISTS cooldown_minutes INTEGER;

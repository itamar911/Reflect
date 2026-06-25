-- Timer duration (in minutes) for custom rules with enforcement = 'block' ("נעילה עם טיימר").
ALTER TABLE custom_rules
  ADD COLUMN IF NOT EXISTS cooldown_minutes INTEGER;

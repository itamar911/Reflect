-- Migration: allow Scalping and Position Trading as trading_type values
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_trading_type_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_trading_type_check
  CHECK (trading_type IN ('scalping', 'day', 'swing', 'position', 'crypto', 'futures'));

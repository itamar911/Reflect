-- Migration: trading_type becomes a multi-select (TEXT[] instead of TEXT)
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_trading_type_check;

ALTER TABLE profiles
  ALTER COLUMN trading_type TYPE TEXT[] USING ARRAY[trading_type];

ALTER TABLE profiles
  ALTER COLUMN trading_type SET DEFAULT ARRAY['day']::TEXT[];

ALTER TABLE profiles
  ADD CONSTRAINT profiles_trading_type_check
  CHECK (trading_type <@ ARRAY['scalping', 'day', 'swing', 'position', 'crypto', 'futures']::TEXT[]);

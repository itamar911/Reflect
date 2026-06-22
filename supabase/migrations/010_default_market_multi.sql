-- Migration: default_market becomes a multi-select (TEXT[] instead of TEXT)
-- and gains options, etf and commodities as valid markets.
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_default_market_check;

ALTER TABLE profiles
  ALTER COLUMN default_market TYPE TEXT[] USING ARRAY[default_market];

ALTER TABLE profiles
  ALTER COLUMN default_market SET DEFAULT ARRAY['stocks']::TEXT[];

ALTER TABLE profiles
  ADD CONSTRAINT profiles_default_market_check
  CHECK (default_market <@ ARRAY['stocks', 'crypto', 'forex', 'options', 'futures', 'etf', 'commodities']::TEXT[]);

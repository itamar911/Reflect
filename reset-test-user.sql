-- Reset seince33@gmail.com to a brand-new-user state.
-- Run in the Supabase SQL editor for project ref: rsoymnthrmlpdqwmvdzr
-- Does NOT delete the auth user — only their data.

-- 1. Find the user id (run this first to confirm you're targeting the right row)
select id, email
from auth.users
where email = 'seince33@gmail.com';

-- 2. Delete all trades / journal entries
delete from trade_plans
where user_id = (select id from auth.users where email = 'seince33@gmail.com');

-- 3. Delete alert/notification preferences (recreated fresh on next visit to Settings)
delete from alert_settings
where user_id = (select id from auth.users where email = 'seince33@gmail.com');

-- 4. Reset onboarding + onboarding-collected profile fields back to schema defaults
--    (keeps email/display_name/subscription_tier untouched)
update profiles
set
  onboarding_completed = false,
  trading_type = 'day',
  experience_level = 'beginner',
  default_market = 'stocks'
where id = (select id from auth.users where email = 'seince33@gmail.com');

-- 5. Verify
select id, email, onboarding_completed, trading_type, experience_level, default_market
from profiles
where id = (select id from auth.users where email = 'seince33@gmail.com');

select count(*) as remaining_trades from trade_plans
where user_id = (select id from auth.users where email = 'seince33@gmail.com');

select count(*) as remaining_alert_settings from alert_settings
where user_id = (select id from auth.users where email = 'seince33@gmail.com');

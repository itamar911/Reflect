import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { getPlanLimits, type PlanTier, type PlanLimits } from './config';

export interface UserPlan {
  tier: PlanTier;
  limits: PlanLimits;
}

/**
 * The trader's plan tier, read once per request (REF-129 item 4).
 *
 * WHY cache(), AND WHY THE CLIENT IS NO LONGER A PARAMETER
 * --------------------------------------------------------
 *
 * Every page in the (app) group renders inside a layout that calls this, and
 * two of them call it again themselves — so the `profiles` row was being read
 * two to four times per page view, each one a separate round trip to Supabase,
 * for a column that cannot change mid-render. React's `cache()` memoizes per
 * request, the same arrangement `getCachedUser` (lib/supabase/server.ts) uses
 * and for the same reason.
 *
 * It only works because the Supabase client stopped being an argument.
 * `cache()` keys on the arguments by reference, and `createClient()` returns a
 * NEW object on every call — the layout's client and the page's client are
 * different objects, so a cache keyed on `(supabase, userId)` would have missed
 * every single time and quietly done nothing. Keyed on `userId` alone it hits,
 * and the client is built inside.
 *
 * Nothing is lost by building it here: all six call sites passed the user's own
 * `createClient()` client, which is what this builds, and that function is also
 * what resolves demo mode (the `x-demo-mode` header) — so a /demo page still
 * reads fixtures rather than the database, exactly as before.
 *
 * SERVER-ONLY, now by construction rather than by convention: `createClient()`
 * reads `next/headers`. Every caller was already a server component or a route
 * handler.
 */
export const getUserPlan = cache(async (userId: string): Promise<UserPlan> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single();

    if (error || !data) {
      return { tier: 'free', limits: getPlanLimits('free') };
    }

    const tier = (data.subscription_tier ?? 'free') as PlanTier;
    return { tier, limits: getPlanLimits(tier) };
  } catch {
    return { tier: 'free', limits: getPlanLimits('free') };
  }
});

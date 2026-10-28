import { redirect } from 'next/navigation';
import { createClient, getCachedUser } from '@/lib/supabase/server';
import { getUserPlan } from '@/lib/plans/getUserPlan';
import { isImportEnabled } from '@/lib/tradovate/import';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import AppShell from '@/components/layout/AppShell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();

  if (!user) redirect('/login');

  const [{ data: profile }, { tier: plan }, { data: alertSettings }] = await Promise.all([
    supabase
      .from('profiles')
      .select('onboarding_completed, display_name')
      .eq('id', user.id)
      .single(),
    getUserPlan(user.id),
    supabase.from('alert_settings').select('discipline_enabled').eq('user_id', user.id).single(),
  ]);

  if (profile && !profile.onboarding_completed) redirect('/onboarding');

  // Whether `accounts` and `trade_plans.account_id` exist — migration 037
  // (REF-110). Evaluated here because `isImportEnabled()` reads process.env
  // and must not reach a browser bundle; the shell is a client component, so
  // the answer travels as a prop. The same arrangement `withHidden` already
  // documents for 034's columns, and the same flag, because it is the same
  // question: has the owner run the migration this code names columns from.
  //
  // It decides two things in the shell: whether "התיקים שלי" is in the nav,
  // and whether the trade form asks for a "תיק".
  const portfoliosEnabled = isImportEnabled();

  // Whether there is a broker to ask what the trader is holding (REF-108).
  // STRICTER than the line above and a different question: that one asks
  // whether `accounts` exists, this asks whether this trader has a broker
  // view at all. Both halves are server-only — `isUserAllowed` reads an
  // environment variable — which is why this is decided here and travels as
  // a prop, the same arrangement `canSync` uses on three other pages.
  //
  // The route refuses a caller outside the allowlist anyway and the clock
  // stops polling on `reflect_only`, so a wrong `false` costs the feature and
  // a wrong `true` costs exactly one request. Deciding it here is about not
  // making that request for every trader on every page.
  const liveEnabled = portfoliosEnabled && isUserAllowed(user.id);

  return (
    <AppShell
      userId={user.id}
      displayName={profile?.display_name ?? user.email ?? ''}
      plan={plan}
      disciplineAlertsEnabled={alertSettings?.discipline_enabled ?? true}
      portfoliosEnabled={portfoliosEnabled}
      liveEnabled={liveEnabled}
    >
      {children}
    </AppShell>
  );
}

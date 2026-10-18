import { redirect } from 'next/navigation';
import { createClient, getCachedUser } from '@/lib/supabase/server';
import { getUserPlan } from '@/lib/plans/getUserPlan';
import { isImportEnabled } from '@/lib/tradovate/import';
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
    getUserPlan(supabase, user.id),
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

  return (
    <AppShell
      userId={user.id}
      displayName={profile?.display_name ?? user.email ?? ''}
      plan={plan}
      disciplineAlertsEnabled={alertSettings?.discipline_enabled ?? true}
      portfoliosEnabled={portfoliosEnabled}
    >
      {children}
    </AppShell>
  );
}

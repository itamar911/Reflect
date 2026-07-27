import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getUserPlan } from '@/lib/plans/getUserPlan';
import AppShell from '@/components/layout/AppShell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

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

  return (
    <AppShell
      userId={user.id}
      displayName={profile?.display_name ?? user.email ?? ''}
      plan={plan}
      disciplineAlertsEnabled={alertSettings?.discipline_enabled ?? true}
    >
      {children}
    </AppShell>
  );
}

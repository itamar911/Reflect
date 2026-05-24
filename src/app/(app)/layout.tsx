import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import AppShell from '@/components/layout/AppShell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('onboarding_completed, display_name, subscription_tier')
    .eq('id', user.id)
    .single();

  const isPro = profile?.subscription_tier === 'pro';
  if (profile && !profile.onboarding_completed && !isPro) redirect('/onboarding');

  return (
    <AppShell userId={user.id} displayName={profile?.display_name ?? user.email ?? ''}>
      {children}
    </AppShell>
  );
}

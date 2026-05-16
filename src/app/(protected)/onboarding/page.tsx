import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import OnboardingWizard from '@/components/onboarding/OnboardingWizard';

export const metadata = { title: 'הגדרת פרופיל — Reflekt' };

export default async function OnboardingPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('onboarding_completed')
    .eq('id', user.id)
    .single();

  if (profile?.onboarding_completed) redirect('/dashboard');

  return <OnboardingWizard userId={user.id} />;
}

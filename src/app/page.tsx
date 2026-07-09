import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { LandingNav } from '@/components/landing/LandingNav';
import { HeroSection } from '@/components/landing/HeroSection';
import { LoopSection } from '@/components/landing/LoopSection';
import { DistinctionSection } from '@/components/landing/DistinctionSection';
import { HowItWorksSection } from '@/components/landing/HowItWorksSection';
import { TryDemoSection } from '@/components/landing/TryDemoSection';
import { FeaturesSection } from '@/components/landing/FeaturesSection';
import { SocialProofSection } from '@/components/landing/SocialProofSection';
import { PricingSection } from '@/components/landing/PricingSection';
import { FaqSection } from '@/components/landing/FaqSection';
import { FinalCtaSection } from '@/components/landing/FinalCtaSection';
import { LandingFooter } from '@/components/landing/LandingFooter';
import '@/components/landing/landing.css';

export const metadata: Metadata = {
  title: 'Reflect — יומן המסחר שעוצר אותך לפני הטעות',
  description:
    'Reflect הוא יומן המסחר שנכנס לרגע שלפני העסקה — אתה מגדיר את החוקים שלך, והוא עוצר אותך בפרצוף כשאתה עומד להפר אותם. לפני הכניסה, לא אחרי ההפסד.',
};

export default async function HomePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    redirect('/dashboard');
  }

  return (
    <div dir="rtl" className="landing">
      <LandingNav />
      <main>
        <HeroSection />
        <LoopSection />
        <DistinctionSection />
        <HowItWorksSection />
        <TryDemoSection />
        <FeaturesSection />
        <SocialProofSection />
        <PricingSection />
        <FaqSection />
        <FinalCtaSection />
      </main>
      <LandingFooter />
    </div>
  );
}

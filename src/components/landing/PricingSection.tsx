import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';
import { MarketingPricing } from './MarketingPricing';

export function PricingSection() {
  return (
    <section id="pricing" className="cv-auto relative py-24 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        <SectionHeading sub="שני המסלולים כוללים 5 ימי ניסיון חינם, בלי כרטיס אשראי. בחר את מה שמתאים לך — ואפשר לשדרג בכל רגע.">
          המסלולים שלנו
        </SectionHeading>
        <ScrollReveal delay={140}>
          <MarketingPricing />
        </ScrollReveal>
      </div>
    </section>
  );
}

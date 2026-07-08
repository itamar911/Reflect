import { ScrollReveal } from './ScrollReveal';
import { MarketingPricing } from './MarketingPricing';

export function PricingSection() {
  return (
    <section id="pricing" className="cv-auto relative py-16 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        <div className="flex flex-col items-center text-center mb-9">
          <ScrollReveal>
            <div className="flex items-center gap-4 md:gap-6">
              <span className="pricing-title-line" aria-hidden />
              <h2 className="pricing-title">המסלולים שלנו</h2>
              <span className="pricing-title-line" aria-hidden />
            </div>
          </ScrollReveal>
          <ScrollReveal delay={140}>
            <p className="text-lg text-tg-muted max-w-2xl mx-auto mt-4 leading-relaxed">
              שני המסלולים כוללים 5 ימי ניסיון חינם, בלי כרטיס אשראי. בחר את מה שמתאים לך — ואפשר לשדרג בכל רגע.
            </p>
          </ScrollReveal>
        </div>
        <ScrollReveal delay={140}>
          <MarketingPricing />
        </ScrollReveal>
      </div>
    </section>
  );
}

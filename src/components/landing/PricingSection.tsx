import { ScrollReveal } from './ScrollReveal';
import { MarketingPricing } from './MarketingPricing';

export function PricingSection() {
  return (
    <section id="pricing" className="relative py-20 px-4 md:px-6">
      <div className="max-w-[1100px] mx-auto">
        <ScrollReveal>
          <h2 className="text-2xl md:text-4xl font-bold text-white text-center mb-3">
            בחר את רמת המחויבות שלך
          </h2>
        </ScrollReveal>
        <ScrollReveal delay={60}>
          <p className="text-base text-tg-muted text-center max-w-xl mx-auto mb-12 leading-relaxed">
            שני המסלולים כוללים 5 ימי ניסיון חינם. ההבדל האמיתי אחד: Basic מזהיר אותך. Pro עוצר
            אותך.
          </p>
        </ScrollReveal>
        <ScrollReveal delay={120}>
          <MarketingPricing />
        </ScrollReveal>
      </div>
    </section>
  );
}

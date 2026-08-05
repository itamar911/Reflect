import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';
import { MarketingPricing } from './MarketingPricing';

/**
 * The heading is the shared SectionHeading, like every other section on the
 * page. It used to be a bespoke `.pricing-title` — a gradient with its own
 * shine keyframes, flanked by two gradient rules — which made pricing the one
 * section whose heading did not match the rest of the page, for no reason
 * anyone reading the page would be able to name.
 */
export function PricingSection() {
  return (
    <section id="pricing" className="cv-auto relative py-16 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        {/* "בלי כרטיס אשראי" moved to sit under each CTA, where the hesitation
            actually happens; repeating it here as well would have put the same
            four words on screen three times. */}
        <SectionHeading sub="שני המסלולים מתחילים ב-5 ימי ניסיון חינם. בחר את מה שמתאים לך — ואפשר לשדרג בכל רגע.">
          המסלולים שלנו
        </SectionHeading>
        <ScrollReveal delay={140}>
          <MarketingPricing />
        </ScrollReveal>
      </div>
    </section>
  );
}

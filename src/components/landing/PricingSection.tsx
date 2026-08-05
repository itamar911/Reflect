import { ScrollReveal } from './ScrollReveal';
import { MarketingPricing } from './MarketingPricing';

/**
 * The one section on the page that deliberately does NOT use the shared
 * SectionHeading.
 *
 * That was tried (5599be5) and reverted: consistency is the right default, but
 * pricing is the page's decision moment, and this heading is where the brand
 * turquoise is allowed to be at its brightest. The bespoke treatment is the
 * emphasis — a lit gradient wordmark between two tapered rules, rather than the
 * same 72px underline every other section carries.
 *
 * Its motion resolves to a *static lit state* under reduced motion rather than
 * to nothing: see the explicit rules beside `.pricing-title` in landing.css.
 * The blanket `.landing *` rule alone would have frozen the sweep on whichever
 * keyframe it happened to land on, which is the dim end of the gradient.
 */
export function PricingSection() {
  return (
    <section id="pricing" className="cv-auto relative py-24 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        <div className="flex flex-col items-center text-center mb-12">
          <ScrollReveal>
            <div className="pricing-title-wrap flex items-center justify-center gap-4 md:gap-6">
              <span className="pricing-title-line" aria-hidden />
              <h2 className="pricing-title">המסלולים שלנו</h2>
              <span className="pricing-title-line" aria-hidden />
            </div>
          </ScrollReveal>
          <ScrollReveal delay={140}>
            {/* Explicit rgba, not text-tg-muted — that token is #ffffff in this
                theme, so "muted" copy rendered at full brightness. */}
            <p
              className="text-lg max-w-2xl mx-auto mt-6 leading-relaxed"
              style={{ color: 'rgba(255,255,255,0.62)' }}
            >
              שני המסלולים מתחילים ב-5 ימי ניסיון חינם. בחר את מה שמתאים לך — ואפשר לשדרג בכל רגע.
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

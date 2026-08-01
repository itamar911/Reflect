import Link from 'next/link';
import { MonitorSmartphone, Languages, Users } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { HeroMock } from './HeroMock';
import { HeroJoinStat } from './HeroJoinStat';

const TRUST_ITEMS = [
  { icon: MonitorSmartphone, text: 'לא תלוי בברוקר' },
  { icon: Languages, text: 'עברית מלאה' },
  { icon: Users, text: 'נבנה על ידי סוחרים' },
];

/**
 * Hero padding is asymmetric by breakpoint because the two viewports have
 * opposite problems. Below lg the hero stacks and runs ~1630px tall, so the
 * primary CTA was falling at or below the fold on a phone — the 80px top pulls
 * it back up. At lg the hero is only ~818px against an 800-900px viewport, so
 * the next section's heading sat just under the fold with nothing but padding
 * showing above it; 112px top / 24px bottom lifts it into view. The bottom cut
 * is desktop-only: those 96px are dead space under the trust row (the CTA ends
 * ~200px above it), while on mobile the same 96px is the gap before the next
 * section and worth keeping.
 */
export function HeroSection() {
  return (
    <section className="relative pt-20 pb-24 lg:pt-28 lg:pb-6 px-4 md:px-8 lg:px-10 overflow-hidden">
      <div className="hero-grid" aria-hidden />
      <div className="hero-orb hero-orb-1" aria-hidden />
      <div className="hero-orb hero-orb-2" aria-hidden />

      <div className="relative max-w-[1360px] mx-auto">
        {/* Social proof — centered between the nav and the headline */}
        <ScrollReveal className="flex justify-center mb-10">
          <HeroJoinStat />
        </ScrollReveal>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-14 lg:gap-16 items-center">
          {/* text column — first in DOM = right column in RTL */}
          <div className="flex flex-col items-center lg:items-start text-center lg:text-start gap-7">
            <ScrollReveal>
              <h1 className="text-3xl md:text-5xl lg:text-[3.25rem] font-extrabold text-white leading-[1.2] md:leading-[1.18] max-w-4xl lg:max-w-none mx-auto lg:mx-0">
                אמרת &quot;זאת הפעם האחרונה שאני עושה את זה&quot; —{' '}
                <span className="text-gradient-cyan">ועשית את זה שוב למחרת.</span>
              </h1>
            </ScrollReveal>

            <ScrollReveal delay={120}>
              <p className="text-lg text-tg-muted max-w-2xl lg:max-w-xl mx-auto lg:mx-0 leading-relaxed">
                הבעיה שלך היא לא עוד ידע. הבעיה היא ששום דבר לא עוצר אותך ברגע שהכי צריך. Reflect הוא
                יומן המסחר היחיד שנכנס לרגע הזה — אתה מגדיר את החוקים שלך, והוא אומר לך בפרצוף כשאתה
                עומד להפר אותם.
              </p>
            </ScrollReveal>

            <ScrollReveal delay={240}>
              <div className="flex flex-col items-center lg:items-start gap-3 mt-2">
                <Link
                  href="/signup"
                  className="landing-cta px-9 py-4 rounded-xl text-base md:text-lg font-bold text-black"
                >
                  התחל 5 ימי ניסיון — בלי כרטיס אשראי
                </Link>
                <span className="text-sm text-tg-muted">פחות מ-2 דקות ואתה בפנים</span>
              </div>
            </ScrollReveal>

            <ScrollReveal delay={420} className="w-full">
              <div className="flex flex-wrap items-center justify-center lg:justify-start gap-x-7 gap-y-3 mt-4">
                {TRUST_ITEMS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <span key={item.text} className="flex items-center gap-2 text-sm text-tg-muted">
                      <Icon size={16} style={{ color: '#00d2d2' }} aria-hidden />
                      {item.text}
                    </span>
                  );
                })}
              </div>
            </ScrollReveal>
          </div>

          {/* mock column — second in DOM = left column in RTL */}
          <ScrollReveal delay={360} className="w-full flex justify-center">
            <HeroMock />
          </ScrollReveal>
        </div>
      </div>
    </section>
  );
}

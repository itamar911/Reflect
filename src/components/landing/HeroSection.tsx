import Link from 'next/link';
import { MonitorSmartphone, Languages, Users } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { ImagePlaceholder } from './ImagePlaceholder';
import { landingImages } from './landingImages';

const TRUST_ITEMS = [
  { icon: MonitorSmartphone, text: 'עובד לצד כל פלטפורמת מסחר' },
  { icon: Languages, text: 'עברית מלאה' },
  { icon: Users, text: 'נבנה על ידי סוחרים' },
];

export function HeroSection() {
  return (
    <section className="relative pt-36 pb-24 px-4 md:px-6 overflow-hidden">
      <div className="hero-grid" aria-hidden />
      <div className="hero-orb hero-orb-1" aria-hidden />
      <div className="hero-orb hero-orb-2" aria-hidden />

      <div className="relative max-w-[1100px] mx-auto flex flex-col items-center text-center gap-7">
        <ScrollReveal>
          <h1 className="text-3xl md:text-5xl font-extrabold text-white leading-[1.2] md:leading-[1.18] max-w-4xl mx-auto">
            כמה פעמים אמרת &quot;זאת הפעם האחרונה שאני עושה את זה&quot; —{' '}
            <span className="text-gradient-cyan">ועשית את זה שוב למחרת?</span>
          </h1>
        </ScrollReveal>

        <ScrollReveal delay={120}>
          <p className="text-lg text-tg-muted max-w-2xl mx-auto leading-relaxed">
            הבעיה שלך היא לא עוד ידע. הבעיה היא ששום דבר לא עוצר אותך ברגע שהכי צריך. Reflect הוא
            יומן המסחר היחיד שנכנס לרגע הזה — אתה מגדיר את החוקים שלך, והוא אומר לך בפרצוף כשאתה
            עומד להפר אותם. לפני הכניסה, לא אחרי ההפסד.
          </p>
        </ScrollReveal>

        <ScrollReveal delay={240}>
          <div className="flex flex-col items-center gap-3 mt-2">
            <Link
              href="/signup"
              className="landing-cta px-9 py-4 rounded-xl text-base md:text-lg font-bold text-black"
            >
              התחל 5 ימי ניסיון — בלי כרטיס אשראי
            </Link>
            <span className="text-sm text-tg-muted">פחות מ-2 דקות ואתה בפנים</span>
          </div>
        </ScrollReveal>

        <ScrollReveal delay={360} className="w-full mt-10">
          <div className="relative max-w-4xl mx-auto">
            <div
              className="absolute -inset-6 rounded-3xl pointer-events-none"
              style={{ background: 'radial-gradient(60% 60% at 50% 50%, rgba(0,210,210,0.1), transparent 75%)' }}
              aria-hidden
            />
            <ImagePlaceholder
              id={landingImages.heroScreenshot.id}
              label={landingImages.heroScreenshot.label}
              aspect="aspect-video"
              className="relative shadow-2xl"
            />
          </div>
        </ScrollReveal>

        <ScrollReveal delay={420}>
          <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3 mt-8">
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
    </section>
  );
}

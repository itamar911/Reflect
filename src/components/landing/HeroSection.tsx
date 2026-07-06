import Link from 'next/link';
import { ScrollReveal } from './ScrollReveal';
import { ImagePlaceholder } from './ImagePlaceholder';
import { landingImages } from './landingImages';

export function HeroSection() {
  return (
    <section className="relative pt-36 pb-20 px-4 md:px-6">
      <div className="max-w-[1100px] mx-auto flex flex-col items-center text-center gap-6">
        <ScrollReveal>
          <h1 className="text-3xl md:text-5xl font-bold text-white leading-tight max-w-3xl mx-auto">
            כמה פעמים אמרת &quot;זאת הפעם האחרונה שאני עושה את זה&quot; — ועשית את זה שוב למחרת?
          </h1>
        </ScrollReveal>

        <ScrollReveal delay={100}>
          <p className="text-lg text-tg-muted max-w-2xl mx-auto leading-relaxed">
            הבעיה שלך היא לא עוד ידע. הבעיה היא ששום דבר לא עוצר אותך ברגע שהכי צריך. Reflect הוא
            יומן המסחר היחיד שנכנס לרגע הזה — אתה מגדיר את החוקים שלך, והוא אומר לך בפרצוף כשאתה
            עומד להפר אותם. לפני הכניסה, לא אחרי ההפסד.
          </p>
        </ScrollReveal>

        <ScrollReveal delay={200}>
          <div className="flex flex-col items-center gap-3 mt-2">
            <Link
              href="/signup"
              className="shimmer-btn px-8 py-3.5 rounded-xl text-base font-bold text-black transition-transform duration-150 active:scale-95"
            >
              התחל 5 ימי ניסיון — בלי כרטיס אשראי
            </Link>
            <span className="text-sm text-tg-muted">פחות מ-2 דקות ואתה בפנים</span>
          </div>
        </ScrollReveal>

        <ScrollReveal delay={300} className="w-full mt-10">
          <ImagePlaceholder
            id={landingImages.heroScreenshot.id}
            label={landingImages.heroScreenshot.label}
            aspect="aspect-video"
            className="max-w-4xl mx-auto shadow-2xl"
          />
        </ScrollReveal>

        <ScrollReveal delay={350}>
          <p className="text-sm text-tg-muted mt-8">
            עובד לצד כל פלטפורמת מסחר · עברית מלאה · נבנה על ידי סוחרים
          </p>
        </ScrollReveal>
      </div>
    </section>
  );
}

import Link from 'next/link';
import { ScrollReveal } from './ScrollReveal';

export function FinalCtaSection() {
  return (
    <section className="relative py-24 px-4 md:px-6">
      <div className="max-w-[800px] mx-auto flex flex-col items-center text-center gap-6">
        <ScrollReveal>
          <h2 className="text-2xl md:text-4xl font-bold text-white leading-tight">
            השוק בוחן את האסטרטגיה שלך. רפלקט בוחן אותך.
          </h2>
        </ScrollReveal>

        <ScrollReveal delay={100}>
          <p className="text-base text-tg-muted leading-relaxed max-w-xl mx-auto">
            עוד חודש מעכשיו תהיה באחד משני מקומות: בתוך הלופ — או בפעם הראשונה מחוץ לו. ההבדל הוא
            לא עוד קורס. הוא ההחלטה שאף עסקה לא נכנסת יותר בלי לעבור דרכך קודם.
          </p>
        </ScrollReveal>

        <ScrollReveal delay={200}>
          <Link
            href="/signup"
            className="shimmer-btn px-9 py-4 rounded-xl text-lg font-bold text-black transition-transform duration-150 active:scale-95 mt-2"
          >
            התחל 5 ימי ניסיון עכשיו — בלי כרטיס אשראי
          </Link>
        </ScrollReveal>
      </div>
    </section>
  );
}

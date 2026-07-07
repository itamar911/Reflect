import Link from 'next/link';
import { ScrollReveal } from './ScrollReveal';

export function FinalCtaSection() {
  return (
    <section className="relative py-32 px-4 md:px-6 overflow-hidden">
      <div className="final-cta-band absolute inset-0" aria-hidden />
      <div
        className="absolute inset-x-0 top-0 h-px"
        style={{ background: 'linear-gradient(90deg, transparent, rgba(0,210,210,0.35), transparent)' }}
        aria-hidden
      />
      <div
        className="absolute inset-x-0 bottom-0 h-px"
        style={{ background: 'linear-gradient(90deg, transparent, rgba(0,210,210,0.35), transparent)' }}
        aria-hidden
      />

      <div className="relative max-w-[800px] mx-auto flex flex-col items-center text-center gap-7">
        <ScrollReveal>
          <h2 className="text-3xl md:text-4xl font-extrabold text-white leading-tight">
            השוק בוחן את האסטרטגיה שלך. רפלקט בוחן אותך.
          </h2>
        </ScrollReveal>

        <ScrollReveal delay={100}>
          <span className="section-underline" aria-hidden />
        </ScrollReveal>

        <ScrollReveal delay={160}>
          <p className="text-base text-tg-muted leading-relaxed max-w-xl mx-auto">
            עוד חודש מעכשיו תהיה באחד משני מקומות: בתוך הלופ — או בפעם הראשונה מחוץ לו. ההבדל הוא
            לא עוד קורס. הוא ההחלטה שאף עסקה לא נכנסת יותר בלי לעבור דרכך קודם.
          </p>
        </ScrollReveal>

        <ScrollReveal delay={260}>
          <Link
            href="/signup"
            className="landing-cta px-10 py-4.5 rounded-xl text-lg font-bold text-black mt-2 inline-block"
          >
            התחל 5 ימי ניסיון עכשיו — בלי כרטיס אשראי
          </Link>
        </ScrollReveal>
      </div>
    </section>
  );
}

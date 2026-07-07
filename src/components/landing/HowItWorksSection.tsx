'use client';

import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, ShieldAlert, GraduationCap, Check, AlertTriangle, type LucideIcon } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';

const STEPS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: SlidersHorizontal,
    title: 'אתה קובע את החוקים.',
    body: 'פעם אחת. מקסימום עסקאות ביום, הפסד יומי מקסימלי, מצב רגשי מינימלי, האסטרטגיות שמותר לך לסחור — החוקים שלך, לא שלנו.',
  },
  {
    icon: ShieldAlert,
    title: 'Reflect עומד בשער.',
    body: 'לפני כל עסקה אתה עובר דרך תכנון קצר, והמערכת בודקת אותך מול החוקים בזמן אמת. עומד בהם? ירוק, קדימה. מפר אותם? אתה תדע — לפני שלחצת, לא אחרי.',
  },
  {
    icon: GraduationCap,
    title: 'כל עסקה הופכת לשיעור.',
    body: 'תחקיר AI, ציון משמעת, וזיהוי הדפוסים שהורסים לך את החודש. אתה רואה שחור על גבי לבן מה קורה כשאתה נאמן לתוכנית — ומה קורה כשלא.',
  },
];

/** Pure HTML/CSS mock of the trade-form check moment — two passes, one rule warning. */
function TradeCheckMock() {
  return (
    <div
      className="mt-3 rounded-xl border p-3.5 flex flex-col gap-2.5"
      style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.28)' }}
      aria-hidden
    >
      <div className="flex items-center gap-2">
        <Check size={15} className="shrink-0" style={{ color: '#22c55e' }} />
        <span className="text-white/80" style={{ fontSize: 13 }}>סטופ מוגדר · יחס 1:2.5</span>
      </div>
      <div className="flex items-center gap-2">
        <Check size={15} className="shrink-0" style={{ color: '#22c55e' }} />
        <span className="text-white/80" style={{ fontSize: 13 }}>מתאים לאסטרטגיה שלך</span>
      </div>
      <div
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 -mx-1"
        style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)' }}
      >
        <AlertTriangle size={15} className="shrink-0" style={{ color: '#f59e0b' }} />
        <span style={{ fontSize: 13, color: '#f59e0b' }}>עסקה שלישית היום — חוק שלך מופר</span>
      </div>
    </div>
  );
}

export function HowItWorksSection() {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="relative py-24 px-4 md:px-6">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1100px] mx-auto relative">
        <SectionHeading>ככה נראה מסחר עם Reflect:</SectionHeading>

        <div ref={ref} className={inView ? 'hiw-in' : ''}>
          <div className="relative">
            {/* self-drawing progress line, right → left, behind the badges */}
            <svg
              className="hiw-line hidden md:block absolute top-7 right-[16.66%] left-[16.66%] w-[66.68%]"
              height="4"
              viewBox="0 0 100 4"
              preserveAspectRatio="none"
              aria-hidden
            >
              <defs>
                <linearGradient id="hiw-grad" x1="1" y1="0" x2="0" y2="0">
                  <stop offset="0%" stopColor="#00d2d2" />
                  <stop offset="100%" stopColor="#0891b2" />
                </linearGradient>
              </defs>
              <path d="M 100 2 H 0" pathLength={1} stroke="url(#hiw-grad)" strokeWidth={2.5} fill="none" />
            </svg>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-8">
              {STEPS.map((step, i) => {
                const Icon = step.icon;
                return (
                  <ScrollReveal key={step.title} delay={i * 180}>
                    <div className="flex flex-col items-center gap-5 h-full">
                      <div className="step-badge relative z-10 w-14 h-14 rounded-full flex items-center justify-center text-xl font-extrabold text-black shrink-0">
                        {i + 1}
                      </div>
                      <div className="glass-card tilt-hover rounded-2xl p-6 flex flex-col gap-3 flex-1 w-full">
                        <div
                          className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                          style={{ background: 'rgba(0,210,210,0.12)' }}
                        >
                          <Icon size={22} style={{ color: '#00d2d2' }} />
                        </div>
                        <h3 className="text-lg font-bold text-white">{step.title}</h3>
                        <p className="text-sm text-tg-muted leading-relaxed">{step.body}</p>
                        {i === 1 && <TradeCheckMock />}
                      </div>
                    </div>
                  </ScrollReveal>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

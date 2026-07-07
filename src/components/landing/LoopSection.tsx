'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';

type Tone = 'cool' | 'amber' | 'red';

const LOOP_STEPS: { text: string; tone: Tone }[] = [
  { text: 'בוקר. אתה יושב מול המסך עם תוכנית ברורה.', tone: 'cool' },
  { text: 'עסקה ראשונה לפי הספר. יפה.', tone: 'cool' },
  { text: 'ואז הפסד קטן.', tone: 'amber' },
  { text: '"אני חייב להחזיר אותו."', tone: 'red' },
  { text: 'עסקה שנייה, חצי לפי התוכנית.', tone: 'amber' },
  { text: 'שלישית, בלי תוכנית בכלל.', tone: 'red' },
  { text: 'סוף היום: מחקת שבוע של עבודה בשעה.', tone: 'red' },
  { text: 'ערב: "מחר אני נהיה ממושמע."', tone: 'cool' },
  { text: 'מחר: אותו דבר בדיוק.', tone: 'red' },
];

const TONE_STYLES: Record<Tone, { border: string; dot: string; glow: string }> = {
  cool:  { border: 'rgba(125,143,179,0.5)', dot: '#7d8fb3', glow: 'rgba(125,143,179,0.18)' },
  amber: { border: 'rgba(245,158,11,0.5)',  dot: '#f59e0b', glow: 'rgba(245,158,11,0.18)' },
  red:   { border: 'rgba(239,68,68,0.55)',  dot: '#ef4444', glow: 'rgba(239,68,68,0.18)' },
};

// 1 = card/curve leans toward the start side (right in RTL), -1 = end side (left in RTL)
const SIDE_PATTERN = [1, -1, 1, -1, 1, -1, 1, -1, 1];

const VB_W = 1000;
const STEP_H = 190;
const VB_H = STEP_H * (LOOP_STEPS.length - 1) + 80;
const SWING = 230;

function buildLoopPath() {
  let d = `M ${VB_W / 2} 40`;
  for (let i = 0; i < LOOP_STEPS.length - 1; i++) {
    const y1 = 40 + (i + 1) * STEP_H;
    const midY = 40 + i * STEP_H + STEP_H / 2;
    const swing = SIDE_PATTERN[i] * SWING;
    d += ` C ${VB_W / 2 + swing} ${midY}, ${VB_W / 2 + swing} ${midY}, ${VB_W / 2} ${y1}`;
  }
  return d;
}

const LOOP_PATH = buildLoopPath();

export function LoopSection() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
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
      { threshold: 0.15 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="section-alt relative py-20 px-4 md:px-8 lg:px-10 overflow-hidden">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        <SectionHeading>אתה מכיר את הלופ הזה בעל פה.</SectionHeading>

        <div ref={wrapRef} className={inView ? 'loop-in' : ''}>
          {/* ── Desktop: full-width winding descent curve ── */}
          <div className="hidden lg:block relative pe-16">
            <svg
              className="absolute inset-0 w-full h-full"
              viewBox={`0 0 ${VB_W} ${VB_H}`}
              preserveAspectRatio="none"
              aria-hidden
            >
              <defs>
                <linearGradient id="loop-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#7d8fb3" />
                  <stop offset="50%" stopColor="#f59e0b" />
                  <stop offset="100%" stopColor="#ef4444" />
                </linearGradient>
                <filter id="loop-glow-filter" x="-60%" y="-10%" width="220%" height="120%">
                  <feGaussianBlur stdDeviation="10" />
                </filter>
              </defs>
              <path
                d={LOOP_PATH}
                fill="none"
                stroke="url(#loop-grad)"
                strokeWidth={10}
                opacity={0.3}
                filter="url(#loop-glow-filter)"
              />
              <path
                className="loop-path"
                d={LOOP_PATH}
                pathLength={1}
                fill="none"
                stroke="url(#loop-grad)"
                strokeWidth={2.5}
                strokeLinecap="round"
              />
            </svg>

            <ol className="relative flex flex-col gap-4">
              {LOOP_STEPS.map((step, i) => {
                const tone = TONE_STYLES[step.tone];
                const onStart = SIDE_PATTERN[i] === 1;
                const rotate = i % 2 === 0 ? '-1.1deg' : '1.1deg';
                return (
                  <ScrollReveal key={step.text} delay={i * 70}>
                    <li className={`relative flex ${onStart ? 'justify-start' : 'justify-end'}`} style={{ minHeight: 76 }}>
                      <span
                        className="loop-node-dot absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full z-10"
                        style={{ background: tone.dot, boxShadow: `0 0 12px ${tone.dot}` }}
                        aria-hidden
                      />
                      <div
                        className="loop-glass-card w-full max-w-[440px] rounded-2xl px-5 py-4"
                        style={{
                          borderColor: tone.border,
                          boxShadow: `inset 0 0 24px ${tone.glow}, 0 10px 28px rgba(0,0,0,0.35)`,
                          transform: `rotate(${rotate})`,
                        }}
                      >
                        <p className="text-white/95" style={{ fontSize: 15.5, lineHeight: 1.55 }}>
                          {step.text}
                        </p>
                      </div>
                    </li>
                  </ScrollReveal>
                );
              })}
            </ol>

            {/* bold dashed loop-back arrow: first and last steps both sit on the start side */}
            <svg className="absolute inset-y-0 end-0 w-16 h-full" viewBox="0 0 64 800" preserveAspectRatio="none" aria-hidden>
              <path
                d="M 24 30 C 56 160, 56 640, 24 770"
                fill="none"
                stroke="#ef4444"
                strokeWidth={3}
                strokeDasharray="6 8"
                strokeLinecap="round"
                opacity={0.85}
              />
              <path
                d="M 24 30 l -8 -4 M 24 30 l -2 9"
                fill="none"
                stroke="#ef4444"
                strokeWidth={3}
                strokeLinecap="round"
                opacity={0.85}
              />
            </svg>
            <span
              className="absolute text-xs font-bold whitespace-nowrap"
              style={{ color: '#ef4444', insetInlineEnd: 0, top: '44%', writingMode: 'vertical-rl' }}
            >
              והלופ מתחיל מחדש
            </span>
          </div>

          {/* ── Mobile / tablet: glass-card rail on the start side ── */}
          <div className="lg:hidden relative">
            <div
              className="absolute inset-y-1 start-1 w-[3px] rounded-full"
              style={{ background: 'linear-gradient(180deg, #7d8fb3 0%, #f59e0b 50%, #ef4444 100%)' }}
              aria-hidden
            />
            <ol className="flex flex-col gap-4 ps-7">
              {LOOP_STEPS.map((step, i) => {
                const tone = TONE_STYLES[step.tone];
                return (
                  <ScrollReveal key={step.text} delay={i * 60}>
                    <li className="relative">
                      <span
                        className="loop-node-dot-rail absolute top-5 start-[-26px] w-3.5 h-3.5 rounded-full z-10"
                        style={{ background: tone.dot, boxShadow: `0 0 12px ${tone.dot}` }}
                        aria-hidden
                      />
                      <div
                        className="loop-glass-card rounded-2xl px-4 py-3.5"
                        style={{ borderColor: tone.border, boxShadow: `inset 0 0 20px ${tone.glow}` }}
                      >
                        <p className="text-white/95" style={{ fontSize: 14.5, lineHeight: 1.5 }}>
                          {step.text}
                        </p>
                      </div>
                    </li>
                  </ScrollReveal>
                );
              })}
            </ol>
            <div className="flex items-center gap-1.5 mt-3 ps-7 text-xs font-bold" style={{ color: '#ef4444' }}>
              <RefreshCw size={13} />
              <span>והלופ מתחיל מחדש</span>
            </div>
          </div>
        </div>

        <ScrollReveal delay={160}>
          <div className="callout-strip max-w-2xl mx-auto mt-14 px-6 py-5">
            <p className="text-lg md:text-xl font-bold text-white text-center leading-relaxed">
              עוד קורס, עוד אינדיקטור, עוד מנטור — וחזרת לאותו לופ. כי אף אחד מהם לא נמצא שם ברגע
              שאתה שובר את החוקים.
            </p>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

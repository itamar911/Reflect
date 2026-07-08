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

/** Horizontal pill badge marking the loop restarting — replaces the old rotated side label. */
function LoopRestartPill({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold whitespace-nowrap ${className}`}
      style={{
        color: '#f87171',
        background: 'rgba(239,68,68,0.12)',
        border: '1px solid rgba(239,68,68,0.45)',
        boxShadow: '0 0 14px rgba(239,68,68,0.15)',
      }}
    >
      <RefreshCw size={14} aria-hidden />
      והלופ מתחיל מחדש
    </span>
  );
}

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
    <section className="section-alt relative py-14 px-4 md:px-8 lg:px-10 overflow-hidden">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        <SectionHeading compact>אתה מכיר את הלופ הזה בעל פה.</SectionHeading>

        <div ref={wrapRef} className={inView ? 'loop-in' : ''}>
          {/* ── Desktop: full-width winding descent curve ── */}
          <div className="hidden lg:block relative">
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

            <ol className="relative flex flex-col gap-2.5">
              {LOOP_STEPS.map((step, i) => {
                const tone = TONE_STYLES[step.tone];
                const onStart = SIDE_PATTERN[i] === 1;
                const rotate = i % 2 === 0 ? '-1.1deg' : '1.1deg';
                const isLast = i === LOOP_STEPS.length - 1;
                return (
                  <ScrollReveal key={step.text} delay={i * 70}>
                    <li className={`relative flex ${onStart ? 'justify-start' : 'justify-end'}`} style={{ minHeight: 60 }}>
                      <span
                        className="loop-node-dot absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full z-10"
                        style={{ background: tone.dot, boxShadow: `0 0 12px ${tone.dot}` }}
                        aria-hidden
                      />
                      <div
                        className="loop-glass-card w-full max-w-[460px] rounded-2xl px-5 py-3"
                        style={{
                          borderColor: tone.border,
                          boxShadow: `inset 0 0 24px ${tone.glow}, 0 10px 28px rgba(0,0,0,0.35)`,
                          transform: `rotate(${rotate})`,
                        }}
                      >
                        <p className="text-white/95" style={{ fontSize: 16, lineHeight: 1.55 }}>
                          {step.text}
                        </p>
                        {isLast && <LoopRestartPill className="mt-2" />}
                      </div>
                    </li>
                  </ScrollReveal>
                );
              })}
            </ol>
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
                        <p className="text-white/95" style={{ fontSize: 15, lineHeight: 1.55 }}>
                          {step.text}
                        </p>
                      </div>
                    </li>
                  </ScrollReveal>
                );
              })}
            </ol>
            <div className="mt-4 ps-7">
              <LoopRestartPill />
            </div>
          </div>
        </div>

        <ScrollReveal delay={160}>
          <div className="callout-strip max-w-2xl mx-auto mt-10 px-6 py-5">
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

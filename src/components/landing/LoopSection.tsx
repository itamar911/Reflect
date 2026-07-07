'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';

type Tone = 'neutral' | 'good' | 'amber' | 'red' | 'hope';

const LOOP_STEPS: { text: string; tone: Tone }[] = [
  { text: 'בוקר. אתה יושב מול המסך עם תוכנית ברורה.', tone: 'neutral' },
  { text: 'עסקה ראשונה לפי הספר. יפה.', tone: 'good' },
  { text: 'ואז הפסד קטן.', tone: 'amber' },
  { text: '"אני חייב להחזיר אותו."', tone: 'red' },
  { text: 'עסקה שנייה, חצי לפי התוכנית.', tone: 'amber' },
  { text: 'שלישית, בלי תוכנית בכלל.', tone: 'red' },
  { text: 'סוף היום: מחקת שבוע של עבודה בשעה.', tone: 'red' },
  { text: 'ערב: "מחר אני נהיה ממושמע."', tone: 'hope' },
  { text: 'מחר: אותו דבר בדיוק.', tone: 'red' },
];

const TONE_STYLES: Record<Tone, { border: string; dot: string; bg: string }> = {
  neutral: { border: 'rgba(148,163,184,0.35)', dot: '#94a3b8', bg: 'rgba(148,163,184,0.06)' },
  good:    { border: 'rgba(0,210,210,0.45)',   dot: '#00d2d2', bg: 'rgba(0,210,210,0.07)' },
  amber:   { border: 'rgba(245,158,11,0.45)',  dot: '#f59e0b', bg: 'rgba(245,158,11,0.07)' },
  red:     { border: 'rgba(239,68,68,0.5)',    dot: '#ef4444', bg: 'rgba(239,68,68,0.07)' },
  hope:    { border: 'rgba(125,143,179,0.5)',  dot: '#7d8fb3', bg: 'rgba(125,143,179,0.09)' },
};

const SIZE = 720;
const CENTER = SIZE / 2;
const RADIUS = 232;

function pointAt(deg: number, radius = RADIUS) {
  const rad = (deg * Math.PI) / 180;
  return { x: CENTER + radius * Math.cos(rad), y: CENTER + radius * Math.sin(rad) };
}

/** Angle of step i, clockwise from 12 o'clock. */
function stepAngle(i: number) {
  return -90 + i * 40;
}

export function LoopSection() {
  const diagramRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = diagramRef.current;
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
      { threshold: 0.25 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const arcStart = pointAt(stepAngle(LOOP_STEPS.length - 1) + 6);
  const arcEnd = pointAt(-90 - 7);
  const arcArrow = pointAt(-90 - 7);

  return (
    <section className="relative py-24 px-4 md:px-6 overflow-hidden">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1100px] mx-auto relative">
        <SectionHeading>אתה מכיר את הלופ הזה בעל פה.</SectionHeading>

        <div ref={diagramRef} className={inView ? 'loop-in' : ''}>
          {/* ── Desktop: circular loop ── */}
          <div className="hidden lg:block relative mx-auto" style={{ width: SIZE, height: SIZE }}>
            <svg
              width={SIZE}
              height={SIZE}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              className="absolute inset-0"
              aria-hidden
            >
              <defs>
                <linearGradient id="loop-ring" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="rgba(0,210,210,0.35)" />
                  <stop offset="55%" stopColor="rgba(148,163,184,0.18)" />
                  <stop offset="100%" stopColor="rgba(239,68,68,0.3)" />
                </linearGradient>
              </defs>

              {/* ring */}
              <circle
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                fill="none"
                stroke="url(#loop-ring)"
                strokeWidth={1.5}
              />

              {/* direction chevrons between steps (skip the last→first gap) */}
              {LOOP_STEPS.slice(0, -1).map((_, i) => {
                const mid = stepAngle(i) + 20;
                const p = pointAt(mid);
                return (
                  <g key={mid} transform={`translate(${p.x}, ${p.y}) rotate(${mid + 90})`}>
                    <path
                      d="M -4.5 -4 L 4 0 L -4.5 4"
                      fill="none"
                      stroke="rgba(255,255,255,0.35)"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </g>
                );
              })}

              {/* emphasized back-arc: the trap closes, last step loops to the first */}
              <g className="loop-arc-back">
                <path
                  d={`M ${arcStart.x} ${arcStart.y} A ${RADIUS} ${RADIUS} 0 0 1 ${arcEnd.x} ${arcEnd.y}`}
                  fill="none"
                  stroke="#ef4444"
                  strokeWidth={2.5}
                  strokeDasharray="5 7"
                  strokeLinecap="round"
                />
                <g transform={`translate(${arcArrow.x}, ${arcArrow.y}) rotate(${-90 - 7 + 90})`}>
                  <path
                    d="M -7 -6 L 6 0 L -7 6"
                    fill="none"
                    stroke="#ef4444"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              </g>
            </svg>

            {/* pulsing red-to-amber core */}
            <div
              className="loop-core absolute rounded-full flex items-center justify-center"
              style={{
                width: 168,
                height: 168,
                left: CENTER - 84,
                top: CENTER - 84,
                background:
                  'radial-gradient(circle at 35% 30%, rgba(239,68,68,0.16), rgba(245,158,11,0.08) 65%, transparent)',
                border: '1px solid rgba(239,68,68,0.25)',
              }}
              aria-hidden
            >
              <RefreshCw size={44} className="loop-core-icon" style={{ color: 'rgba(245,158,11,0.75)' }} />
            </div>

            {/* step nodes around the ring */}
            <ol className="contents">
              {LOOP_STEPS.map((step, i) => {
                const p = pointAt(stepAngle(i));
                const tone = TONE_STYLES[step.tone];
                return (
                  <li
                    key={step.text}
                    className="loop-node absolute rounded-xl px-3.5 py-2.5 text-center backdrop-blur-sm"
                    style={{
                      width: 176,
                      left: p.x,
                      top: p.y,
                      translate: '-50% -50%',
                      background: tone.bg,
                      border: `1px solid ${tone.border}`,
                      transitionDelay: inView ? `${i * 160}ms` : '0ms',
                    }}
                  >
                    <span
                      className="absolute -top-1.5 right-1/2 translate-x-1/2 w-3 h-3 rounded-full"
                      style={{ background: tone.dot, boxShadow: `0 0 10px ${tone.dot}` }}
                      aria-hidden
                    />
                    <p className="text-white/90 leading-snug" style={{ fontSize: 13.5, lineHeight: 1.45 }}>
                      {step.text}
                    </p>
                  </li>
                );
              })}
            </ol>
          </div>

          {/* ── Mobile / tablet: snaking vertical timeline ── */}
          <div className="lg:hidden relative max-w-md mx-auto">
            <div
              className="absolute inset-y-3 right-1/2 w-px translate-x-1/2"
              style={{
                background:
                  'linear-gradient(180deg, rgba(0,210,210,0.4), rgba(245,158,11,0.35), rgba(239,68,68,0.45))',
              }}
              aria-hidden
            />
            <ol className="flex flex-col gap-5">
              {LOOP_STEPS.map((step, i) => {
                const tone = TONE_STYLES[step.tone];
                const side = i % 2 === 0;
                return (
                  <ScrollReveal key={step.text} delay={60}>
                    <li className={`relative flex ${side ? 'justify-end' : 'justify-start'}`}>
                      <span
                        className="absolute top-1/2 right-1/2 translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full z-10"
                        style={{ background: tone.dot, boxShadow: `0 0 10px ${tone.dot}` }}
                        aria-hidden
                      />
                      <div
                        className="w-[calc(50%-18px)] rounded-xl px-3.5 py-3 backdrop-blur-sm"
                        style={{ background: tone.bg, border: `1px solid ${tone.border}` }}
                      >
                        <p className="text-white/90" style={{ fontSize: 13.5, lineHeight: 1.5 }}>
                          {step.text}
                        </p>
                      </div>
                    </li>
                  </ScrollReveal>
                );
              })}
            </ol>
          </div>
        </div>

        <ScrollReveal delay={200}>
          <p className="text-xl md:text-2xl font-bold text-white text-center max-w-2xl mx-auto mt-16 leading-relaxed">
            עוד קורס, עוד אינדיקטור, עוד מנטור — וחזרת לאותו לופ. כי אף אחד מהם לא נמצא שם ברגע
            שאתה שובר את החוקים.
          </p>
        </ScrollReveal>
      </div>
    </section>
  );
}

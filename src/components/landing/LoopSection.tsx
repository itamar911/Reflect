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

const TONE_STYLES: Record<Tone, { border: string; dot: string; bg: string }> = {
  cool:  { border: 'rgba(125,143,179,0.45)', dot: '#7d8fb3', bg: 'rgba(125,143,179,0.07)' },
  amber: { border: 'rgba(245,158,11,0.45)',  dot: '#f59e0b', bg: 'rgba(245,158,11,0.07)' },
  red:   { border: 'rgba(239,68,68,0.5)',    dot: '#ef4444', bg: 'rgba(239,68,68,0.07)' },
};

const LINE_GRADIENT = 'linear-gradient(180deg, #7d8fb3 0%, #f59e0b 50%, #ef4444 100%)';

export function LoopSection() {
  return (
    <section className="section-alt relative py-20 px-4 md:px-6 overflow-hidden">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[880px] mx-auto relative">
        <SectionHeading>אתה מכיר את הלופ הזה בעל פה.</SectionHeading>

        {/* ── Desktop: vertical descent timeline, cards alternating around a center line ── */}
        <div className="hidden lg:block relative pe-14">
          <div
            className="absolute inset-y-1 start-1/2 -translate-x-1/2 w-[2px] rounded-full"
            style={{ background: LINE_GRADIENT }}
            aria-hidden
          />

          <ol className="flex flex-col gap-3.5">
            {LOOP_STEPS.map((step, i) => {
              const tone = TONE_STYLES[step.tone];
              const onStart = i % 2 === 0;
              return (
                <ScrollReveal key={step.text} delay={i * 70}>
                  <li className={`relative flex ${onStart ? 'justify-start' : 'justify-end'}`}>
                    <span
                      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full z-10"
                      style={{ background: tone.dot, boxShadow: `0 0 10px ${tone.dot}` }}
                      aria-hidden
                    />
                    <div
                      className="w-[calc(50%-30px)] rounded-xl px-4 py-3 backdrop-blur-sm"
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

          {/* dashed loop-back arrow: both first and last step sit on the same (start) side */}
          <svg
            className="absolute inset-y-0 end-0 w-14 h-full"
            viewBox="0 0 56 720"
            preserveAspectRatio="none"
            aria-hidden
          >
            <path
              d="M 20 26 C 52 140, 52 580, 20 694"
              fill="none"
              stroke="#ef4444"
              strokeWidth={2}
              strokeDasharray="5 7"
              strokeLinecap="round"
              opacity={0.65}
            />
            <path
              d="M 20 26 l -7 -3 M 20 26 l -2 7.5"
              fill="none"
              stroke="#ef4444"
              strokeWidth={2}
              strokeLinecap="round"
              opacity={0.65}
            />
          </svg>
          <span
            className="absolute text-[10px] font-semibold whitespace-nowrap"
            style={{ color: 'rgba(239,68,68,0.75)', insetInlineEnd: 2, top: '46%', writingMode: 'vertical-rl' }}
          >
            וחוזר חלילה
          </span>
        </div>

        {/* ── Mobile / tablet: stacked timeline, line on the start side ── */}
        <div className="lg:hidden relative">
          <div
            className="absolute inset-y-1 start-1 w-[2px] rounded-full"
            style={{ background: LINE_GRADIENT }}
            aria-hidden
          />
          <ol className="flex flex-col gap-3.5 ps-7">
            {LOOP_STEPS.map((step, i) => {
              const tone = TONE_STYLES[step.tone];
              return (
                <ScrollReveal key={step.text} delay={i * 60}>
                  <li className="relative">
                    <span
                      className="absolute top-4 start-[-25px] w-3 h-3 rounded-full z-10"
                      style={{ background: tone.dot, boxShadow: `0 0 10px ${tone.dot}` }}
                      aria-hidden
                    />
                    <div
                      className="rounded-xl px-4 py-3 backdrop-blur-sm"
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
          <div className="flex items-center gap-1.5 mt-3 ps-7 text-xs font-semibold" style={{ color: 'rgba(239,68,68,0.75)' }}>
            <RefreshCw size={13} />
            <span>וחוזר לשלב הראשון…</span>
          </div>
        </div>

        <ScrollReveal delay={160}>
          <div className="callout-strip max-w-2xl mx-auto mt-12 px-6 py-5">
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

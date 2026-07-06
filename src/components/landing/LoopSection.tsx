import { ScrollReveal } from './ScrollReveal';

const LOOP_STEPS = [
  'בוקר. אתה יושב מול המסך עם תוכנית ברורה.',
  'עסקה ראשונה לפי הספר. יפה.',
  'ואז הפסד קטן.',
  '"אני חייב להחזיר אותו."',
  'עסקה שנייה, חצי לפי התוכנית.',
  'שלישית, בלי תוכנית בכלל.',
  'סוף היום: מחקת שבוע של עבודה בשעה.',
  'ערב: "מחר אני נהיה ממושמע."',
  'מחר: אותו דבר בדיוק.',
];

export function LoopSection() {
  return (
    <section className="relative py-20 px-4 md:px-6">
      <div className="max-w-[1100px] mx-auto">
        <ScrollReveal>
          <h2 className="text-2xl md:text-4xl font-bold text-white text-center mb-14">
            אתה מכיר את הלופ הזה בעל פה.
          </h2>
        </ScrollReveal>

        <div className="relative max-w-xl mx-auto">
          <div
            className="absolute top-2 bottom-2 right-[7px] w-px"
            style={{ background: 'var(--color-tg-border)' }}
            aria-hidden
          />
          <ol className="flex flex-col gap-6">
            {LOOP_STEPS.map((step, i) => (
              <ScrollReveal key={step} delay={i * 70}>
                <li className="relative flex items-start gap-4 pr-0">
                  <span
                    className="relative z-10 mt-1.5 shrink-0 w-3.5 h-3.5 rounded-full"
                    style={{ background: '#00d2d2', boxShadow: '0 0 10px rgba(0,210,210,0.5)' }}
                    aria-hidden
                  />
                  <p className="text-base text-tg-text-2 leading-relaxed">{step}</p>
                </li>
              </ScrollReveal>
            ))}
          </ol>
        </div>

        <ScrollReveal delay={LOOP_STEPS.length * 70 + 100}>
          <p className="text-xl md:text-2xl font-bold text-white text-center max-w-2xl mx-auto mt-16 leading-relaxed">
            עוד קורס, עוד אינדיקטור, עוד מנטור — וחזרת לאותו לופ. כי אף אחד מהם לא נמצא שם ברגע
            שאתה שובר את החוקים.
          </p>
        </ScrollReveal>
      </div>
    </section>
  );
}

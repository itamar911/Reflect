import { ScrollReveal } from './ScrollReveal';

const STEPS = [
  {
    title: 'אתה קובע את החוקים.',
    body: 'פעם אחת. מקסימום עסקאות ביום, הפסד יומי מקסימלי, מצב רגשי מינימלי, האסטרטגיות שמותר לך לסחור — החוקים שלך, לא שלנו.',
  },
  {
    title: 'Reflect עומד בשער.',
    body: 'לפני כל עסקה אתה עובר דרך תכנון קצר, והמערכת בודקת אותך מול החוקים בזמן אמת. עומד בהם? ירוק, קדימה. מפר אותם? אתה תדע — לפני שלחצת, לא אחרי.',
  },
  {
    title: 'כל עסקה הופכת לשיעור.',
    body: 'תחקיר AI, ציון משמעת, וזיהוי הדפוסים שהורסים לך את החודש. אתה רואה שחור על גבי לבן מה קורה כשאתה נאמן לתוכנית — ומה קורה כשלא.',
  },
];

export function HowItWorksSection() {
  return (
    <section className="relative py-20 px-4 md:px-6">
      <div className="max-w-[1100px] mx-auto">
        <ScrollReveal>
          <h2 className="text-2xl md:text-4xl font-bold text-white text-center mb-12">
            ככה נראה מסחר עם Reflect:
          </h2>
        </ScrollReveal>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {STEPS.map((step, i) => (
            <ScrollReveal key={step.title} delay={i * 120}>
              <div
                className="h-full rounded-2xl border border-tg-border p-6 flex flex-col gap-3"
                style={{ background: 'var(--color-tg-surface)' }}
              >
                <span
                  className="flex items-center justify-center w-9 h-9 rounded-full text-sm font-bold text-black"
                  style={{ background: '#00d2d2' }}
                >
                  {i + 1}
                </span>
                <h3 className="text-lg font-bold text-white mt-2">{step.title}</h3>
                <p className="text-sm text-tg-muted leading-relaxed">{step.body}</p>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}

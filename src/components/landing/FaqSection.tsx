'use client';

import { useState } from 'react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';

const FAQ_ITEMS = [
  {
    q: 'במה זה שונה מכל יומן מסחר אחר?',
    a: 'כל יומן אחר מסתכל אחורה — מנתח את מה שכבר קרה. Reflect הוא היחיד שנמצא איתך גם לפני העסקה, בודק אותה מול החוקים שלך, ועוצר אותך לפני ההפרה. מראה אחורית יש לכולם. בלמים יש רק כאן.',
  },
  {
    q: 'אני יכול פשוט לא להזין את העסקה ולעקוף הכל, לא?',
    a: 'נכון. וגם אפשר לשקר למאמן כושר על מה אכלת. Reflect לא כלא — הוא תהליך. סוחרים שמאמצים את הכלל האחד — "אף עסקה לא נכנסת בלי לעבור דרך Reflect" — מגלים שההרגל הזה לבדו משנה את המסחר שלהם. והנתונים שלך יראו לך שחור על גבי לבן מה קורה בעסקאות שתכננת מול אלה שלא.',
  },
  {
    q: 'אני לא צריך שמישהו יעצור אותי.',
    a: 'אם זה נכון — מעולה, אתה בקבוצה קטנה מאוד. אבל תשאל את עצמך בכנות: כמה מהעסקאות הגרועות שלך החודש היו כאלה שידעת מראש שאסור לפתוח? אם התשובה היא אפס — כנראה שאתה באמת לא צריך אותנו.',
  },
  {
    q: 'זה עובד עם הפלטפורמה שלי?',
    a: 'Reflect עובד לצד כל פלטפורמה — פיוצ׳רס, מניות, קריפטו, פורקס. התכנון והתחקיר קורים אצלנו; הביצוע נשאר איפה שאתה רגיל.',
  },
  {
    q: 'מה קורה אחרי 5 ימי הניסיון?',
    a: 'בוחרים מסלול וממשיכים — או לא, ולא חויבת בשקל. בלי כרטיס אשראי מראש, בלי אותיות קטנות.',
  },
  {
    q: 'יש עברית מלאה?',
    a: 'Reflect נבנה בעברית, מימין לשמאל, על ידי סוחרים ישראלים. לא תרגום — בית.',
  },
];

export function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section id="faq" className="section-alt cv-auto relative py-24 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1100px] mx-auto relative">
        <SectionHeading>שאלות נפוצות</SectionHeading>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {FAQ_ITEMS.map((item, i) => {
            const isOpen = openIndex === i;
            return (
              <ScrollReveal key={item.q} delay={i * 70}>
                <div
                  className="glass-card rounded-2xl overflow-hidden"
                  style={isOpen ? { borderColor: 'rgba(0,210,210,0.35)' } : undefined}
                >
                  <button
                    type="button"
                    onClick={() => setOpenIndex(isOpen ? null : i)}
                    className="w-full flex items-center justify-between gap-4 p-5 text-start"
                    aria-expanded={isOpen}
                  >
                    <span className="font-bold text-white" style={{ fontSize: 17 }}>{item.q}</span>
                    <span className={`faq-toggle ${isOpen ? 'open' : ''}`} aria-hidden />
                  </button>
                  <div
                    className="grid transition-all duration-[400ms]"
                    style={{
                      gridTemplateRows: isOpen ? '1fr' : '0fr',
                      transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
                    }}
                  >
                    <div className="overflow-hidden">
                      <p
                        className="text-base text-tg-muted leading-relaxed px-5 pb-5 transition-opacity duration-300"
                        style={{ opacity: isOpen ? 1 : 0 }}
                      >
                        {item.a}
                      </p>
                    </div>
                  </div>
                </div>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

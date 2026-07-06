'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';

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
    <section id="faq" className="relative py-20 px-4 md:px-6">
      <div className="max-w-[800px] mx-auto">
        <ScrollReveal>
          <h2 className="text-2xl md:text-4xl font-bold text-white text-center mb-12">שאלות נפוצות</h2>
        </ScrollReveal>

        <div className="flex flex-col gap-3">
          {FAQ_ITEMS.map((item, i) => {
            const isOpen = openIndex === i;
            return (
              <ScrollReveal key={item.q} delay={i * 60}>
                <div
                  className="rounded-2xl border border-tg-border overflow-hidden"
                  style={{ background: 'var(--color-tg-surface)' }}
                >
                  <button
                    type="button"
                    onClick={() => setOpenIndex(isOpen ? null : i)}
                    className="w-full flex items-center justify-between gap-4 p-5 text-start"
                    aria-expanded={isOpen}
                  >
                    <span className="text-base font-bold text-white">{item.q}</span>
                    <ChevronDown
                      size={20}
                      className="shrink-0 transition-transform duration-300"
                      style={{ color: '#00d2d2', transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
                    />
                  </button>
                  <div
                    className="grid transition-all duration-300 ease-out"
                    style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}
                  >
                    <div className="overflow-hidden">
                      <p className="text-sm text-tg-muted leading-relaxed px-5 pb-5">{item.a}</p>
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

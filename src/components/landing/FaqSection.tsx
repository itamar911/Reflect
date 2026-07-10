'use client';

import { useState } from 'react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';

const FAQ_ITEMS = [
  {
    q: 'למי Reflect מתאימה?',
    a: 'לכל סוחר שמרגיש שהוא חוזר על אותן טעויות — ורוצה סוף סוף לשבור את המעגל. יומיים, סווינגרים, מתחילים ומנוסים: ההבדל בין סוחר שמתקדם לסוחר שדורך במקום הוא לא עוד אסטרטגיה, אלא היכולת ללמוד מהעסקאות של עצמו. Reflect הופכת כל עסקה לשיעור — מזהה את הדפוסים שחוזרים על עצמם, שומרת עליכם ממושמעים, ונותנת לכם מאמן AI אישי שמכיר את המסחר שלכם לעומק. אם אתם רציניים לגבי ההתקדמות שלכם — Reflect נבנתה בשבילכם.',
  },
  {
    q: 'אם אפשר פשוט לא להזין עסקה — מה זה שווה?',
    a: 'נכון, אפשר. כמו שאפשר לשלם לחדר כושר ולא להגיע. אבל שים לב מה קרה עכשיו: כדי לעקוף את המערכת, אתה צריך להחליט במודע לרמות את עצמך — וזה בדיוק הרגע שבו סוחר מבין שהוא לא סוחר לפי תוכנית, הוא מהמר. Reflect לא נועד לכלוא אותך. הוא נועד להפוך את שבירת החוקים מהרגל אוטומטי להחלטה מודעת. ומקצוענים לא עוקפים את התהליך של עצמם.',
  },
  {
    q: 'במה זה שונה מיומן מסחר רגיל?',
    a: 'יומן רגיל מנתח את אתמול. Reflect נמצא איתך גם לפני הכניסה — בודק את העסקה מול החוקים שלך ברגע התכנון, כשעוד אפשר לעצור. אחרי העסקה תקבל את כל מה שיומן טוב נותן: תחקיר AI, ציון משמעת, סטטיסטיקות ודפוסים. ההבדל הוא החצי שאף יומן אחר לא מכסה.',
  },
  {
    q: 'עם אילו פלטפורמות ושווקים זה עובד?',
    a: "Reflect עובד לצד כל פלטפורמת מסחר, בלי תלות בברוקר — אתה מתכנן ומתעד ב-Reflect, ומבצע בפלטפורמה שלך. ההזנה כרגע ידנית ולוקחת פחות מדקה. מניות, פיוצ'רס, דיי-טריידינג או סווינג — אם יש לך חוקים, Reflect יודע לשמור עליהם. חיבורים ישירים לברוקרים? בתוכניות שלנו — ובגלל שהתכנון קורה לפני העסקה, Reflect שומר עליך כבר היום.",
  },
  {
    q: 'האם יש אפליקציה לטלפון?',
    a: 'Reflect עובדת מצוין בדפדפן הנייד, ואפשר להוסיף אותה למסך הבית ישירות מהדפדפן — כך היא נפתחת ומרגישה כמו אפליקציה לכל דבר.',
  },
  {
    q: 'כמה זמן לוקח להזין עסקה?',
    a: 'פחות מדקה. טופס התכנון בנוי למהירות — סימבול, כיוון, סטופ, יעד, והמערכת כבר בודקת הכל מולך תוך כדי הקלדה. אחרי העסקה, עדכון התוצאה לוקח שניות. זה פחות זמן ממה שלקח לך לקרוא את התשובה הזאת.',
  },
  {
    q: 'מה קורה אחרי 5 ימי הניסיון?',
    a: 'כלום דרמטי. לא ביקשנו כרטיס אשראי, אז אין חיוב אוטומטי ואין הפתעות. אם Reflect עשה לך שינוי — בוחרים מסלול וממשיכים. אם לא — נפרדים כידידים והנתונים שלך נשארים שלך.',
  },
  {
    q: 'הנתונים שלי פרטיים?',
    a: 'לחלוטין. העסקאות, הסטטיסטיקות והתחקירים שלך שייכים רק לך — אף אחד אחר לא רואה אותם, ואנחנו לא מוכרים או משתפים נתונים עם אף גורם. הנתונים משמשים אך ורק כדי לתת לך את הניתוחים שלך.',
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

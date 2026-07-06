import { ScrollReveal } from './ScrollReveal';

export function DistinctionSection() {
  return (
    <section className="relative py-20 px-4 md:px-6">
      <div className="max-w-[800px] mx-auto flex flex-col gap-6">
        <ScrollReveal>
          <h2 className="text-2xl md:text-4xl font-bold text-white text-center mb-4">
            יומן מסחר עובד. אבל רק בחצי מהזמן.
          </h2>
        </ScrollReveal>

        <ScrollReveal delay={80}>
          <p className="text-base text-tg-muted leading-relaxed">
            יומן טוב מראה לך אחרי: איפה טעית, מה עבד, אילו דפוסים חוזרים אצלך. זה שלב הכרחי — השוק
            בוחן את האסטרטגיה שלך. בלי תיעוד, אף אחד לא בוחן אותך.
          </p>
        </ScrollReveal>

        <ScrollReveal delay={160}>
          <p className="text-base text-tg-muted leading-relaxed">
            אבל יש רגע אחד שאף יומן בעולם לא מכסה: הרגע שלפני. האצבע על הכפתור, הלב דופק, וכל מה
            שראית אתמול בסטטיסטיקות נעלם. שם, ברגע שהכי קובע — היומן שלך עוד לא יודע כלום.
          </p>
        </ScrollReveal>

        <ScrollReveal delay={240}>
          <p className="text-base text-tg-muted leading-relaxed">
            Reflect בנוי על שני החצאים: יומן מלא שמנתח אותך לעומק אחרי כל עסקה — ומערכת שנמצאת
            איתך לפני, ברגע ההחלטה, ואומרת לך בפרצוף כשאתה עומד להפר את החוקים של עצמך.
          </p>
        </ScrollReveal>

        <ScrollReveal delay={320}>
          <p className="text-xl md:text-2xl font-bold text-white leading-relaxed mt-4 text-center">
            מראה אחורית + בלמים. זה ההבדל בין לדעת מה קרה — לבין למנוע את זה.
          </p>
        </ScrollReveal>
      </div>
    </section>
  );
}

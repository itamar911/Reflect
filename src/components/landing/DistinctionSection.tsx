import { History, Hand, Plus } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';

export function DistinctionSection() {
  return (
    <section className="relative py-24 px-4 md:px-6">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1100px] mx-auto relative">
        <SectionHeading>יומן מסחר עובד. אבל רק בחצי מהזמן.</SectionHeading>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-14 items-center">
          {/* copy — first child = right column in RTL */}
          <div className="flex flex-col gap-6">
            <ScrollReveal delay={80}>
              <p className="text-base text-tg-muted leading-relaxed">
                יומן טוב מראה לך אחרי: איפה טעית, מה עבד, אילו דפוסים חוזרים אצלך. זה שלב הכרחי —
                השוק בוחן את האסטרטגיה שלך. בלי תיעוד, אף אחד לא בוחן אותך.
              </p>
            </ScrollReveal>

            <ScrollReveal delay={160}>
              <p className="text-base text-tg-muted leading-relaxed">
                אבל יש רגע אחד שאף יומן בעולם לא מכסה: הרגע שלפני. האצבע על הכפתור, הלב דופק, וכל
                מה שראית אתמול בסטטיסטיקות נעלם. שם, ברגע שהכי קובע — היומן שלך עוד לא יודע כלום.
              </p>
            </ScrollReveal>

            <ScrollReveal delay={240}>
              <p className="text-base text-tg-muted leading-relaxed">
                Reflect בנוי על שני החצאים: יומן מלא שמנתח אותך לעומק אחרי כל עסקה — ומערכת
                שנמצאת איתך לפני, ברגע ההחלטה, ואומרת לך בפרצוף כשאתה עומד להפר את החוקים של
                עצמך.
              </p>
            </ScrollReveal>
          </div>

          {/* split-panel illustration: "אחרי" (rear-view) vs "לפני" (brakes) */}
          <ScrollReveal delay={200}>
            <div className="relative flex items-stretch gap-4" aria-hidden>
              {/* אחרי — muted rear-view mirror */}
              <div
                className="flex-1 rounded-2xl border p-6 flex flex-col items-center justify-center gap-4 min-h-[240px]"
                style={{
                  borderColor: 'rgba(148,163,184,0.25)',
                  background: 'rgba(148,163,184,0.05)',
                }}
              >
                <History size={40} style={{ color: '#94a3b8' }} />
                <span className="text-lg font-bold" style={{ color: '#94a3b8' }}>
                  אחרי
                </span>
                {/* muted mini bar chart — the look-back */}
                <div className="flex items-end gap-1.5 h-12">
                  {[0.5, 0.85, 0.35, 0.7, 0.45, 0.9].map((h, i) => (
                    <span
                      key={i}
                      className="w-2 rounded-sm"
                      style={{ height: `${h * 100}%`, background: 'rgba(148,163,184,0.4)' }}
                    />
                  ))}
                </div>
              </div>

              {/* plus connector */}
              <div className="self-center shrink-0">
                <span
                  className="flex items-center justify-center w-9 h-9 rounded-full"
                  style={{ background: 'rgba(0,210,210,0.12)', border: '1px solid rgba(0,210,210,0.35)' }}
                >
                  <Plus size={18} style={{ color: '#00d2d2' }} />
                </span>
              </div>

              {/* לפני — glowing stop hand */}
              <div
                className="flex-1 rounded-2xl border p-6 flex flex-col items-center justify-center gap-4 min-h-[240px]"
                style={{
                  borderColor: 'rgba(0,210,210,0.45)',
                  background: 'rgba(0,210,210,0.06)',
                  boxShadow: '0 0 32px rgba(0,210,210,0.12)',
                }}
              >
                <span className="relative flex items-center justify-center">
                  <span
                    className="absolute w-16 h-16 rounded-full"
                    style={{ border: '1px solid rgba(0,210,210,0.35)', boxShadow: '0 0 18px rgba(0,210,210,0.25)' }}
                  />
                  <Hand size={40} style={{ color: '#00d2d2' }} />
                </span>
                <span className="text-lg font-bold" style={{ color: '#00d2d2' }}>
                  לפני
                </span>
                {/* the moment of decision — a held pulse line */}
                <div className="flex items-center gap-1.5 h-12">
                  <span className="w-10 h-0.5 rounded-full" style={{ background: 'rgba(0,210,210,0.55)' }} />
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#00d2d2', boxShadow: '0 0 10px #00d2d2' }} />
                  <span className="w-10 h-0.5 rounded-full" style={{ background: 'rgba(0,210,210,0.2)' }} />
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>

        <ScrollReveal delay={320}>
          <div className="callout-strip max-w-3xl mx-auto mt-14 px-6 py-5">
            <p className="text-xl md:text-2xl font-bold text-white leading-relaxed text-center">
              מראה אחורית + בלמים. זה ההבדל בין לדעת מה קרה — לבין למנוע את זה.
            </p>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

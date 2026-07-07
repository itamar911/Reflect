import { Plus, ShieldCheck, Check, AlertTriangle } from 'lucide-react';
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

          {/* split-panel illustration: "אחרי" (the journal's mirror) vs "לפני" (Reflect's edge) */}
          <ScrollReveal delay={200}>
            <div className="relative flex items-stretch gap-4" aria-hidden>
              {/* אחרי — muted stats look-back mock */}
              <div
                className="mini-mock-hover flex-1 rounded-2xl border p-5 flex flex-col gap-4 min-h-[240px]"
                style={{
                  borderColor: 'rgba(148,163,184,0.25)',
                  background: 'rgba(148,163,184,0.05)',
                }}
              >
                <span className="text-sm font-bold" style={{ color: '#94a3b8' }}>
                  אחרי
                </span>
                <div className="flex items-end gap-1.5 h-14">
                  {[0.5, 0.85, 0.35, 0.7, 0.45, 0.9].map((h, i) => (
                    <span
                      key={i}
                      className="w-2.5 rounded-sm"
                      style={{ height: `${h * 100}%`, background: 'rgba(148,163,184,0.4)' }}
                    />
                  ))}
                </div>
                <div>
                  <p className="text-xl font-extrabold" style={{ color: '#ef4444' }}>
                    -1,240 ₪
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: '#94a3b8' }}>
                    מה קרה אתמול
                  </p>
                </div>
              </div>

              {/* plus connector — glowing turquoise node */}
              <div className="self-center shrink-0 z-10">
                <span className="plus-node-glow flex items-center justify-center w-9 h-9 rounded-full">
                  <Plus size={18} style={{ color: '#00d2d2' }} />
                </span>
              </div>

              {/* לפני — Reflect's blocking moment, alive with turquoise glow */}
              <div
                className="mini-mock-hover flex-1 rounded-2xl border p-5 flex flex-col gap-3.5 min-h-[240px]"
                style={{
                  borderColor: 'rgba(0,210,210,0.45)',
                  background: 'rgba(0,210,210,0.06)',
                  boxShadow: '0 0 32px rgba(0,210,210,0.12)',
                }}
              >
                <div className="flex items-center gap-2">
                  <ShieldCheck size={18} style={{ color: '#00d2d2' }} />
                  <span className="text-sm font-bold" style={{ color: '#00d2d2' }}>
                    לפני
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Check size={15} className="shrink-0" style={{ color: '#22c55e' }} />
                  <span className="text-white/85" style={{ fontSize: 13 }}>
                    סטופ מוגדר · יחס 1:2.5
                  </span>
                </div>
                <div
                  className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 -mx-1"
                  style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)' }}
                >
                  <AlertTriangle size={15} className="shrink-0" style={{ color: '#f59e0b' }} />
                  <span style={{ fontSize: 13, color: '#f59e0b' }}>עסקה שלישית היום — חוק שלך מופר</span>
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

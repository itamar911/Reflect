import { Plus, ShieldCheck, Check, AlertTriangle, Clock, Unlink, type LucideIcon } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';

const PROOF_CHIPS: { icon: LucideIcon; text: string; color: string }[] = [
  { icon: Clock, text: 'אחרי — יומן קלאסי: מנתח את אתמול', color: '#94a3b8' },
  { icon: ShieldCheck, text: 'לפני — Reflect: בודק אותך עכשיו', color: '#00d2d2' },
  { icon: Unlink, text: 'יחד — הלופ נשבר', color: '#67e8f9' },
];

const SPARK_POINTS = '0,20 12,14 24,22 36,10 48,16 60,6 72,12 84,4';

export function DistinctionSection() {
  return (
    <section className="relative py-24 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        <SectionHeading>יומן מסחר עובד. אבל רק בחצי מהזמן.</SectionHeading>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center">
          {/* copy — first child = right column in RTL */}
          <div className="flex flex-col gap-6">
            <ScrollReveal delay={80}>
              <p className="text-tg-muted" style={{ fontSize: 17, lineHeight: 1.7 }}>
                יומן טוב מראה לך אחרי: איפה טעית, מה עבד, אילו דפוסים חוזרים אצלך. זה שלב הכרחי —
                השוק בוחן את האסטרטגיה שלך. בלי תיעוד, אף אחד לא בוחן אותך.
              </p>
            </ScrollReveal>

            <ScrollReveal delay={160}>
              <p className="text-tg-muted" style={{ fontSize: 17, lineHeight: 1.7 }}>
                אבל יש רגע אחד שאף יומן בעולם לא מכסה: הרגע שלפני. האצבע על הכפתור, הלב דופק, וכל
                מה שראית אתמול בסטטיסטיקות נעלם. שם, ברגע שהכי קובע — היומן שלך עוד לא יודע כלום.
              </p>
            </ScrollReveal>

            <ScrollReveal delay={240}>
              <p className="text-tg-muted" style={{ fontSize: 17, lineHeight: 1.7 }}>
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
                className="mini-mock-hover flex-1 rounded-2xl border p-5 lg:p-6 flex flex-col gap-3.5 min-h-[280px]"
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
                  <p className="text-sm mt-0.5" style={{ color: '#94a3b8' }}>
                    מה קרה אתמול
                  </p>
                </div>
                <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(148,163,184,0.08)' }}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm" style={{ color: '#94a3b8' }}>
                      סיכום שבועי
                    </span>
                    <span className="text-sm font-semibold" style={{ color: '#94a3b8' }}>
                      3 ימים אדומים מתוך 5
                    </span>
                  </div>
                  <svg viewBox="0 0 84 24" className="w-full h-6" preserveAspectRatio="none" aria-hidden>
                    <polyline
                      points={SPARK_POINTS}
                      fill="none"
                      stroke="rgba(148,163,184,0.55)"
                      strokeWidth={1.75}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
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
                className="mini-mock-hover flex-1 rounded-2xl border p-5 lg:p-6 flex flex-col gap-3 min-h-[280px]"
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
                  <span className="text-white/85" style={{ fontSize: 14 }}>
                    סטופ מוגדר · יחס 1:2.5
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-lg px-2.5 py-1.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                  <span className="text-white/60" style={{ fontSize: 14 }}>
                    סטופ
                  </span>
                  <span className="text-white/85 font-semibold" style={{ fontSize: 14 }}>
                    29,340
                  </span>
                </div>
                <div
                  className="mock-warn-pulse flex items-center gap-2 rounded-lg px-2.5 py-1.5 -mx-1"
                  style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)' }}
                >
                  <AlertTriangle size={15} className="shrink-0" style={{ color: '#f59e0b' }} />
                  <span style={{ fontSize: 14, color: '#f59e0b' }}>עסקה שלישית היום — חוק שלך מופר</span>
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>

        <div className="distinction-connector mx-auto" aria-hidden />

        <ScrollReveal delay={260}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
            {PROOF_CHIPS.map((chip) => {
              const Icon = chip.icon;
              return (
                <div
                  key={chip.text}
                  className="proof-chip flex items-center gap-3 rounded-2xl border p-4"
                  style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)' }}
                >
                  <span
                    className="flex items-center justify-center w-9 h-9 rounded-xl shrink-0"
                    style={{ background: `${chip.color}1f`, border: `1px solid ${chip.color}55` }}
                  >
                    <Icon size={18} style={{ color: chip.color }} />
                  </span>
                  <span className="text-[15px] font-semibold text-white/85 leading-snug">{chip.text}</span>
                </div>
              );
            })}
          </div>
        </ScrollReveal>

        <ScrollReveal delay={320}>
          <div className="callout-strip max-w-3xl mx-auto px-6 py-5">
            <p className="text-xl md:text-2xl font-bold text-white leading-relaxed text-center">
              מראה אחורית + בלמים. זה ההבדל בין לדעת מה קרה — לבין למנוע את זה.
            </p>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

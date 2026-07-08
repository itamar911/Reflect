import { ShieldCheck, ClipboardList, Gauge, Sparkles, CalendarDays, Bot, type LucideIcon } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';
import { LightboxImage } from './LightboxImage';
import { landingImages } from './landingImages';

const FEATURES: { icon: LucideIcon; title: string; body: string; imageIndex: number }[] = [
  {
    icon: ShieldCheck,
    title: 'חוקים שעובדים בזמן אמת',
    body: 'בנה חוקים אישיים ("אחרי 2 הפסדים — סיימת להיום") והם ייאכפו בזמן התכנון. לא תזכורת בנייד. עצירה אמיתית.',
    imageIndex: 0,
  },
  {
    icon: ClipboardList,
    title: 'תכנון עסקה חכם',
    body: 'כניסה, סטופ, יעד, R:R, התאמה לאסטרטגיה — הכל נבדק מולך תוך כדי הקלדה.',
    imageIndex: 1,
  },
  {
    icon: Gauge,
    title: 'ציון משמעת',
    body: 'רדאר שמודד אותך על מה שבשליטתך: נאמנות לתוכנית, שמירה על סטופ, סבלנות, שליטה רגשית.',
    imageIndex: 2,
  },
  {
    icon: Sparkles,
    title: 'תחקיר AI אחרי כל עסקה',
    body: 'לא "מה הרווחת" אלא "איך התנהגת". ניתוח אישי שמזהה FOMO, עסקאות נקמה ויציאות מוקדמות — ונותן ציון שמחושב, לא מומצא.',
    imageIndex: 3,
  },
  {
    icon: CalendarDays,
    title: 'יומן חודשי חכם',
    body: 'כל חודש המסחר שלך במבט אחד: ימים ירוקים, ימים אדומים, ונקודות ההפרה שמספרות את הסיפור האמיתי.',
    imageIndex: 4,
  },
  {
    icon: Bot,
    title: 'מאמן AI אישי',
    body: 'שאל כל שאלה על המסחר שלך וקבל תשובות שמבוססות על הנתונים שלך, לא על עצות גנריות.',
    imageIndex: 5,
  },
];

export function FeaturesSection() {
  return (
    <section id="features" className="cv-auto relative py-24 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        <SectionHeading sub="כל כלי כאן קיים כדי לענות על שאלה אחת — האם אתה סוחר לפי התוכנית שלך?">
          מה מחכה לך בפנים
        </SectionHeading>

        {/* uniform 2×3 grid — every card identical: screenshot on top, icon + title + full description below */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-24">
          {FEATURES.map((feature, i) => {
            const Icon = feature.icon;
            const screenshot = landingImages.features[feature.imageIndex];
            return (
              <ScrollReveal key={feature.title} delay={(i % 2) * 120} className="h-full">
                <div className="glass-card card-hover h-full min-h-[420px] rounded-2xl p-6 flex flex-col gap-5">
                  <LightboxImage
                    id={screenshot.id}
                    label={screenshot.label}
                    src={screenshot.src}
                    objectPosition={screenshot.objectPosition}
                    aspect="aspect-[16/10]"
                  />
                  <div className="flex items-center gap-3.5">
                    <div
                      className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
                      style={{ background: 'rgba(0,210,210,0.12)', border: '1px solid rgba(0,210,210,0.2)' }}
                    >
                      <Icon size={24} style={{ color: '#00d2d2' }} />
                    </div>
                    <h3 className="font-bold text-white" style={{ fontSize: 21 }}>{feature.title}</h3>
                  </div>
                  <p className="text-tg-muted" style={{ fontSize: 16.5, lineHeight: 1.7 }}>{feature.body}</p>
                </div>
              </ScrollReveal>
            );
          })}
        </div>

        {/* ── הצצה למערכת — two large framed screenshots ── */}
        <div>
          <div className="flex flex-col items-center text-center mb-10">
            <ScrollReveal>
              <h3 className="text-2xl md:text-3xl font-extrabold text-white leading-tight">הצצה למערכת</h3>
            </ScrollReveal>
            <ScrollReveal delay={100}>
              <span className="section-underline mt-4" style={{ width: 52 }} aria-hidden />
            </ScrollReveal>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-6xl mx-auto">
            {landingImages.gallery.map((item, i) => (
              <ScrollReveal key={item.id} delay={i * 110}>
                <figure className="flex flex-col gap-4">
                  <div
                    className="rounded-2xl p-2"
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(0,210,210,0.2)',
                      boxShadow: '0 18px 44px rgba(0,0,0,0.4), 0 0 30px rgba(0,210,210,0.08)',
                    }}
                  >
                    <LightboxImage id={item.id} label={item.label} src={item.src} aspect="aspect-[16/10]" />
                  </div>
                  <figcaption className="text-tg-text-2 text-center font-medium" style={{ fontSize: 16 }}>
                    {item.label}
                  </figcaption>
                </figure>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

import { ShieldCheck, ClipboardList, Gauge, Sparkles, CalendarDays, Bot, type LucideIcon } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';
import { LightboxImage } from './LightboxImage';
import { landingImages } from './landingImages';

const FEATURES: { icon: LucideIcon; title: string; body: string; imageIndex: number; large?: boolean }[] = [
  {
    icon: ShieldCheck,
    title: 'חוקים שעובדים בזמן אמת',
    body: 'בנה חוקים אישיים ("אחרי 2 הפסדים — סיימת להיום") והם ייאכפו בזמן התכנון. לא תזכורת בנייד. עצירה אמיתית.',
    imageIndex: 0,
    large: true,
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
    large: true,
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

        <div className="grid grid-cols-1 lg:grid-cols-3 lg:[grid-auto-flow:dense] gap-6 mb-16">
          {FEATURES.map((feature, i) => {
            const Icon = feature.icon;
            const placeholder = landingImages.features[feature.imageIndex];
            return (
              <ScrollReveal
                key={feature.title}
                delay={(i % 3) * 120}
                className={feature.large ? 'lg:col-span-2' : 'lg:col-span-1'}
              >
                <div className="glass-card card-hover h-full rounded-2xl p-6 flex flex-col gap-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                      style={{ background: 'rgba(0,210,210,0.12)', border: '1px solid rgba(0,210,210,0.2)' }}
                    >
                      <Icon size={22} style={{ color: '#00d2d2' }} />
                    </div>
                    <h3 className="text-lg font-bold text-white">{feature.title}</h3>
                  </div>
                  <p className="text-sm text-tg-muted leading-relaxed">{feature.body}</p>
                  <LightboxImage
                    id={placeholder.id}
                    label={placeholder.label}
                    src={placeholder.src}
                    objectPosition={placeholder.objectPosition}
                    aspect="aspect-[16/10]"
                    topFade
                    className="mt-auto"
                  />
                </div>
              </ScrollReveal>
            );
          })}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 max-w-3xl mx-auto">
          {landingImages.gallery.map((item, i) => (
            <ScrollReveal key={item.id} delay={i * 110}>
              <div className="flex flex-col gap-2.5">
                <LightboxImage id={item.id} label={item.label} src={item.src} aspect="aspect-[4/3]" />
                <span className="text-xs text-tg-muted text-center">{item.label}</span>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}

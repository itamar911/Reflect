import { ShieldCheck, ClipboardList, Gauge, Sparkles, CalendarDays, Bot, type LucideIcon } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { ImagePlaceholder } from './ImagePlaceholder';
import { landingImages } from './landingImages';

const FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: ShieldCheck,
    title: 'חוקים שעובדים בזמן אמת',
    body: 'בנה חוקים אישיים ("אחרי 2 הפסדים — סיימת להיום") והם ייאכפו בזמן התכנון. לא תזכורת בנייד. עצירה אמיתית.',
  },
  {
    icon: ClipboardList,
    title: 'תכנון עסקה חכם',
    body: 'כניסה, סטופ, יעד, R:R, התאמה לאסטרטגיה — הכל נבדק מולך תוך כדי הקלדה. עסקה בלי תוכנית פשוט לא נכנסת.',
  },
  {
    icon: Gauge,
    title: 'ציון משמעת',
    body: 'רדאר שמודד אותך על מה שבשליטתך: נאמנות לתוכנית, שמירה על סטופ, סבלנות, שליטה רגשית. הציון שמנבא את העתיד שלך יותר מכל P&L.',
  },
  {
    icon: Sparkles,
    title: 'תחקיר AI אחרי כל עסקה',
    body: 'לא "מה הרווחת" אלא "איך התנהגת". ניתוח אישי שמזהה FOMO, עסקאות נקמה ויציאות מוקדמות — ונותן ציון שמחושב, לא מומצא.',
  },
  {
    icon: CalendarDays,
    title: 'יומן חודשי חכם',
    body: 'כל חודש המסחר שלך במבט אחד: ימים ירוקים, ימים אדומים, ונקודות ההפרה שמספרות את הסיפור האמיתי.',
  },
  {
    icon: Bot,
    title: 'מאמן AI אישי',
    body: 'שאל כל שאלה על המסחר שלך וקבל תשובות שמבוססות על הנתונים שלך, לא על עצות גנריות.',
  },
];

export function FeaturesSection() {
  return (
    <section id="features" className="relative py-20 px-4 md:px-6">
      <div className="max-w-[1100px] mx-auto">
        <ScrollReveal>
          <h2 className="text-2xl md:text-4xl font-bold text-white text-center mb-3">מה מחכה לך בפנים</h2>
        </ScrollReveal>
        <ScrollReveal delay={60}>
          <p className="text-base text-tg-muted text-center max-w-xl mx-auto mb-14">
            כל כלי כאן קיים כדי לענות על שאלה אחת — האם אתה סוחר לפי התוכנית שלך?
          </p>
        </ScrollReveal>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
          {FEATURES.map((feature, i) => {
            const Icon = feature.icon;
            const placeholder = landingImages.features[i];
            return (
              <ScrollReveal key={feature.title} delay={(i % 3) * 100}>
                <div
                  className="h-full rounded-2xl border border-tg-border p-6 flex flex-col gap-4"
                  style={{ background: 'var(--color-tg-surface)' }}
                >
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: 'rgba(0,210,210,0.12)' }}
                  >
                    <Icon size={22} style={{ color: '#00d2d2' }} />
                  </div>
                  <h3 className="text-lg font-bold text-white">{feature.title}</h3>
                  <p className="text-sm text-tg-muted leading-relaxed">{feature.body}</p>
                  <ImagePlaceholder id={placeholder.id} label={placeholder.label} aspect="aspect-[4/3]" className="mt-1" />
                </div>
              </ScrollReveal>
            );
          })}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {landingImages.gallery.map((item, i) => (
            <ScrollReveal key={item.id} delay={i * 90}>
              <div className="flex flex-col gap-2">
                <ImagePlaceholder id={item.id} label={item.label} aspect="aspect-[4/3]" />
                <span className="text-xs text-tg-muted text-center">{item.label}</span>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}

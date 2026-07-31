import { ShieldCheck, ClipboardList, Gauge, Sparkles, CalendarDays, Bot, type LucideIcon } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';
import { RulesMock } from './feature-mocks/RulesMock';
import { PlanCheckMock } from './feature-mocks/PlanCheckMock';
import { DisciplineScoreMock } from './feature-mocks/DisciplineScoreMock';
import { DebriefMock } from './feature-mocks/DebriefMock';
import { CalendarMock } from './feature-mocks/CalendarMock';
import { CoachMock } from './feature-mocks/CoachMock';

const FEATURES: { icon: LucideIcon; title: string; body: string; Mock: React.ComponentType }[] = [
  {
    icon: ShieldCheck,
    title: 'חוקים שעובדים בזמן אמת',
    body: 'בנה חוקים אישיים ("אחרי 2 הפסדים — סיימת להיום") והם ייאכפו בזמן התכנון. לא תזכורת בנייד. עצירה אמיתית.',
    Mock: RulesMock,
  },
  {
    icon: ClipboardList,
    title: 'תכנון עסקה חכם',
    body: 'כניסה, סטופ, יעד, R:R, התאמה לאסטרטגיה — הכל נבדק מולך תוך כדי הקלדה.',
    Mock: PlanCheckMock,
  },
  {
    icon: Gauge,
    title: 'ציון משמעת',
    body: 'רדאר שמודד אותך על מה שבשליטתך: נאמנות לתוכנית, שמירה על סטופ, סבלנות, שליטה רגשית.',
    Mock: DisciplineScoreMock,
  },
  {
    icon: Sparkles,
    title: 'תחקיר AI אחרי כל עסקה',
    body: 'לא "מה הרווחת" אלא "איך התנהגת". ניתוח אישי שמזהה FOMO, עסקאות נקמה ויציאות מוקדמות — ונותן ציון שמחושב, לא מומצא.',
    Mock: DebriefMock,
  },
  {
    icon: CalendarDays,
    title: 'יומן חודשי חכם',
    body: 'כל חודש המסחר שלך במבט אחד: ימים ירוקים, ימים אדומים, ונקודות ההפרה שמספרות את הסיפור האמיתי.',
    Mock: CalendarMock,
  },
  {
    icon: Bot,
    title: 'מאמן AI אישי',
    body: 'שאל כל שאלה על המסחר שלך וקבל תשובות שמבוססות על הנתונים שלך, לא על עצות גנריות.',
    Mock: CoachMock,
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

        {/* uniform 2×3 grid — every card identical: live mini-mock on top, icon + title + full description below */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {FEATURES.map((feature, i) => {
            const Icon = feature.icon;
            const Mock = feature.Mock;
            return (
              <ScrollReveal key={feature.title} delay={(i % 2) * 120} className="h-full">
                <div className="glass-card card-hover h-full min-h-[420px] rounded-2xl p-6 flex flex-col gap-5">
                  <Mock />
                  <div className="flex items-center gap-3.5">
                    <div
                      className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
                      style={{ background: 'rgba(0,210,210,0.12)', border: '1px solid rgba(0,210,210,0.2)' }}
                    >
                      <Icon size={24} style={{ color: '#00d2d2' }} />
                    </div>
                    <h3 className="font-bold text-white" style={{ fontSize: 21 }}>{feature.title}</h3>
                  </div>
                  <p className="text-tg-muted" style={{ fontSize: 17.5, lineHeight: 1.7 }}>{feature.body}</p>
                </div>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

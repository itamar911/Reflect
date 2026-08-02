import { Phone } from 'lucide-react';
import { FaWhatsapp } from 'react-icons/fa';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';

const PHONE_E164 = '+972502255903';
const PHONE_DISPLAY = '050-225-5903';
const WHATSAPP_DIGITS = '972502255903';

export function ContactSection() {
  return (
    <section
      id="contact"
      className="relative py-24 px-4 md:px-8 lg:px-10 scroll-mt-[calc(var(--landing-nav-h,76px)+24px)]"
    >
      <div className="section-glow" aria-hidden />
      <div className="max-w-[720px] mx-auto relative">
        <SectionHeading sub="יש שאלה לפני שמתחילים? אנחנו כאן — בטלפון או בוואטסאפ.">
          צור קשר
        </SectionHeading>

        <ScrollReveal delay={160}>
          <div className="glass-card rounded-2xl p-8 pb-6 flex flex-col items-center gap-8 text-center">
            <a
              href={`tel:${PHONE_E164}`}
              className="inline-flex items-center gap-3 text-xl font-bold text-white hover:text-tg-primary transition-colors"
            >
              <Phone size={22} className="text-tg-primary" aria-hidden />
              <span dir="ltr">{PHONE_DISPLAY}</span>
            </a>

            <a
              href={`https://wa.me/${WHATSAPP_DIGITS}`}
              target="_blank"
              rel="noopener noreferrer"
              className="landing-cta cta-shine inline-flex items-center gap-2.5 px-7 py-3.5 rounded-xl text-base font-bold text-black"
            >
              <FaWhatsapp size={20} className="text-white" aria-hidden />
              שלחו הודעה בוואטסאפ
            </a>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

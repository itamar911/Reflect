import { ScrollReveal } from './ScrollReveal';

interface SectionHeadingProps {
  children: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}

export function SectionHeading({ children, sub, className = '' }: SectionHeadingProps) {
  return (
    <div className={`flex flex-col items-center text-center mb-14 ${className}`}>
      <ScrollReveal>
        <h2 className="text-3xl md:text-4xl font-extrabold text-white leading-tight">{children}</h2>
      </ScrollReveal>
      <ScrollReveal delay={100}>
        <span className="section-underline mt-5" aria-hidden />
      </ScrollReveal>
      {sub && (
        <ScrollReveal delay={160}>
          <p className="text-base text-tg-muted max-w-xl mx-auto mt-5 leading-relaxed">{sub}</p>
        </ScrollReveal>
      )}
    </div>
  );
}

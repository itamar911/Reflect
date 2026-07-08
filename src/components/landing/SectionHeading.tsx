import { ScrollReveal } from './ScrollReveal';

interface SectionHeadingProps {
  children: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
  /** Tighter bottom margin for sections that must fit a viewport. */
  compact?: boolean;
}

export function SectionHeading({ children, sub, className = '', compact = false }: SectionHeadingProps) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? 'mb-8' : 'mb-14'} ${className}`}>
      <ScrollReveal>
        <h2 className="text-4xl md:text-[42px] font-extrabold text-white leading-tight">{children}</h2>
      </ScrollReveal>
      <ScrollReveal delay={100}>
        <span className={`section-underline ${compact ? 'mt-4' : 'mt-5'}`} aria-hidden />
      </ScrollReveal>
      {sub && (
        <ScrollReveal delay={160}>
          <p className="text-lg text-tg-muted max-w-2xl mx-auto mt-5 leading-relaxed">{sub}</p>
        </ScrollReveal>
      )}
    </div>
  );
}
